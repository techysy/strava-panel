#!/usr/bin/env node
/**
 * Strava Panel — fnOS 后端服务 (零 npm 依赖, Node >= 22.13: node:sqlite + 原生 fetch)
 * 凭据管理 + Token 自动刷新 + SQLite 本地缓存 + 骑行数据 API —— 由 app.py 逐项移植。
 *
 * 数据目录结构 (SP_DATA_DIR / 兼容 DATA_DIR):
 *   strava.conf           # client_id / client_secret / refresh_token / api_token
 *   strava_tokens.json    # 缓存的 access_token (自动刷新)
 *   strava.db             # SQLite 缓存 (activities 表, schema 与 db.py 一致)
 *   system.log / strava-api.log / agent.log   # 三个日志源, 按日期归档到 logs/
 *
 * API (除 bootstrap/status 外均需 Authorization: Bearer <api_token>):
 *   GET  /api/bootstrap     # 免认证: 返回 api_token
 *   GET  /api/status        # 免认证: 凭据/授权/缓存状态
 *   GET  /api/info          # 服务状态 (版本/端口/数据统计/api_token)
 *   GET  /api/config        # 读取非敏感配置
 *   POST /api/config        # 保存凭据 (JSON)
 *   GET  /api/stats         # 骑行统计 (读 SQLite 缓存，快)
 *   GET  /api/weekly        # 每周聚合
 *   GET  /api/activities    # 最近活动列表 (读缓存)
 *   GET  /api/sync          # 手动触发 Strava→SQLite 同步
 *   POST /api/sync          # 同上 (POST)
 *   GET  /api/sync/progress # 同步进度 (前端轮询)
 *   GET  /api/export?fmt=json|csv   # 导出全量数据 (给 agent)
 *   GET  /api/token/view    # 查看当前 api_token
 *   POST /api/token/recreate # 重新生成 api_token
 *   GET  /api/doc?lang=zh|en # API 使用指南 (Markdown)
 *   GET  /api/logs/list     # 日志来源/可查看日期
 *   GET  /api/logs          # 读取日志 (source/date/tail)
 *   GET  /api/logs/download # 下载日志
 *   GET  /api/oauth/start   # 发起 Strava OAuth 授权
 *   GET  /oauth/callback    # Strava 授权回调 (免认证)
 *   GET  /                  # 前端面板
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StravaDB, PyFloat, pyRound, pyDump, pyStr, pyf } from './db.js';
import { tripWeather, tripTrains, tripGeocode, tripRouteWeather, TRIP_DESTINATIONS } from './trip.js';

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API = 'https://www.strava.com/api/v3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 环境变量优先级:SP_PORT/SP_DATA_DIR/SP_HOST(全平台专用名)> PORT/DATA_DIR(fnOS cmd/main 兼容)> 默认值。
// SP_* 前缀避免与系统里常见的通用变量(PORT 等)冲突,桌面壳/CLI/Docker 统一注入 SP_*。
// 默认绑定 127.0.0.1:纯本机访问(桌面/CLI)免 Windows 防火墙弹窗;fnOS cmd/main 与
// Dockerfile 显式传 SP_HOST=0.0.0.0 供局域网访问。面板展示统一走 localhost(回调域名匹配)。
const PORT = process.env.SP_PORT || process.env.PORT || '20227';
const BIND_HOST = process.env.SP_HOST || '127.0.0.1';
const DATA_DIR = process.env.SP_DATA_DIR || process.env.DATA_DIR || '/tmp/strava-data';
const CONF_FILE = path.join(DATA_DIR, 'strava.conf');
const TOKEN_FILE = path.join(DATA_DIR, 'strava_tokens.json');
const DB_FILE = path.join(DATA_DIR, 'strava.db');
const WWW_DIR = path.join(__dirname, '..', 'www');

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const nowStamp = () => {
  const d = new Date();
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const localIsoSeconds = () => {
  const d = new Date();
  return `${fmtDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const tokenUrlsafe = (bytes) => randomBytes(bytes).toString('base64url');
const chmod600 = (p) => { try { fs.chmodSync(p, 0o600); } catch { /* Windows 上 chmod 尽力而为 */ } };

// ---------- sync / token 串行化 ----------
// app.py 用 threading.Lock 串行 /api/sync 与 /api/config 的写入,RLock 串行 token 读写。
// Node 单线程, 只需把"读 config → 请求 Strava → 写 config/token"的异步过程排队,
// 防止轮询 refresh 与 exchange 授权写互相踩。
let _syncQueue = Promise.resolve();
const syncSerial = (fn) => {
  const run = _syncQueue.then(fn, fn);
  _syncQueue = run.then(() => {}, () => {});
  return run;
};
let _tokenQueue = Promise.resolve();
const tokenSerial = (fn) => {
  const run = _tokenQueue.then(fn, fn);
  _tokenQueue = run.then(() => {}, () => {});
  return run;
};

const db = new StravaDB(DB_FILE);

// 动态读取应用版本（单一来源 VERSION 文件，fallback 到已安装 manifest）.
function readAppVersion() {
  // 1) 优先：打包的 VERSION 文件（单一来源，改这一处即可）
  try {
    const vfile = path.join(__dirname, 'VERSION');
    const v = fs.readFileSync(vfile, 'utf8').trim();
    if (v) return v;
  } catch { /* 继续 fallback */ }
  // 2) fallback：已安装 manifest
  for (const p of ['/var/apps/strava/manifest', '/vol4/@appcenter/strava/manifest']) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const l = line.trim();
        if (l.startsWith('version') && l.includes('=')) return l.split('=', 2)[1].trim();
      }
    } catch { /* 下一个 */ }
  }
  return '';
}

const APP_VERSION = readAppVersion();

// 展示用版本串：v2.5.2 (7d62d06) —— 帮助区分同一版本多次打包的产物。
// build.json 缺失（开发树常见）或 dirty 时回退纯版本号；VERSION/tag/文件名/更新比较链路不受影响。
function displayVersion() {
  const b = buildInfo();
  if (!b || !b.commit || b.dirty) return APP_VERSION || '';
  return `${APP_VERSION} (${b.commit})`;
}

// 打包生成的构建信息 (scripts/gen-build-info.py 写入仓库根目录 build.json)
const BUILD_FILE = path.join(__dirname, '..', 'build.json');
let _buildInfoCache;                     // undefined = 未读
function buildInfo() {
  /** 惰性读取打包时的 build.json (commit/branch/channel 等), 结果缓存。
   * 开发树上 build.json 通常可能不存在/非法 → 返回 null, /api/status 的 "build" 为 null。 */
  if (_buildInfoCache !== undefined) return _buildInfoCache;
  let info = null;
  try {
    const data = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) info = data;
  } catch { info = null; }
  _buildInfoCache = info;
  return info;
}

// ---------- 配置 ----------
function loadConfig() {
  const cfg = {};
  if (!fs.existsSync(CONF_FILE)) return cfg;
  for (const line of fs.readFileSync(CONF_FILE, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    const idx = l.indexOf('=');
    cfg[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lines = [
    `client_id=${cfg.client_id || ''}`,
    `client_secret=${cfg.client_secret || ''}`,
    `refresh_token=${cfg.refresh_token || ''}`,
    `athlete_id=${cfg.athlete_id || ''}`,
    `api_token=${cfg.api_token || ''}`,
    `oauth_state=${cfg.oauth_state || ''}`,
    `redirect_uri=${cfg.redirect_uri || ''}`,
    `llm_base_url=${cfg.llm_base_url || ''}`,
    `llm_api_key=${cfg.llm_api_key || ''}`,
    `llm_model=${cfg.llm_model || ''}`,
    `llm_models=${cfg.llm_models || '[]'}`,
    `auto_sync=${String(cfg.auto_sync || '0') === '1' ? '1' : '0'}`,
    `auto_sync_hours=${String(cfg.auto_sync_hours || '24')}`,
    `intervals_athlete_id=${cfg.intervals_athlete_id || ''}`,
    `intervals_api_key=${cfg.intervals_api_key || ''}`,
    `coach_sports=${cfg.coach_sports || 'Ride'}`,
    `coach_times=${cfg.coach_times || ''}`,
    `coach_home_city=${cfg.coach_home_city || ''}`,
  ];
  fs.writeFileSync(CONF_FILE, lines.join('\n') + '\n', 'utf8');
  chmod600(CONF_FILE); // 权限 600，仅属主可读
  // 仅当 refresh_token 实际变更时才清掉缓存的 access_token（凭据变了旧 token 作废）。
  // 不能无条件删——exchange/refresh 是"先 save 后写新 token"，若无条件删会误删刚换来的 token。
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const curRt = String(cfg.refresh_token || '').trim();
      const cached = String(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refresh_token || '').trim();
      if (curRt && cached && curRt !== cached) fs.rmSync(TOKEN_FILE);
    }
  } catch { /* 忽略清理失败 */ }
}

function hasCredentials() {
  const cfg = loadConfig();
  return Boolean(cfg.client_id && cfg.client_secret && cfg.refresh_token);
}

// ---------- API Token 保护 ----------
function getOrCreateApiToken() {
  const cfg = loadConfig();
  let tok = String(cfg.api_token || '').trim();
  if (!tok) {
    tok = tokenUrlsafe(32);
    cfg.api_token = tok;
    saveConfig(cfg);
  }
  return tok;
}

function apiTokenValid(token) {
  if (!token) return false;
  const expected = loadConfig().api_token || '';
  return token === expected;
}

function recreateApiToken() {
  const cfg = loadConfig();
  cfg.api_token = tokenUrlsafe(32);
  saveConfig(cfg);
  return cfg.api_token;
}

// ---------- Strava OAuth 授权 ----------
const OAUTH_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const OAUTH_SCOPE = 'read,activity:read_all';
// 拉取骑行活动所需的最低 scope（缺它 /athlete/activities 会 401，面板同步必失败）
const REQUIRED_SCOPE = 'activity:read_all';

function scopeHasActivity(scope) {
  /** scope 是否含 activity:read_all。
   * Strava scope 可能逗号分隔('read,activity:read_all')或空格分隔('activity:read_all read')
   * (官方文档: comma- or URL-safe space-delimited)。两种都要处理，避免误判缺权限。 */
  if (!scope) return false;
  return String(scope).replace(/,/g, ' ').split(/\s+/).filter(Boolean).includes(REQUIRED_SCOPE);
}

function isPrivateHost(host) {
  /** 判断 host(含端口) 是否为内网/本机地址。公网中转域名(如 office.app.5ddd.com)不算，
   * 不能用来推导 OAuth 回调(Strava 回调需落在可注册的真实地址)。 */
  const h = String(host || '').split(':')[0].trim().toLowerCase();
  if (!h || h === 'localhost' || h.startsWith('127.')) return true;
  const parts = h.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = Number(parts[0]); const b = Number(parts[1]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false; // 域名(含中转/公网)一律不自动推导
}

function getRedirectUri(requestHost = null) {
  /** 回调地址：优先用配置的；否则仅当请求来自内网/本机时才按 Host 推导，
   * 公网中转域名(office.app.5ddd.com 等)绝不推导成回调(会拉错/无法在 Strava 注册)。
   * request_host 形如 'localhost:20227'(来自 HTTP Host 头)，未带 scheme。 */
  const cfg = loadConfig();
  const uri = String(cfg.redirect_uri || '').trim();
  if (uri) return uri;
  // 仅内网/本机 Host 才自动推导；公网中转域名返回空(交由前端引导用户显式配置)
  if (requestHost && isPrivateHost(requestHost)) {
    const rh = String(requestHost).trim();
    if (rh && !rh.includes('://')) return `http://${rh}/oauth/callback`;
  }
  const host = process.env.NAS_IP || '';
  if (host && isPrivateHost(host)) {
    return `http://${host}:${parseInt(process.env.PORT || '20227', 10)}/oauth/callback`;
  }
  return '';
}

function buildOauthUrl(requestHost = null) {
  /** 生成 Strava OAuth 授权 URL，并保存 state 供回调校验。返回 [url|null, 信息]。 */
  const cfg = loadConfig();
  const clientId = String(cfg.client_id || '').trim();
  if (!clientId) return [null, '请先填写 Client ID'];
  const state = tokenUrlsafe(16);
  cfg.oauth_state = state;
  saveConfig(cfg);
  const redirectUri = getRedirectUri(requestHost);
  if (!redirectUri) {
    // 未配置回调 且 请求来自公网中转域名(无法推导) → 提示用户显式配置
    return [null, '未配置回调地址(redirect_uri)；且当前经公网中转访问无法自动推导。请在设置页手动填写 Strava 注册的回调地址，如 http://localhost:20227/oauth/callback(域名需与 Strava 注册的 Callback Domain 完全一致)'];
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    approval_prompt: 'force',
    scope: OAUTH_SCOPE,
    state,
  });
  return [`${OAUTH_AUTHORIZE_URL}?${params.toString()}`, redirectUri];
}

// fetch 带超时 (对齐 python urllib timeout=20)
function fetchTimeout(url, opts = {}, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

async function exchangeCode(code) {
  /** 用 authorization code 换 access_token + refresh_token，保存凭据。 */
  return tokenSerial(async () => {
    const cfg = loadConfig();
    log('strava', 'POST /oauth/token (authorization_code exchange)');
    let r;
    try {
      const resp = await fetchTimeout(STRAVA_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.client_id || '',
          client_secret: cfg.client_secret || '',
          code,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!resp.ok) {
        // 抓取 Strava 拒绝 exchange 的具体原因(HTTP body)，供日志排查
        const body = (await resp.text().catch(() => '')).slice(0, 300);
        const err = new Error(`HTTP ${resp.status}`);
        err.body = body;
        throw err;
      }
      r = await resp.json();
    } catch (e) {
      log('strava', `exchange_code 失败: ${e.message || e} | body=${e.body || ''}`);
      throw e;
    }
    // 诊断：记录 Strava 返回的实际内容(关键字段脱敏)，确认 scope/refresh_token/athlete
    const athleteId = (r.athlete && typeof r.athlete === 'object') ? String(r.athlete.id || '') : '';
    log('strava',
      `exchange 返回: scope=${r.scope} athlete_id=${athleteId} `
      + `refresh_token前8=${String(r.refresh_token || '').slice(0, 8)} `
      + `有新refresh=${Boolean(r.refresh_token)}`);
    cfg.refresh_token = r.refresh_token || '';
    if (r.athlete && typeof r.athlete === 'object') cfg.athlete_id = String(r.athlete.id || '');
    cfg.oauth_state = '';
    saveConfig(cfg);
    // 保存 access token
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeTokenFile({
      access_token: r.access_token,
      refresh_token: r.refresh_token || '',
      scope: r.scope || '',
      expires_at: r.expires_at,
    });
    return [true, null];
  });
}

function writeTokenFile(tok) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok), 'utf8');
  chmod600(TOKEN_FILE);
}

// ---------- Strava token ----------
async function refreshToken(cfg) {
  log('strava', 'POST /oauth/token (refresh_token)');
  const resp = await fetchTimeout(STRAVA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id || '',
      client_secret: cfg.client_secret || '',
      grant_type: 'refresh_token',
      refresh_token: cfg.refresh_token || '',
    }).toString(),
  });
  if (!resp.ok) {
    const body = (await resp.text().catch(() => '')).slice(0, 300);
    const err = new Error(`HTTP ${resp.status}`);
    err.body = body;
    throw err;
  }
  const r = await resp.json();
  // 注意:同样必须先 saveConfig 再写 token 文件（saveConfig 会删 tokens.json）
  //   否则刷新成功的 token 也被随即删掉，缓存永远不存在 → 每次都重新刷新
  if (r.refresh_token) {
    cfg.refresh_token = r.refresh_token;
    saveConfig(cfg);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeTokenFile({
    access_token: r.access_token,
    refresh_token: r.refresh_token || cfg.refresh_token || '',
    scope: r.scope || '',
    expires_at: r.expires_at,
  });
  return [r.access_token, r.scope || ''];
}

function scopeErr(scope) {
  /** token 缺活动权限时的错误描述，用于状态提示而非直接当刷新失败 */
  return `scope 缺 ${REQUIRED_SCOPE}（当前: ${scope || '无'}），需重新 OAuth 授权`;
}

async function getAccessToken() {
  /** 返回 [access_token|null, error]。token 需同时：有效 + scope 含 activity:read_all。
   * 若能刷新但 scope 缺活动权限（历史上用只读 scope 授权），返回 [null, 明确提示]，
   * 状态不再误报为"正常"。 */
  return tokenSerial(async () => {
    const cfg = loadConfig();
    if (!hasCredentials()) return [null, '未配置凭据'];
    // 1) 优先用缓存 token —— 仅当它未过期且含活动 scope 才直接复用
    if (fs.existsSync(TOKEN_FILE)) {
      try {
        const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        const exp = tok.expires_at;
        if (exp && exp > Math.floor(Date.now() / 1000) + 300
            && tok.access_token && scopeHasActivity(tok.scope || '')) {
          return [tok.access_token, null];
        }
        // 缓存缺失/过期/缺活动 scope 时，落到下面刷新，看能否拿到正确 scope
      } catch { /* 缓存文件坏了 → 走刷新 */ }
    }
    // 2) 否则刷新；刷新返回的 token 必须含活动 scope，否则视为不可用
    try {
      const [token, scope] = await refreshToken(cfg);
      if (!scopeHasActivity(scope)) return [null, scopeErr(scope)];
      return [token, null];
    } catch (e) {
      return [null, `刷新失败: ${e.message || e}`];
    }
  });
}

// ---------- Strava API ----------
async function apiGet(token, apiPath, params = null) {
  let url = STRAVA_API + apiPath;
  if (params) url += '?' + new URLSearchParams(params).toString();
  log('strava', `GET ${apiPath} params=${params ? JSON.stringify(params) : ''}`);
  try {
    const resp = await fetchTimeout(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.body = (await resp.text().catch(() => '')).slice(0, 300);
      throw err;
    }
    return await resp.json();
  } catch (e) {
    log('strava', `GET ${apiPath} 失败: ${e.message || e}`);
    throw e;
  }
}

function getActivitiesPage(token, page = 1, perPage = 100, after = null) {
  const params = { per_page: String(perPage), page: String(page) };
  if (after) params.after = String(after);
  return apiGet(token, '/athlete/activities', params);
}

// 同步进度（供前端轮询 /api/sync/progress）
const SYNC_PROGRESS = { running: false, page: 0, fetched: 0, message: '', done: false, error: null };

async function syncFromStrava(token, limitPages = 20, mode = 'incremental') {
  /** 同步 Strava→SQLite。
   *  mode='incremental'(默认): 用 after=已知最新活动时间戳只拉新活动,拉到重叠即停;
   *  mode='full': 全量翻页重拉(用于回填历史字段/修正),upsert 覆盖。
   *  返回统计。同步期间更新 SYNC_PROGRESS 供前端轮询进度。 */
  SYNC_PROGRESS.running = true;
  SYNC_PROGRESS.error = null;
  SYNC_PROGRESS.message = mode === 'full' ? '开始全量同步' : '开始增量同步';
  const allActs = [];
  let page = 1;
  let skipped = 0;
  try {
    // 增量:以本地最新活动时间为 after 水位(留 1 天重叠,覆盖 Strava 落库延迟)
    let after = null;
    if (mode === 'incremental') {
      const latest = db.db.prepare("SELECT MAX(start_date) t FROM activities").get().t;
      if (latest) {
        const ts = Date.parse(latest) / 1000 - 86400;
        if (Number.isFinite(ts)) after = Math.floor(ts);
      }
    }
    while (page <= limitPages) {
      const acts = await getActivitiesPage(token, page, 100, after);
      SYNC_PROGRESS.page = page;
      if (!acts || acts.length === 0) break;
      allActs.push(...acts);
      SYNC_PROGRESS.fetched = allActs.length;
      SYNC_PROGRESS.message = `已拉取第 ${page} 页 · ${allActs.length} 条`;
      log('strava', `同步进度(${mode}): 第 ${page} 页, 累计 ${allActs.length} 条`);
      // 增量:本页全部早于等于水位时间 → 已触及已知区间,停止翻页
      if (after) {
        const newest = acts[0] && acts[0].start_date ? Date.parse(acts[0].start_date) / 1000 : 0;
        if (newest <= after) { skipped = 1; break; }
      }
      page += 1;
      if (page > 1 && acts.length < 100) break;
    }
    SYNC_PROGRESS.message = '写入本地数据库';
    const added = db.upsertActivities(allActs);
    SYNC_PROGRESS.done = true;
    SYNC_PROGRESS.message = `完成 · 拉取 ${allActs.length} 条, 新增 ${added} 条`;
    log('system', `同步完成(${mode}): 拉取 ${allActs.length} 条, 新增 ${added} 条`);
    return { activities: allActs.length, new: added, page: page - 1, mode };
  } catch (e) {
    SYNC_PROGRESS.error = String(e.message || e);
    SYNC_PROGRESS.message = `失败: ${e.message || e}`;
    throw e;
  } finally {
    SYNC_PROGRESS.running = false;
  }
}

async function ensureLocalData() {
  /** 确保本地 DB 有数据：若为空则尝试从 Strava 同步（best-effort）。
   * Strava token 失效/未配置时静默降级，不影响读本地缓存。 */
  if (db.count() > 0) return [true, null];
  try {
    const [tok, err] = await getAccessToken();
    if (!tok) return [false, err || '未配置'];
    await syncFromStrava(tok);
    return [true, null];
  } catch (e) {
    return [false, String(e.message || e)];
  }
}

// ---------- 服务状态 / 日志 ----------
const LOG_ARCHIVE_DIR = path.join(DATA_DIR, 'logs');
// 日志来源: 名称 -> 文件（三个源分开落库）
const LOG_SOURCES = {
  system: path.join(DATA_DIR, 'system.log'),        // 系统状态/初始化/本地SQLite/同步
  strava: path.join(DATA_DIR, 'strava-api.log'),    // 请求 Strava API（token刷新/活动拉取）
  agent: path.join(DATA_DIR, 'agent.log'),          // agent 外部调用拿数据
};

function log(source, msg) {
  /** 向指定日志源追加一行（带时间戳）。source 需在 LOG_SOURCES 中。 */
  const p = LOG_SOURCES[source];
  if (!p) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(p, `[${nowStamp()}] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

function archiveDate() {
  const now = new Date();
  return [fmtDate(now).replace(/-/g, ''), fmtDate(now)];
}

function fmtDisplayDate(compact) {
  if (compact.length === 8) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
  return compact;
}

function archiveLogs() {
  /** 启动时归档: 把非当天的日志文件滚到 LOG_ARCHIVE_DIR/{name}.log.YYYYMMDD。
   * 规则: 当前日志文件若修改日期不是今天, 则归档 (移动) 到归档目录,
   * 并清空当前文件, 让新日志只记录当天。避免单文件无限增长。 */
  const [todayCompact] = archiveDate();
  for (const [name, p] of Object.entries(LOG_SOURCES)) {
    try {
      if (!fs.existsSync(p)) continue;
      const mday = fmtDate(fs.statSync(p).mtime).replace(/-/g, '');
      if (mday === todayCompact) continue;
      fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });
      const dest = path.join(LOG_ARCHIVE_DIR, `${name}.log.${mday}`);
      let content;
      try { content = fs.readFileSync(p); } catch { content = Buffer.alloc(0); }
      fs.writeFileSync(dest, content, { flag: fs.existsSync(dest) ? 'a' : 'w' });
      fs.writeFileSync(p, Buffer.alloc(0));
    } catch { /* 单个源归档失败跳过 */ }
  }
}

function listLogDates(name) {
  /** 返回某日志来源可用的日期列表 (含归档 + 当前). 倒序. */
  const dates = [];
  const base = LOG_SOURCES[name];
  if (!base) return dates;
  try {
    if (fs.existsSync(LOG_ARCHIVE_DIR)) {
      const re = new RegExp(`^${name}\\.log\\.(\\d{8})$`);
      for (const f of fs.readdirSync(LOG_ARCHIVE_DIR)) {
        const m = re.exec(f);
        if (m) dates.push([m[1], fmtDisplayDate(m[1])]);
      }
    }
  } catch { /* 忽略 */ }
  try {
    if (fs.existsSync(base) && fs.statSync(base).size > 0) dates.push(archiveDate());
  } catch { /* 忽略 */ }
  const seen = new Set();
  const result = [];
  dates.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [compact, disp] of dates) {
    if (seen.has(compact)) continue;
    seen.add(compact);
    result.push({ date: compact, display: disp });
  }
  return result;
}

function readLogs(name, date = null, tail = 500) {
  /** 读取日志内容. name: strava. date: YYYYMMDD 或 null(当前). tail: 返回最后 N 行. */
  const base = LOG_SOURCES[name];
  if (!base) return null;
  let target = base;
  let display = '当前';
  if (date) {
    const compact = String(date).replace(/-/g, '');
    target = path.join(LOG_ARCHIVE_DIR, `${name}.log.${compact}`);
    display = fmtDisplayDate(compact);
  }
  try {
    if (!fs.existsSync(target)) {
      return { source: name, date: date || 'current', display, total: 0, content: '' };
    }
    // Node utf8 解码对非法字节默认 U+FFFD, 等价 python errors="replace"
    const raw = fs.readFileSync(target, 'utf8');
    let lines = raw.split('\n');
    if (tail && tail > 0 && lines.length > tail) lines = lines.slice(-tail);
    return {
      source: name,
      date: date || 'current',
      display,
      total: raw.split('\n').length,
      content: lines.join('\n'),
    };
  } catch (e) {
    return { source: name, date: date || 'current', display, total: 0, content: `读取日志失败: ${e}` };
  }
}

async function getServiceInfo() {
  /** 返回服务状态，分三组: strava (API 状态) / db (本地数据库状态) / agent (外部调用状态). */
  const cfg = loadConfig();
  const [tok, err] = await getAccessToken();
  // 本地数据库文件信息
  let dbSize = 0;
  try { dbSize = fs.statSync(DB_FILE).size; } catch { /* 文件不存在 */ }
  // agent 外部调用统计
  let agentCount = 0;
  try { agentCount = parseInt(db.getMeta('agent_call_count') || '0', 10) || 0; } catch { agentCount = 0; }
  return {
    // Strava API 状态
    strava: {
      configured: hasCredentials(),
      has_token: Boolean(tok),
      token_error: err,
      // cfg 有键但值为空时 Python cfg.get() 返回 "" (不是 null), 逐字保持
      athlete_id: 'athlete_id' in cfg ? cfg.athlete_id : null,
      last_sync: db.getMeta('last_sync'),
    },
    // 本地数据库状态
    db: {
      activities: db.count(),
      size_bytes: dbSize,
      path: DB_FILE,
    },
    // Agent 外部调用状态
    agent: {
      api_token: Boolean(getOrCreateApiToken()),
      call_count: agentCount,
      last_call: db.getMeta('agent_last_call'),
    },
    // 通用
    version: APP_VERSION || '',
    port: parseInt(process.env.PORT || '20227', 10),
  };
}

function recordAgentCall() {
  /** 记录一次 agent 外部 API 调用（计数 + 最后调用时间），持久化到 DB meta. */
  try {
    let n = 0;
    try { n = parseInt(db.getMeta('agent_call_count') || '0', 10) || 0; } catch { n = 0; }
    db.setMeta('agent_call_count', String(n + 1));
    db.setMeta('agent_last_call', localIsoSeconds());
  } catch { /* 统计失败忽略 */ }
}

function buildApiDoc(lang = 'zh', requestHost = null) {
  /** 生成 API 使用指南 Markdown 文档 (中/英)。
   * base 地址按实际请求 Host 动态生成(面板里复制出来即可直接用);
   * 拿不到 Host 时回落 http://localhost:20227。 */
  const base = requestHost ? `http://${requestHost}` : 'http://localhost:20227';
  if (lang !== 'zh') {
    return (
      '# Strava Panel Admin API Guide\n\n'
      + '> Port **20227**. All endpoints except `/api/bootstrap`/`/api/status` '
      + 'require `Authorization: Bearer <api_token>`. Get/create the token in the '
      + 'panel (Dashboard → Create Token, or Settings → API).\n\n'
      + '## Endpoints\n\n'
      + '```bash\n'
      + `BASE="${base}"\n`
      + 'export TOKEN="<your-token>"\n'
      + 'AUTH="Authorization: Bearer $TOKEN"\n'
      + '\n'
      + '# 1. Get token (no auth)\n'
      + 'curl -s "$BASE/api/bootstrap"\n'
      + '\n'
      + '# 2. Service status (no auth)\n'
      + 'curl -s "$BASE/api/status"\n'
      + '\n'
      + '# 3. Riding stats (date range optional)\n'
      + 'curl -s -H "$AUTH" "$BASE/api/stats?start=2026-01-01&end=2026-01-31"\n'
      + '\n'
      + '# 4. Weekly aggregation\n'
      + 'curl -s -H "$AUTH" "$BASE/api/weekly"\n'
      + '\n'
      + '# 5. Activities list (filter)\n'
      + 'curl -s -H "$AUTH" "$BASE/api/activities?type=Ride&limit=10"\n'
      + '\n'
      + '# 6. Trigger Strava→SQLite sync\n'
      + 'curl -s -H "$AUTH" "$BASE/api/sync"\n'
      + '\n'
      + '# 7. Export all data (json/csv)\n'
      + 'curl -s -H "$AUTH" "$BASE/api/export?fmt=json"\n'
      + 'curl -s -H "$AUTH" "$BASE/api/export?fmt=csv" -o strava.csv\n'
      + '\n'
      + '# 8. Logs (console)\n'
      + 'curl -s -H "$AUTH" "$BASE/api/logs/list?source=strava"\n'
      + 'curl -s -H "$AUTH" "$BASE/api/logs?source=strava&tail=200"\n'
      + 'curl -s -H "$AUTH" -o strava.log "$BASE/api/logs/download?source=strava"\n'
      + '\n'
      + '# 9. Token management\n'
      + 'curl -s -H "$AUTH" "$BASE/api/token/view"\n'
      + 'curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{}" "$BASE/api/token/recreate"\n'
      + '\n'
      + '# 10. This doc\n'
      + 'curl -s -H "$AUTH" "$BASE/api/doc"\n'
      + '```\n\n'
      + '> Parse JSON with `python3 -m json.tool` (no jq needed).\n'
    );
  }
  return (
    '# Strava Panel 管理面板 API 指南\n\n'
    + '> 面板端口 **20227**。除 `/api/bootstrap` 和 `/api/status` 外，所有接口需 '
    + '`Authorization: Bearer <api_token>`。token 在面板「仪表板 → 创建 token」或「设置 → API」查看/生成。\n\n'
    + '## 各接口\n\n'
    + '```bash\n'
    + `BASE="${base}"\n`
    + 'export TOKEN="<your-token>"\n'
    + 'AUTH="Authorization: Bearer $TOKEN"\n'
    + '\n'
    + '# 1. 获取 token（免认证）\n'
    + 'curl -s "$BASE/api/bootstrap"\n'
    + '\n'
    + '# 2. 服务状态（免认证）\n'
    + 'curl -s "$BASE/api/status"\n'
    + '\n'
    + '# 3. 骑行统计（可带日期范围）\n'
    + 'curl -s -H "$AUTH" "$BASE/api/stats?start=2026-01-01&end=2026-01-31"\n'
    + '\n'
    + '# 4. 每周聚合\n'
    + 'curl -s -H "$AUTH" "$BASE/api/weekly"\n'
    + '\n'
    + '# 5. 活动列表（支持过滤）\n'
    + 'curl -s -H "$AUTH" "$BASE/api/activities?type=Ride&limit=10"\n'
    + '\n'
    + '# 6. 触发 Strava→SQLite 同步\n'
    + 'curl -s -H "$AUTH" "$BASE/api/sync"\n'
    + '\n'
    + '# 7. 导出全量数据（json/csv）\n'
    + 'curl -s -H "$AUTH" "$BASE/api/export?fmt=json"\n'
    + 'curl -s -H "$AUTH" "$BASE/api/export?fmt=csv" -o strava.csv\n'
    + '\n'
    + '# 8. 日志（控制台）\n'
    + 'curl -s -H "$AUTH" "$BASE/api/logs/list?source=strava"\n'
    + 'curl -s -H "$AUTH" "$BASE/api/logs?source=strava&tail=200"\n'
    + 'curl -s -H "$AUTH" -o strava.log "$BASE/api/logs/download?source=strava"\n'
    + '\n'
    + '# 9. token 管理\n'
    + 'curl -s -H "$AUTH" "$BASE/api/token/view"\n'
    + 'curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{}" "$BASE/api/token/recreate"\n'
    + '\n'
    + '# 10. 本指南\n'
    + 'curl -s -H "$AUTH" "$BASE/api/doc"\n'
    + '```\n\n'
    + '> 解析 JSON 用 `python3 -m json.tool`（无需 jq）。\n'
  );
}

// ---------- LLM 教练 (训练建议) ----------
function llmConfig() {
  const cfg = loadConfig();
  const baseUrl = String(cfg.llm_base_url || '').trim().replace(/\/+$/, '');
  const apiKey = String(cfg.llm_api_key || '').trim();
  const model = String(cfg.llm_model || '').trim();
  return { baseUrl, apiKey, model, configured: Boolean(baseUrl && model) };
}

function modelShort(id) {
  /** 去掉网关模型 id 的供应商前缀(cbai/gpt-6 → gpt-6),对齐 imgmark 显示。
   *  规则与前端 modelShort 一致:剥到第一个 '/'(openrouter/anthropic/claude → anthropic/claude)。
   *  真实 id 仍用于 API 调用,short 只是展示字段。 */
  const s = String(id || '');
  const i = s.indexOf('/');
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
}

function parseLlmModels(cfg) {
  /** 模型库(strava.conf llm_models JSON): [{id, short, context, alias}] */
  try {
    const arr = JSON.parse(String(cfg.llm_models || '[]'));
    return Array.isArray(arr) ? arr.filter((m) => m && m.id) : [];
  } catch { return []; }
}

// PyFloat 解包:REAL 列(distance/moving_time/total_elevation_gain/聚合 dist_km 等)
// 在 db.js 里被包装成 PyFloat 对象(为与 Python 版字节级对齐),拼文本/算术前须还原为 number。
const num = (v) => (v instanceof PyFloat ? v.v : (v == null ? 0 : Number(v) || 0));

// 运动方式 → 展示名/单位（digest 与提示词共用）
const SPORT_LABEL = {
  Ride: '骑行', Run: '跑步', Walk: '步行', Swim: '游泳', Hike: '徒步',
  VirtualRide: '室内骑行', RideVirtual: '室内骑行', Workout: '综合训练',
  WeightTraining: '力量训练',
};
function coachSports() {
  /** 用户勾选的运动方式（strava.conf coach_sports，逗号分隔），默认仅骑行。 */
  const raw = String(loadConfig().coach_sports || 'Ride');
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : ['Ride'];
}
// 训练时间段偏好 → 24h 制小时区间（供提示词注入）
const TIME_WINDOWS = {
  early: [5, 8], morning: [8, 12], noon: [12, 14],
  afternoon: [14, 18], evening: [18, 21], night: [21, 23],
};
function coachTimes() {
  /** 用户勾选的训练时间段（coach_times，逗号分隔的 id），空 = 不限。 */
  const raw = String(loadConfig().coach_times || '');
  const list = raw.split(',').map(s => s.trim()).filter(id => TIME_WINDOWS[id]);
  return list;
}

function buildTrainingDigest() {
  /** 汇总近期训练数据为紧凑文本,作为教练系统提示的上下文。 */
  const p1 = (n) => String(n).padStart(2, '0');
  const f = (d) => `${d.getFullYear()}-${p1(d.getMonth() + 1)}-${p1(d.getDate())}`;
  const now = new Date();
  const dAgo = (days) => { const d = new Date(now); d.setDate(d.getDate() - days); return f(d); };
  const sports = coachSports();
  const label = sports.map(s => SPORT_LABEL[s] || s).join('+');
  const seg = (days) => {
    const st = db.stats(dAgo(days), f(now), sports);
    return `${days}天: ${st.total_rides}次 / ${num(st.total_distance_km).toFixed(1)}km / ${num(st.total_duration_h).toFixed(1)}h / 爬升${Math.round(num(st.total_elevation_m))}m`
      + (st.avg_heartrate != null ? ` / 均心率${num(st.avg_heartrate)}bpm` : '')
      + (st.avg_watts != null ? ` / 均功率${num(st.avg_watts)}W` : '')
      + (st.avg_cadence != null ? ` / 均踏频${num(st.avg_cadence)}rpm` : '');
  };
  const acts = db.getActivities(sports, 15).map((a) => {
    const km = (num(a.distance) / 1000).toFixed(1);
    const h = (num(a.moving_time) / 3600).toFixed(1);
    const el = Math.round(num(a.total_elevation_gain));
    const hr = a.average_heartrate != null ? Math.round(num(a.average_heartrate)) + 'bpm' : '-';
    const pw = a.average_watts != null ? Math.round(num(a.average_watts)) + 'W' : '-';
    const cad = a.average_cadence != null ? Math.round(num(a.average_cadence)) + 'rpm' : '-';
    const tp = SPORT_LABEL[a.type] || a.type || '';
    return `${String(a.start_date_local || a.start_date || '').slice(0, 10)} [${tp}] ${(a.name || '').slice(0, 30)} ${km}km/${h}h/爬${el}m/HR${hr}/PW${pw}/CAD${cad}`;
  });
  const weekly = db.weekly(dAgo(56), f(now), sports).map((w) => `${w.week}:${num(w.dist_km).toFixed(1)}km(${w.count}次)`).join(' ');
  return [
    `【运动员主项】${label}`,
    '【近况】' + seg(7) + '; ' + seg(28) + '; ' + seg(90),
    '【近8周趋势】' + (weekly || '无'),
    `【最近15次训练(${label})】`,
    ...acts,
  ].join('\n');
}

const COACH_SYSTEM = (digest, lang, now = new Date(), sports = ['Ride']) => {
  /** 注入当前时间:计划类回答(周/月/赛前)必须以今天为唯一起点,不安排已过去的日期。 */
  const p2 = (n) => String(n).padStart(2, '0');
  const dowCN = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const dowEN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];
  const isoWeek = (() => { const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return 1 + Math.floor(((d - y0) / 86400000 - 6) / 7); })();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysLeftInMonth = monthEnd.getDate() - now.getDate();
  const yearEnd = new Date(now.getFullYear(), 11, 31);
  const daysLeftInYear = Math.round((yearEnd - now) / 86400000);
  const timeHHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  const dateLine = lang === 'en'
    ? `【CURRENT TIME】${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${timeHHMM} (${dowEN}), ISO week ${isoWeek}. Remaining: ${daysLeftInMonth} days this month, ${daysLeftInYear} days this year.`
    : `【当前时间】${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${timeHHMM} 周${dowCN},第 ${isoWeek} 周。剩余:本月 ${daysLeftInMonth} 天,本年 ${daysLeftInYear} 天。`;
  const timeRule = lang === 'en'
    ? 'When making any TIME-BOUND plan (weekly / monthly / race prep), treat today as the ONLY start date: NEVER schedule sessions on past dates. A weekly plan covers today→Sunday only; a monthly plan covers today→month end; a race plan counts back from race day but starts no earlier than today. State concrete dates. IMPORTANT — respect the current clock time: if it is already evening/night (roughly 19:00 or later), do NOT put a training session on today; start the schedule from tomorrow instead, unless the user explicitly asks for a session today.'
    : '制定任何时间相关计划(周/月/赛前)时,以今天为唯一起点,绝不安排已过去的日期:周计划只覆盖今天→本周日,月计划只覆盖今天→月末,赛前计划从今天起排到比赛日。给出具体日期。重要——必须尊重当前钟点:如果现在已是傍晚/晚间(约 19:00 之后),不要把训练排在今天,课表从明天开始排,除非用户明确要求今天就要练。';
  const calRule = lang === 'en'
    ? 'Strava Panel has a built-in Training Calendar and one-click ICS import/export capability. When the user asks you to build a training plan, schedule workouts, or add to calendar: 1) Outline the daily schedule clearly with concrete dates (YYYY-MM-DD); 2) Provide a standard iCalendar (ICS) code block (BEGIN:VCALENDAR ... END:VCALENDAR) so the panel can automatically parse it and let the user import it into their training calendar with one click. NEVER say you lack permissions to write to their calendar; provide the schedule with the ICS block and tell them they can click "写入训练日历" on the message.'
    : 'Strava Panel 内置了训练日历系统，并深度支持一键导入与 ICS 日历文件导出。当用户要求你安排训练计划、课表或“添加到训练日历”时：1) 给出具体的每日训练计划（标明具体公历日期 YYYY-MM-DD）；2) 务必在回答末尾提供标准的 iCalendar (ICS) 代码块（以 ```ics 包裹 BEGIN:VCALENDAR ... END:VCALENDAR），面板会自动识别该代码块并在卡片下方提供「写入训练日历」和「下载 ICS」快捷按钮；3) 严禁回答“我没有权限写入你的训练日历”，直接告知用户已生成课表，点击消息卡片下方的按钮即可一键同步至内置训练日历。';
  const sportNames = sports.map(s => SPORT_LABEL[s] || s);
  const sportRule = lang === 'en'
    ? `【SPORT DISCIPLINE — HARD RULE】This athlete's selected sports are: ${sports.join(', ')}. ONLY recommend and schedule training within these sports. NEVER suggest workouts from any other sport (e.g. if the athlete is a cyclist, do NOT prescribe running workouts as main sessions). Cross-training may only be mentioned if the user explicitly asks for it. If the user requests a plan, every session must belong to a selected sport.`
    : `【运动方式 — 硬性规则】该运动员选择的运动方式为：${sports.join(', ')}（${sportNames.join('、')}）。只允许在这些运动方式内推荐和安排训练,绝不推荐其他运动的训练(例如运动员是骑行者,就不要把跑步排进课表)。交叉训练仅在用户主动要求时才可提及。生成任何课表时,每一课都必须属于所选运动。`;
  // 训练时间段偏好：用户勾选了具体窗口时才注入
  const timeSel = coachTimes();
  let timeRulePref = '';
  if (timeSel.length) {
    const enName = { early: 'early morning 5-8am', morning: 'morning 8am-12pm', noon: 'noon 12-2pm', afternoon: 'afternoon 2-6pm', evening: 'evening 6-9pm', night: 'night 9-11pm' };
    const zhName = { early: '清晨 5~8 点', morning: '上午 8~12 点', noon: '午间 12~14 点', afternoon: '下午 14~18 点', evening: '傍晚 18~21 点', night: '夜间 21~23 点' };
    const wins = timeSel.map(id => TIME_WINDOWS[id]);
    const lo = Math.min(...wins.map(w => w[0]));
    const hi = Math.max(...wins.map(w => w[1]));
    timeRulePref = lang === 'en'
      ? `【TRAINING TIME WINDOWS】The athlete prefers training at: ${timeSel.map(id => enName[id]).join(', ')}. When suggesting concrete sessions, schedule them within these windows (roughly ${String(lo).padStart(2,'0')}:00-${String(hi).padStart(2,'0')}:00 local time) unless the user explicitly asks otherwise.`
      : `【训练时间段偏好】该运动员偏好的训练时间段为：${timeSel.map(id => zhName[id]).join('、')}。给出具体课表时,训练安排应落在这些时间窗口内(当地约 ${p2(lo)}:00-${p2(hi)}:00),除非用户明确要求其他时间。`;
  }
  // 运动员画像声明：把面板中已知的用户偏好显式告知模型，禁止凭空假设。
  // 运动方式来自设置→偏好（coach_sports，与 sportRule 同源）；常驻地来自 coach_home_city（如有）。
  const city = String(loadConfig().coach_home_city || '').trim();
  const profileLines = [];
  profileLines.push(lang === 'en'
    ? `- Selected sports (from Settings → Preferences): ${sportNames.join(', ')}. These are the athlete's OWN choices, not assumptions.`
    : `- 运动方式（来自 设置→偏好，是用户本人勾选的，不是假设）：${sportNames.join('、')}`);
  if (city) profileLines.push(lang === 'en' ? `- Home city: ${city}` : `- 常驻城市：${city}`);
  profileLines.push(lang === 'en'
    ? `- Anything not listed above (age, weight, fitness level, health conditions, goals) is UNKNOWN to you: never assume or invent it. If a plan depends on it, ask first.`
    : `- 上面未列出的信息（年龄/体重/运动基础/健康状况/目标等）你并不知道：绝不假设或编造；计划依赖这些信息时先询问。`);
  const profileRule = (lang === 'en'
    ? `【ATHLETE PROFILE — from panel settings】\n`
    : `【运动员画像 — 来自面板设置】\n`) + profileLines.map(l => l).join('\n');
  const roleLine = lang === 'en'
    ? `You are the built-in coach of Strava Panel for this ${sportNames.join('+').toLowerCase() || 'endurance'} athlete. Below is the athlete's training data aggregated from the local database:`
    : `你是 Strava Panel 内置的${sportNames.join('+') || '耐力'}教练。以下是该运动员从本地数据库汇总的训练数据:`;
  return [
    roleLine,
    '',
    digest,
    '',
    dateLine,
    '',
    '规则: 基于上述真实数据回答,不要编造数据;数据不足时明确说明并给出需要补充的信息。',
    profileRule,
    sportRule,
    timeRulePref,
    timeRule,
    calRule,
    '给出具体的、可执行的训练建议(强度用心率/功率/踏频/体感描述)。回答保持简洁,用 markdown 轻量排版(可用标题、表格、列表)。',
    lang === 'zh' ? '始终使用简体中文回答。' : 'Always answer in English.',
  ].join('\n');
};

async function callLlm(cfg, messages, timeoutMs = 90000) {
  /** OpenAI 兼容 /chat/completions 调用。返回 assistant 文本。 */
  const url = cfg.baseUrl + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const resp = await fetchTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.7 }),
  }, timeoutMs);
  if (!resp.ok) {
    const body = (await resp.text().catch(() => '')).slice(0, 500);
    let friendly = '';
    try {
      const j = JSON.parse(body);
      const msg = j.error?.message || j.message || j.error?.msg || '';
      if (msg) friendly = String(msg).slice(0, 200);
    } catch { /* 非 JSON 错误体 */ }
    const statusMap = {
      401: 'API Key 无效或已过期',
      403: '无权限访问该模型',
      404: '模型不存在或不可用',
      429: '请求过于频繁,请稍后再试',
      500: '网关内部错误',
      502: '网关不可用',
      503: '服务暂时不可用',
    };
    const hint = statusMap[resp.status] || `HTTP ${resp.status}`;
    const err = new Error(friendly ? `${hint}: ${friendly}` : (hint + (resp.statusText ? ` (${resp.statusText})` : '')));
    err.llm = true;
    throw err;
  }
  const j = await resp.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) { const err = new Error('LLM 返回内容为空'); err.llm = true; throw err; }
  return String(content);
}

// ---------- HTTP server ----------
function sendJson(res, obj, code = 200) {
  // pyDump: 输出与 python json.dumps(obj, ensure_ascii=False) 一致 (含 float repr 与默认分隔符)
  const body = Buffer.from(pyDump(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendError404(res) {
  const body = Buffer.from('<!DOCTYPE html><html><head><title>Error response</title></head>'
    + '<body><h1>Error response</h1><p>Error code: 404 (Not Found)</p></body></html>');
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function sendFile(res, rel) {
  const wwwRoot = path.resolve(WWW_DIR);
  const p = path.resolve(WWW_DIR, rel);
  if (!p.startsWith(wwwRoot) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    sendError404(res);
    return;
  }
  const ctype = CONTENT_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
  let body = fs.readFileSync(p);
  // 对 index.html 注入版本号 (替换 __APP_VERSION__ 占位符，读不到时用兜底值，避免残留占位符)
  // 页面两处用途：brandVer 显示（可含 commit 后缀）、脚本 ?v= 缓存参数（须 URL 安全）→ 注入纯版本号，
  // 显示用的 commit 后缀由前端从 bootstrap 的 version 动态填充
  if (rel === 'index.html') {
    body = Buffer.from(body.toString('utf8').split('__APP_VERSION__').join(APP_VERSION || ''), 'utf8');
  }
  // no-store：本地面板更新频繁，启发式缓存会让浏览器用旧 JS/CSS（改完代码刷新无效的元凶）
  res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

// path 不被 WHATWG URL 规范化 (python urlparse 不做 dot-segment 折叠), 手工切
function rawPathOf(reqUrl) {
  const q = reqUrl.indexOf('?');
  return q === -1 ? reqUrl : reqUrl.slice(0, q);
}

// 等价 python parse_qs (keep_blank_values=False): 空值键也丢弃, 每键取第一个
function getQs(reqUrl) {
  const q = reqUrl.indexOf('?');
  const out = {};
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(reqUrl.slice(q + 1)).entries()) {
      if (v === '' || k in out) continue;
      out[k] = v;
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function recordAgentGet(req, rawPath) {
  recordAgentCall();
  log('agent', `agent 调用 ${rawPath}`);
}

function requireApiToken(req, res, qs, rawPath) {
  /** 校验 API 访问 token（数据接口保护）。返回是否通过。 */
  // 从 Authorization header 或 ?token= 参数读取
  let token = null;
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim();
  if (!token) token = qs.token;
  if (!apiTokenValid(token)) {
    sendJson(res, { error: '无效的 API token，请使用 Authorization: Bearer ***' }, 401);
    return false;
  }
  // 记录一次 agent 外部调用（计数 + 最后调用时间 + 日志）
  recordAgentGet(req, rawPath);
  return true;
}

async function requireStravaToken(res) {
  const [tok, err] = await getAccessToken();
  if (!tok) {
    sendJson(res, { error: err || '未配置' }, 400);
    return null;
  }
  return tok;
}

// Python int(): 严格整数解析 (int("12.5")/int("abc") 抛错 → 路由 500 {error})
const strictInt = (v, dflt) => {
  const s = (v === undefined || v === null) ? String(dflt) : String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return parseInt(s, 10);
};

let _intervalsCache = { ts: 0, data: null };
async function fetchIntervalsCurves(athleteId, apiKey) {
  if (Date.now() - _intervalsCache.ts < 1800000 && _intervalsCache.data) {
    return _intervalsCache.data;
  }
  const auth = Buffer.from('API_KEY:' + apiKey).toString('base64');
  const url = `https://intervals.icu/api/v1/athlete/${athleteId}/power-curves.json?type=Ride&curves=all,42d,1y`;
  const resp = await fetchTimeout(url, {
    headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
  }, 15000);
  if (!resp.ok) throw new Error('Intervals.icu HTTP ' + resp.status);
  const json = await resp.json();
  if (json && Array.isArray(json.list)) {
    _intervalsCache = { ts: Date.now(), data: json.list };
    return json.list;
  }
  return null;
}

async function handleGet(req, res, rawPath, qs) {
  // Strava OAuth 回调（免认证：Strava 授权后重定向到这里）
  if (rawPath === '/oauth/callback') {
    const code = qs.code || '';
    const state = qs.state || '';
    const cfg = loadConfig();
    let ok = false;
    let err = '';
    if (!code) {
      err = '缺少授权 code';
    } else if (!state || state !== (cfg.oauth_state || '')) {
      err = 'state 校验失败（授权已过期或来自未知请求）';
    } else {
      try {
        [ok, err] = await exchangeCode(code);
      } catch (e) {
        err = String(e.message || e);
      }
    }
    // 返回一个简单的成功/失败页，可自动关闭
    let body;
    if (ok) {
      body = (`<html><body style='font-family:sans-serif;text-align:center;padding-top:60px;background:#fff'>`
        + `<div style='max-width:420px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:14px'>`
        + `<h2 style='color:#22c55e;margin:0 0 12px'>✓ Strava 授权成功</h2>`
        + `<p style='color:#666'>refresh_token 已保存，你可以返回面板查看骑行数据了。</p>`
        + `<p><a href='/' style='display:inline-block;margin-top:12px;padding:10px 26px;background:#fc4c02;color:#fff;border-radius:999px;text-decoration:none'>⬅ 返回面板</a></p>`
        + `</div>`
        + `<script>try{if(window.opener){window.opener.location.href='/';}setTimeout(function(){window.close();},1500);}catch(e){}</script>`
        + `</body></html>`);
    } else {
      body = (`<html><body style='font-family:sans-serif;text-align:center;padding-top:60px;background:#fff'>`
        + `<div style='max-width:420px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:14px'>`
        + `<h2 style='color:#ef4444;margin:0 0 12px'>✗ 授权失败</h2>`
        + `<p style='color:#666'>${err}</p>`
        + `<p><a href='/' style='display:inline-block;margin-top:12px;padding:10px 26px;background:#333;color:#fff;border-radius:999px;text-decoration:none'>⬅ 返回面板</a></p>`
        + `</div></body></html>`);
    }
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  if (rawPath === '/api/bootstrap') {
    // 免认证：返回 API token + 版本号，供面板前端初始加载/填充 brandVer
    sendJson(res, {
      api_token: getOrCreateApiToken(),
      configured: hasCredentials(),
      version: displayVersion(),
    });
    return;
  }
  if (rawPath === '/api/status') {
    const cfg = loadConfig();
    const [tok, err] = await getAccessToken();
    sendJson(res, {
      configured: hasCredentials(),
      has_token: Boolean(tok),
      token_error: err,
      athlete_id: 'athlete_id' in cfg ? cfg.athlete_id : null,
      db_activities: db.count(),
      last_sync: db.getMeta('last_sync'),
      build: buildInfo(),
    });
    return;
  }
  if (rawPath === '/api/stats') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      // 优先读本地缓存；仅本地为空时才尝试 Strava 同步（降级不报错）
      await ensureLocalData();
      // 运动类型过滤（逗号分隔 Strava 类型，如 Ride,Run；缺省 Ride 兼容旧调用）
      const types = String(qs.types || 'Ride').split(',').map(s => s.trim()).filter(Boolean);
      const stats = db.stats(qs.start || null, qs.end || null, types);
      stats.weekly = db.weekly(qs.start || null, qs.end || null, types);
      stats.monthly = db.monthly(qs.start || null, qs.end || null, types);
      stats.daily = db.daily(qs.start || null, qs.end || null, types);
      stats.yearly = db.yearly(qs.start || null, qs.end || null, types);
      stats.last_sync = db.getMeta('last_sync');
      sendJson(res, stats);
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/coach/history') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const sid = qs.session_id != null && qs.session_id !== '' ? Number(qs.session_id) : null;
      const cfg = loadConfig();
      sendJson(res, {
        session_id: sid,
        messages: db.getMemory(60, sid),
        sessions: db.listSessions(),
        count: db.countMemory(),
        llm: (() => { const c = llmConfig(); return { configured: c.configured, base_url: c.baseUrl, model: c.model, has_key: Boolean(c.apiKey), models: parseLlmModels(cfg) }; })(),
      });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/coach/models') {
    // 从网关拉模型列表(OpenAI 兼容 GET /models)。?base=&key=&model= 可传未保存的草稿值。
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const c = llmConfig();
    const baseUrl = String(qs.base || c.baseUrl || '').trim().replace(/\/+$/, '');
    let apiKey = String(qs.key || '').trim();
    if (qs.key === '__KEEP__' || !apiKey) apiKey = c.apiKey;
    if (!baseUrl) { sendJson(res, { ok: false, error: '请先填写 API 地址' }, 400); return; }
    try {
      const headers = { Accept: 'application/json' };
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      const resp = await fetchTimeout(baseUrl + '/models', { headers }, 15000);
      if (!resp.ok) {
        const body = (await resp.text().catch(() => '')).slice(0, 200);
        throw new Error(`HTTP ${resp.status}: ${body || resp.statusText}`);
      }
      const j = await resp.json();
      const raw = Array.isArray(j) ? j : (j.data || j.models || []);
      const models = raw.map((m) => (typeof m === 'string'
        ? { id: m, short: modelShort(m) }
        : { id: String(m.id || m.name || m.model || ''), short: modelShort(String(m.id || m.name || m.model || '')), created: m.created || null, context: m.context_length || m.max_context_tokens || null }))
        .filter((m) => m.id);
      // 按 id 排序,并给当前配置模型打标记
      models.sort((a, b) => a.id.localeCompare(b.id));
      sendJson(res, { ok: true, models, current: String(qs.model || c.model || '') });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/coach/plans') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const sid = qs.session_id != null && qs.session_id !== '' ? Number(qs.session_id) : null;
      sendJson(res, { ok: true, plans: db.listPlans(sid) });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/weekly') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      await ensureLocalData();
      sendJson(res, { weekly: db.weekly(qs.start || null, qs.end || null) });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/trip/weather') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      sendJson(res, await tripWeather(qs));
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/trip/trains') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      sendJson(res, await tripTrains(qs, DATA_DIR));
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/trip/destinations') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    sendJson(res, { ok: true, destinations: TRIP_DESTINATIONS });
    return;
  }
  if (rawPath === '/api/trip/geocode') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      sendJson(res, await tripGeocode(qs));
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/trip/routeweather') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      sendJson(res, await tripRouteWeather(qs));
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/powercurve') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const cfg = loadConfig();
      const intAthlete = cfg.intervals_athlete_id || 'i221776';
      const intKey = cfg.intervals_api_key || '7exid4luvhfgylhvfhpa94ull';
      let intList = null;
      if (intAthlete && intKey) {
        try { intList = await fetchIntervalsCurves(intAthlete, intKey); } catch (e) {}
      }

      if (intList && intList.length) {
        const byId = {};
        let weight = 73;
        for (const c of intList) {
          byId[c.id] = { durations: c.secs || [], watts: c.watts || [], eftp: c.eftp };
          if (c.weight) weight = c.weight;
        }
        let curKey = 'all';
        if (qs.range === '42d' || qs.range === '7d' || qs.range === '1m' || qs.range === '3m' || qs.range === '6m') curKey = '42d';
        else if (qs.range === '1y' || qs.range === 'ytd' || qs.range === '12m') curKey = '1y';

        const curve = byId[curKey] || byId['all'] || byId[intList[0].id];
        const all = byId['all'] || curve;
        sendJson(res, {
          source: 'intervals',
          weight,
          curve,
          all,
          unit: 'W',
          range: qs.range || 'all'
        });
        return;
      }

      await ensureLocalData();
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const dAgo = (days) => { const d = new Date(now); d.setDate(d.getDate() - days); return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`; };
      const rangeMap = {
        '7d': dAgo(7), '1m': dAgo(30), '3m': dAgo(90),
        '6m': dAgo(182), 'ytd': `${now.getFullYear()}-01-01`, '12m': dAgo(365),
      };
      const start = qs.start || (rangeMap[qs.range] || null);
      const end = qs.end || null;
      // 功率曲线仅骑行（本工具的生理衰减模型与 W/kg 换算都基于骑行语义）
      const curve = db.powerCurve(start, end);
      const all = db.powerCurve(null, null);
      sendJson(res, { source: 'local', weight: 73, curve, all, unit: 'W', range: qs.range || 'all' });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/activities') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      await ensureLocalData();
      // type 支持逗号分隔多类型（如 Run,TrailRun）；单类型/缺省行为不变
      const tRaw = String(qs.type || '').trim();
      const typeArg = tRaw ? tRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
      const acts = db.getActivities(typeArg && typeArg.length === 1 ? typeArg[0] : typeArg, strictInt(qs.limit, 50), qs.start || null, qs.end || null);
      sendJson(res, { activities: acts, count: acts.length });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/sync') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const tok = await requireStravaToken(res);
    if (!tok) return;
    try {
      const mode = qs.mode === 'full' ? 'full' : 'incremental';
      const result = await syncSerial(() => syncFromStrava(tok, 20, mode));
      sendJson(res, { ok: true, ...result });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/export') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      await ensureLocalData();
      const acts = db.getActivities(null, 100000);
      const fmt = qs.fmt || 'json';
      if (fmt === 'csv') {
        // celle 值按 Python str() 规则转文本 (None→'None', float→repr 格式), 再按 csv 规则转义
        const esc = (v) => {
          const s = pyStr(v);
          return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const rows = [['id', 'name', 'type', 'distance_km', 'moving_time_s', 'elevation_m', 'start_date']];
        for (const a of acts) {
          rows.push([a.id, a.name, a.type,
            pyf(pyRound((a.distance instanceof PyFloat ? a.distance.v : (a.distance || 0)) / 1000, 2)),
            a.moving_time, a.total_elevation_gain, a.start_date]);
        }
        const body = Buffer.from(rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n', 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="strava.csv"',
          'Content-Length': body.length,
        });
        res.end(body);
      } else {
        sendJson(res, { activities: acts, count: acts.length });
      }
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/config') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const cfg = loadConfig();
    // 本地面板（API token 保护）允许回显已存凭据，供设置页回填、免每次重输。
    // client_secret 仅在本机/局域网面板内返回（Bearer api_token 校验后）。
    sendJson(res, {
      client_id: cfg.client_id || '',
      client_secret: cfg.client_secret || '',
      redirect_uri: cfg.redirect_uri || '',
      configured: hasCredentials(),
      has_token: Boolean(cfg.refresh_token || ''),
      athlete_id: cfg.athlete_id || '',
      auto_sync: String(cfg.auto_sync || '0') === '1',
      auto_sync_hours: Number(cfg.auto_sync_hours) > 0 ? Number(cfg.auto_sync_hours) : 24,
      last_sync: db.getMeta('last_sync') || '',
      intervals_athlete_id: cfg.intervals_athlete_id || 'i221776',
      intervals_api_key: cfg.intervals_api_key || '',
      coach_sports: cfg.coach_sports || 'Ride',
      coach_times: cfg.coach_times || '',
      coach_home_city: cfg.coach_home_city || '',
    });
    return;
  }
  if (rawPath === '/api/info') {
    // 服务状态（含版本/端口/api_token，供仪表板）
    if (!requireApiToken(req, res, qs, rawPath)) return;
    sendJson(res, await getServiceInfo());
    return;
  }
  if (rawPath === '/api/sync/progress') {
    // 同步进度（前端轮询）
    if (!requireApiToken(req, res, qs, rawPath)) return;
    sendJson(res, SYNC_PROGRESS);
    return;
  }
  if (rawPath === '/api/token/view') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    sendJson(res, { api_token: getOrCreateApiToken() });
    return;
  }
  if (rawPath === '/api/oauth/start') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    // 用请求实际 Host 推导回调地址（否则可能落到 localhost 导致授权后 code 回不来）
    const reqHost = req.headers.host || '';
    const [url, redirectUri] = buildOauthUrl(reqHost);
    if (!url) sendJson(res, { error: redirectUri }, 400);
    else sendJson(res, { url, redirect_uri: redirectUri });
    return;
  }
  if (rawPath === '/api/doc') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const lang = ['zh', 'en'].includes(qs.lang) ? qs.lang : 'zh';
    sendJson(res, { doc: buildApiDoc(lang, req.headers.host || '') });
    return;
  }
  if (rawPath === '/api/logs/list') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    let name = qs.source || 'strava';
    if (!(name in LOG_SOURCES)) name = 'strava';
    sendJson(res, {
      sources: Object.keys(LOG_SOURCES),
      dates: listLogDates(name),
      current: archiveDate()[0],
    });
    return;
  }
  if (rawPath === '/api/logs') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    let name = qs.source || 'strava';
    if (!(name in LOG_SOURCES)) name = 'strava';
    const date = qs.date || null;
    let tail;
    try { tail = strictInt(qs.tail, 500); } catch { tail = 500; }
    sendJson(res, readLogs(name, date, tail));
    return;
  }
  if (rawPath === '/api/logs/download') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    let name = qs.source || 'strava';
    if (!(name in LOG_SOURCES)) name = 'strava';
    const date = qs.date || null;
    const result = readLogs(name, date, 0);
    let fname = 'strava.log';
    if (date) fname = `strava.log.${String(date).replace(/-/g, '')}`;
    const body = Buffer.from(result.content || '', 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Content-Length': body.length,
    });
    res.end(body);
    return;
  }
  if (rawPath === '/' || rawPath === '') {
    sendFile(res, 'index.html');
    return;
  }
  if (rawPath.startsWith('/static/')) {
    sendFile(res, rawPath.slice('/static/'.length));
    return;
  }
  sendError404(res);
}

async function handlePost(req, res, rawPath, qs) {
  if (rawPath === '/api/config') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const data = JSON.parse(await readBody(req));
      // redirect_uri 必须是绝对 URL(http/https)，拒绝残缺的相对路径(如 /oauth/callback)
      // 否则 Strava 授权直接报错。
      if (data.redirect_uri) {
        const ru = String(data.redirect_uri).trim();
        if (!ru.startsWith('http://') && !ru.startsWith('https://')) {
          sendJson(res, { error: '回调地址必须是完整 URL(以 http:// 或 https:// 开头)，例如 http://localhost:20227/oauth/callback' }, 400);
          return;
        }
        data.redirect_uri = ru;
      }
      await syncSerial(async () => {
        const cfg = loadConfig();
        for (const k of ['client_id', 'client_secret', 'refresh_token', 'redirect_uri', 'intervals_athlete_id', 'intervals_api_key', 'coach_sports', 'coach_times', 'coach_home_city']) {
          if (data[k] !== undefined) cfg[k] = String(data[k]).trim();
        }
        saveConfig(cfg);
      });
      const [tok, err] = await getAccessToken();
      // 有凭据且有 token 时自动同步一次
      if (tok) {
        try { await syncFromStrava(tok); } catch { /* 同步失败不影响保存结果 */ }
      }
      // 保存成功即返回 ok（未拿到 token 时 err 提示 token 状态）
      sendJson(res, { ok: true, token_ok: Boolean(tok), error: err });
      return;
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
      return;
    }
  }
  if (rawPath === '/api/llm/config') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const data = JSON.parse(await readBody(req));
      await syncSerial(() => {
        const cfg = loadConfig();
        if ('llm_base_url' in data) cfg.llm_base_url = String(data.llm_base_url || '').trim();
        if ('llm_model' in data) cfg.llm_model = String(data.llm_model || '').trim();
        // api_key 传空字符串表示保持不变;传 __CLEAR__ 清空
        if (data.llm_api_key && data.llm_api_key !== '__KEEP__') {
          cfg.llm_api_key = data.llm_api_key === '__CLEAR__' ? '' : String(data.llm_api_key).trim();
        }
        // 模型库(卡片):[{id,short,context,alias}] 整体覆盖保存
        if ('llm_models' in data) {
          const arr = Array.isArray(data.llm_models) ? data.llm_models : [];
          const norm = arr.filter((m) => m && m.id).slice(0, 50).map((m) => ({
            id: String(m.id).trim(),
            short: String(m.short || modelShort(m.id)).trim(),
            context: Number(m.context) || null,
            alias: String(m.alias || '').trim().slice(0, 40),
          }));
          cfg.llm_models = JSON.stringify(norm);
        }
        saveConfig(cfg);
      });
      const c = llmConfig();
      sendJson(res, { ok: true, configured: c.configured, base_url: c.baseUrl, model: c.model, has_key: Boolean(c.apiKey), models: parseLlmModels(loadConfig()) });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/coach/test') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const c = llmConfig();
    if (!c.configured) { sendJson(res, { ok: false, error: '请先配置 API 地址与模型' }, 400); return; }
    try {
      const reply = await callLlm(c, [{ role: 'user', content: 'Reply with exactly: OK' }], 20000);
      sendJson(res, { ok: true, reply: reply.slice(0, 80) });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/coach/chat') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const c = llmConfig();
    if (!c.configured) { sendJson(res, { error: '尚未配置模型:请到 设置 → 模型 填写 API 地址与模型名' }, 400); return; }
    try {
      const data = JSON.parse(await readBody(req));
      const msg = String(data.message || '').trim();
      if (!msg) { sendJson(res, { error: '消息为空' }, 400); return; }
      // 会话:sid 缺省时新建;模型名允许会话级覆盖(网关拉列表后点选)
      const sid = db.ensureSession(data.session_id);
      const lang = data.lang === 'en' ? 'en' : 'zh';
      db.addMemory('user', msg, sid);
      const history = db.getMemory(40, sid);
      // 模型优先级:请求显式 model > 会话级 model(设置页配置) > 已保存默认配置
      const sessRow = db.db.prepare('SELECT model FROM coach_sessions WHERE id=?').get(sid);
      const modelId = String(data.model || '').trim() || (sessRow && sessRow.model ? sessRow.model : '');
      // 组消息:系统提示(含训练摘要+运动方式约束) + 历史对话(去掉刚写入又重复的最后一条由 history 天然包含)
      const messages = [{ role: 'system', content: COACH_SYSTEM(buildTrainingDigest(), lang, new Date(), coachSports()) }];
      for (const m of history.slice(0, -1)) messages.push({ role: m.role, content: m.content });
      messages.push({ role: 'user', content: msg });
      const useCfg = modelId ? { ...c, model: modelId } : c;
      const reply = await callLlm(useCfg, messages);
      db.addMemory('assistant', reply, sid);
      sendJson(res, { ok: true, reply, session_id: sid, sessions: db.listSessions() });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 502);
    }
    return;
  }
  if (rawPath === '/api/coach/clear') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const data = await readBody(req).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
      const sid = data.session_id != null ? Number(data.session_id) : null;
      sendJson(res, { ok: true, cleared: db.clearMemory(sid), sessions: db.listSessions() });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/sync') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    const [tok, err] = await getAccessToken();
    if (!tok) { sendJson(res, { error: err || '未配置' }, 400); return; }
    try {
      const mode = qs.mode === 'full' ? 'full' : 'incremental';
      const result = await syncSerial(() => syncFromStrava(tok, 20, mode));
      sendJson(res, { ok: true, ...result });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/autosync') {
    // 自动同步配置:{auto_sync:bool, auto_sync_hours:number}
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const data = JSON.parse(await readBody(req));
      await syncSerial(() => {
        const cfg = loadConfig();
        if ('auto_sync' in data) cfg.auto_sync = data.auto_sync ? '1' : '0';
        if ('auto_sync_hours' in data) {
          const h = Number(data.auto_sync_hours);
          cfg.auto_sync_hours = String(AUTO_SYNC_HOURS.includes(h) ? h : 24);
        }
        saveConfig(cfg);
      });
      applyAutoSync();
      const st = autoSyncState();
      sendJson(res, { ok: true, auto_sync: st.on, auto_sync_hours: st.hours, last_sync: db.getMeta('last_sync') || '' });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/coach/session') {
    // 会话管理:重命名 {session_id, title} / 删除 DELETE {session_id}
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const data = JSON.parse(await readBody(req));
      const sid = Number(data.session_id);
      if (!sid) { sendJson(res, { error: '缺少 session_id' }, 400); return; }
      if (req.method === 'DELETE') {
        const deleted = db.deleteSession(sid);
        sendJson(res, { ok: true, session_id: sid, deleted, sessions: db.listSessions() });
        return;
      }
      const title = db.renameSession(sid, data.title);
      sendJson(res, { ok: true, session_id: sid, title, sessions: db.listSessions() });
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/coach/plans') {
    if (!requireApiToken(req, res, qs, rawPath)) return;
    try {
      const data = await readBody(req).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
      if (req.method === 'GET') {
        const sid = qs.session_id != null ? Number(qs.session_id) : null;
        sendJson(res, { ok: true, plans: db.listPlans(sid) });
      } else if (req.method === 'POST') {
        const sid = data.session_id != null ? Number(data.session_id) : 0;
        if (Array.isArray(data.items) && data.items.length) {
          const added = db.addPlansBatch(sid, data.items);
          sendJson(res, { ok: true, added, plans: db.listPlans(sid) });
        } else {
          const date = String(data.date || '');
          const content = String(data.content || '');
          if (!date || !content) { sendJson(res, { error: '缺少 date 或 content' }, 400); return; }
          const id = db.addPlan(sid, date, content, data.status || 'planned');
          sendJson(res, { ok: true, id, plans: db.listPlans(sid) });
        }
      } else if (req.method === 'DELETE') {
        const id = Number(data.id || qs.id);
        if (!id) { sendJson(res, { error: '缺少 id' }, 400); return; }
        db.deletePlan(id);
        sendJson(res, { ok: true, plans: db.listPlans(data.session_id != null ? Number(data.session_id) : null) });
      } else if (req.method === 'PUT') {
        const id = Number(data.id);
        if (!id) { sendJson(res, { error: '缺少 id' }, 400); return; }
        db.updatePlan(id, data.content, data.status || 'planned');
        sendJson(res, { ok: true, plans: db.listPlans(data.session_id != null ? Number(data.session_id) : null) });
      }
    } catch (e) {
      sendJson(res, { error: String(e.message || e) }, 500);
    }
    return;
  }
  if (rawPath === '/api/token/recreate') {
    // 重新生成 API token（立即生效）
    if (!requireApiToken(req, res, qs, rawPath)) return;
    sendJson(res, { ok: true, api_token: recreateApiToken() });
    return;
  }
  sendError404(res);
}

// ---------- 自动同步 ----------
// 周期由 strava.conf 的 auto_sync / auto_sync_hours 控制(设置页配置)。
// 每 60s 心跳一次:开关开启且距 last_sync 超过周期 → 触发一次增量同步。
// 复用 syncSerial 队列,与手动同步互斥;SYNC_PROGRESS.running 时跳过本轮。
const AUTO_SYNC_HOURS = [6, 12, 24, 48, 72];
let _autoSyncTimer = null;
function autoSyncState() {
  const cfg = loadConfig();
  const hours = AUTO_SYNC_HOURS.includes(Number(cfg.auto_sync_hours)) ? Number(cfg.auto_sync_hours) : 24;
  return { on: String(cfg.auto_sync || '0') === '1', hours };
}
function applyAutoSync() {
  if (_autoSyncTimer) { clearInterval(_autoSyncTimer); _autoSyncTimer = null; }
  if (!autoSyncState().on) return;
  _autoSyncTimer = setInterval(() => { autoSyncTick().catch(() => {}); }, 60000);
  if (_autoSyncTimer.unref) _autoSyncTimer.unref();
}
async function autoSyncTick() {
  try {
    const { on, hours } = autoSyncState();
    if (!on || SYNC_PROGRESS.running || !hasCredentials()) return;
    const last = db.getMeta('last_sync');
    const lastTs = last ? Date.parse(String(last).replace(' ', 'T')) : NaN;
    if (Number.isFinite(lastTs) && Date.now() - lastTs < hours * 3600000) return;
    const [tok] = await getAccessToken();
    if (!tok) return;
    log('system', `自动同步触发(周期 ${hours}h)`);
    const r = await syncSerial(() => syncFromStrava(tok, 20, 'incremental'));
    log('system', `自动同步完成:新增 ${r.new} / 共 ${r.activities}`);
  } catch (e) {
    log('system', `自动同步失败:${e.message || e}`);
  }
}

async function main() {
  const port = parseInt(PORT, 10);
  // 启动时归档非当天的日志
  archiveLogs();
  log('system', `Strava Panel 启动 (v${APP_VERSION || '?'}, port=${port}, data=${DATA_DIR})`);

  const server = http.createServer((req, res) => {
    const rawPath = rawPathOf(req.url || '/');
    const qs = getQs(req.url || '');
    (async () => {
      if (req.method === 'GET') return handleGet(req, res, rawPath, qs);
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) return handlePost(req, res, rawPath, qs);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }
      sendError404(res);
    })().catch((e) => {
      if (!res.headersSent) sendJson(res, { error: String(e.message || e) }, 500);
      else res.end();
    });
  });
  // TCP backlog / keep-alive 默认值即可; Node 的 listen 自动处理 SO_REUSEAddr
  await new Promise((resolve) => server.listen(port, BIND_HOST, resolve));
  applyAutoSync();
  const as = autoSyncState();
  if (as.on) log('system', `自动同步已启用(每 ${as.hours}h)`);
  console.log(`Strava Panel listening on ${port}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`DB: ${DB_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
