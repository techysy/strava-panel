#!/usr/bin/env python3
"""
Strava Panel — fnOS 后端服务 (零依赖, 纯标准库)
凭据管理 + Token 自动刷新 + SQLite 本地缓存 + 骑行数据 API

数据目录结构 (TRIM_PKGVAR / 或 --data):
  strava.conf           # client_id / client_secret / refresh_token / api_token
  strava_tokens.json    # 缓存的 access_token (自动刷新)
  strava.db             # SQLite 缓存 (activities 表)
  strava.log            # 应用运行日志 (cmd/main 重定向), 按日期归档到 logs/

API (除 bootstrap/status 外均需 Authorization: Bearer <api_token>):
  GET  /api/bootstrap     # 免认证: 返回 api_token
  GET  /api/status        # 免认证: 凭据/授权/缓存状态
  GET  /api/info          # 服务状态 (版本/端口/数据统计/api_token)
  GET  /api/config        # 读取非敏感配置
  POST /api/config        # 保存凭据 (JSON)
  GET  /api/stats         # 骑行统计 (读 SQLite 缓存，快)
  GET  /api/weekly        # 每周聚合
  GET  /api/activities    # 最近活动列表 (读缓存)
  GET  /api/sync          # 手动触发 Strava→SQLite 同步
  POST /api/sync          # 同上 (POST)
  GET  /api/export?fmt=json|csv   # 导出全量数据 (给 agent)
  GET  /api/token/view    # 查看当前 api_token
  POST /api/token/recreate # 重新生成 api_token
  GET  /api/doc?lang=zh|en # API 使用指南 (Markdown)
  GET  /api/logs/list     # 日志来源/可查看日期
  GET  /api/logs          # 读取日志 (source/date/tail)
  GET  /api/logs/download # 下载日志
  GET  /                  # 前端面板
"""
import csv
import io
import json
import os
import re
import sys
import time
import secrets
import urllib.request
import urllib.parse
import threading
import http.server
import socketserver
import datetime
from pathlib import Path
from db import StravaDB

STRAVA_AUTH_URL = "https://www.strava.com/oauth/token"
STRAVA_API = "https://www.strava.com/api/v3"
API_HEADERS = {"Accept": "application/json"}

# 环境变量优先级:SP_PORT/SP_DATA_DIR/SP_HOST(全平台专用名)> PORT/DATA_DIR(fnOS cmd/main 兼容)> 默认值。
# SP_* 前缀避免与系统里常见的通用变量(PORT 等)冲突,桌面壳/CLI/Docker 统一注入 SP_*。
# 默认绑定 127.0.0.1:纯本机访问(桌面/CLI)免 Windows 防火墙弹窗;fnOS cmd/main 与
# Dockerfile 显式传 SP_HOST=0.0.0.0 供局域网访问。面板展示统一走 localhost(回调域名匹配)。
PORT = os.environ.get("SP_PORT") or os.environ.get("PORT") or "20227"
BIND_HOST = os.environ.get("SP_HOST", "127.0.0.1")
DATA_DIR = Path(os.environ.get("SP_DATA_DIR") or os.environ.get("DATA_DIR") or "/tmp/strava-data")
CONF_FILE = DATA_DIR / "strava.conf"
TOKEN_FILE = DATA_DIR / "strava_tokens.json"
DB_FILE = DATA_DIR / "strava.db"
WWW_DIR = Path(__file__).parent.parent / "www"

_lock = threading.Lock()
# token/config 的读改写串行锁（可重入）：exchange 授权写 token 与 /api/info 轮询触发的
# refresh 并发时，轮询的旧 refresh_token 刷新会覆盖 exchange 刚写入的正确 token。
# 用 RLock 串行化，避免授权成功瞬间被并发刷新踩掉。
_token_lock = threading.RLock()
db = StravaDB(DB_FILE)


def _app_version():
    """动态读取应用版本（单一来源 VERSION 文件，fallback 到已安装 manifest）.

    优先读 `app/server/VERSION`（打包随源码带），读不到再读已安装 manifest 的 version。
    """
    # 1) 优先：打包的 VERSION 文件（单一来源，改这一处即可）
    try:
        vfile = Path(__file__).resolve().parent / "VERSION"
        if vfile.exists():
            v = vfile.read_text(encoding="utf-8").strip()
            if v:
                return v
    except (OSError, IOError):
        pass
    # 2) fallback：已安装 manifest
    candidates = [
        "/var/apps/strava/manifest",
        "/vol4/@appcenter/strava/manifest",
    ]
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("version") and "=" in line:
                        return line.split("=", 1)[1].strip()
        except (OSError, IOError):
            continue
    return ""


APP_VERSION = _app_version()


# ---------- 配置 ----------
def load_config():
    cfg = {}
    if CONF_FILE.exists():
        for line in CONF_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


def save_config(cfg):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    lines = [
        f"client_id={cfg.get('client_id','')}",
        f"client_secret={cfg.get('client_secret','')}",
        f"refresh_token={cfg.get('refresh_token','')}",
        f"athlete_id={cfg.get('athlete_id','')}",
        f"api_token={cfg.get('api_token','')}",
        f"oauth_state={cfg.get('oauth_state','')}",
        f"redirect_uri={cfg.get('redirect_uri','')}",
    ]
    CONF_FILE.write_text("\n".join(lines) + "\n")
    os.chmod(CONF_FILE, 0o600)  # 权限 600，仅属主可读
    # 仅当 refresh_token 实际变更时才清掉缓存的 access_token（凭据变了旧 token 作废）。
    # 不能无条件删——exchange/refresh 是"先 save 后写新 token"，若无条件删会误删刚换来的 token。
    try:
        if TOKEN_FILE.exists():
            cur_rt = cfg.get("refresh_token", "").strip()
            cached = json.loads(TOKEN_FILE.read_text()).get("refresh_token", "").strip()
            if cur_rt and cached and cur_rt != cached:
                TOKEN_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def has_credentials():
    cfg = load_config()
    return bool(cfg.get("client_id") and cfg.get("client_secret") and cfg.get("refresh_token"))


# ---------- API Token 保护 ----------
def get_or_create_api_token():
    """获取/生成 API 访问 token（存 strava.conf 的 api_token 字段）"""
    cfg = load_config()
    tok = cfg.get("api_token", "").strip()
    if not tok:
        tok = secrets.token_urlsafe(32)
        cfg["api_token"] = tok
        save_config(cfg)
    return tok


def api_token_valid(token):
    """校验 API token"""
    if not token:
        return False
    cfg = load_config()
    expected = cfg.get("api_token", "")
    return token == expected


def recreate_api_token():
    """重新生成 API token（写入 strava.conf，立即生效）."""
    cfg = load_config()
    new = secrets.token_urlsafe(32)
    cfg["api_token"] = new
    save_config(cfg)
    return new


# ---------- Strava OAuth 授权 ----------
OAUTH_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
OAUTH_SCOPE = "read,activity:read_all"
# 拉取骑行活动所需的最低 scope（缺它 /athlete/activities 会 401，面板同步必失败）
REQUIRED_SCOPE = "activity:read_all"


def _scope_has_activity(scope):
    """scope 是否含 activity:read_all。

    Strava scope 可能逗号分隔('read,activity:read_all')或空格分隔('activity:read_all read')
    (官方文档: comma- or URL-safe space-delimited)。两种都要处理，避免误判缺权限。
    """
    if not scope:
        return False
    tokens = [t for part in str(scope).replace(",", " ").split() for t in part.split(",") if t.strip()]
    return "activity:read_all" in tokens


def _is_private_host(host):
    """判断 host(含端口) 是否为内网/本机地址。公网中转域名(如 office.app.5ddd.com)不算，
    不能用来推导 OAuth 回调(Strava 回调需落在可注册的真实地址)。"""
    h = (host or "").split(":")[0].strip().lower()
    if not h or h == "localhost" or h.startswith("127."):
        return True
    parts = h.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        a, b = int(parts[0]), int(parts[1])
        return a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)
    return False  # 域名(含中转/公网)一律不自动推导


def get_redirect_uri(request_host=None):
    """回调地址：优先用配置的；否则仅当请求来自内网/本机时才按 Host 推导，
    公网中转域名(office.app.5ddd.com 等)绝不推导成回调(会拉错/无法在 Strava 注册)。

    需在 Strava API 设置注册完全一致的地址(如 http://localhost:20227/oauth/callback)。
    request_host 形如 'localhost:20227'(来自 HTTP Host 头)，未带 scheme。
    """
    cfg = load_config()
    uri = cfg.get("redirect_uri", "").strip()
    if uri:
        return uri
    # 仅内网/本机 Host 才自动推导；公网中转域名返回空(交由前端引导用户显式配置)
    if request_host and _is_private_host(request_host):
        rh = request_host.strip()
        if rh and "://" not in rh:
            return f"http://{rh}/oauth/callback"
    host = os.environ.get("NAS_IP", "")
    if host and _is_private_host(host):
        return f"http://{host}:{int(os.environ.get('PORT', '20227'))}/oauth/callback"
    return ""


def build_oauth_url(request_host=None):
    """生成 Strava OAuth 授权 URL，并保存 state 供回调校验."""
    cfg = load_config()
    client_id = cfg.get("client_id", "").strip()
    if not client_id:
        return None, "请先填写 Client ID"
    state = secrets.token_urlsafe(16)
    cfg["oauth_state"] = state
    save_config(cfg)
    redirect_uri = get_redirect_uri(request_host)
    if not redirect_uri:
        # 未配置回调 且 请求来自公网中转域名(无法推导) → 提示用户显式配置
        return None, "未配置回调地址(redirect_uri)；且当前经公网中转访问无法自动推导。请在设置页手动填写 Strava 注册的回调地址，如 http://localhost:20227/oauth/callback(域名需与 Strava 注册的 Callback Domain 完全一致)"
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "approval_prompt": "force",
        "scope": OAUTH_SCOPE,
        "state": state,
    })
    return f"{OAUTH_AUTHORIZE_URL}?{params}", redirect_uri


def exchange_code(code):
    """用 authorization code 换 access_token + refresh_token，保存凭据."""
    with _token_lock:  # 串行化：避免与轮询 refresh 并发覆盖
        cfg = load_config()
        data = urllib.parse.urlencode({
            "client_id": cfg.get("client_id", ""),
            "client_secret": cfg.get("client_secret", ""),
            "code": code,
            "grant_type": "authorization_code",
        }).encode()
        req = urllib.request.Request(STRAVA_AUTH_URL, data=data, method="POST")
        _log("strava", f"POST /oauth/token (authorization_code exchange)")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                r = json.loads(resp.read().decode())
        except Exception as e:
            # 抓取 Strava 拒绝 exchange 的具体原因(HTTP body)，供日志排查
            body = ""
            if hasattr(e, "read"):
                try:
                    body = e.read().decode("utf-8", "ignore")[:300]
                except Exception:
                    pass
            _log("strava", f"exchange_code 失败: {e} | body={body}")
            raise
        # 诊断：记录 Strava 返回的实际内容(关键字段脱敏)，确认 scope/refresh_token/athlete
        _log("strava",
             f"exchange 返回: scope={r.get('scope')} "
             f"athlete_id={str(r.get('athlete', {}).get('id','')) if isinstance(r.get('athlete'),dict) else ''} "
             f"refresh_token前8={str(r.get('refresh_token',''))[:8]} "
             f"有新refresh={bool(r.get('refresh_token'))}")
        cfg["refresh_token"] = r.get("refresh_token", "")
        if r.get("athlete"):
            cfg["athlete_id"] = str(r["athlete"].get("id", ""))
        cfg["oauth_state"] = ""
        save_config(cfg)
        # 保存 access token
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tok = {
            "access_token": r["access_token"],
            "refresh_token": r.get("refresh_token", ""),
            "scope": r.get("scope", ""),
            "expires_at": r.get("expires_at"),
        }
        TOKEN_FILE.write_text(json.dumps(tok))
        os.chmod(TOKEN_FILE, 0o600)
        return True, None


# ---------- Strava token ----------
def refresh_token(cfg):
    data = urllib.parse.urlencode({
        "client_id": cfg.get("client_id", ""),
        "client_secret": cfg.get("client_secret", ""),
        "grant_type": "refresh_token",
        "refresh_token": cfg.get("refresh_token", ""),
    }).encode()
    req = urllib.request.Request(STRAVA_AUTH_URL, data=data, method="POST")
    _log("strava", "POST /oauth/token (refresh_token)")
    with urllib.request.urlopen(req, timeout=20) as resp:
        r = json.loads(resp.read().decode())
    # ⚠️ 同样必须先 save_config 再写 token 文件（save_config 会删 tokens.json）
    #   否则刷新成功的 token 也被随即删掉，缓存永远不存在 → 每次都重新刷新
    if r.get("refresh_token"):
        cfg["refresh_token"] = r["refresh_token"]
        save_config(cfg)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tok = {
        "access_token": r["access_token"],
        "refresh_token": r.get("refresh_token", cfg.get("refresh_token", "")),
        "scope": r.get("scope", ""),
        "expires_at": r.get("expires_at"),
    }
    TOKEN_FILE.write_text(json.dumps(tok))
    os.chmod(TOKEN_FILE, 0o600)
    return r["access_token"], r.get("scope", "")


def _scope_err(scope):
    """token 缺活动权限时的错误描述，用于状态提示而非直接当刷新失败."""
    return f"scope 缺 {REQUIRED_SCOPE}（当前: {scope or '无'}），需重新 OAuth 授权"


def get_access_token():
    """返回 (access_token, error)。token 需同时：有效 + scope 含 activity:read_all。

    若能刷新但 scope 缺活动权限（历史上用只读 scope 授权），返回 (None, 明确提示)，
    状态不再误报为"正常"。
    """
    with _token_lock:  # 串行化：防止 /api/info 轮询并发 refresh 与 exchange 授权写互相踩
        cfg = load_config()
        if not has_credentials():
            return None, "未配置凭据"
        # 1) 优先用缓存 token —— 仅当它未过期且含活动 scope 才直接复用
        if TOKEN_FILE.exists():
            try:
                tok = json.loads(TOKEN_FILE.read_text())
                exp = tok.get("expires_at")
                if (exp and exp > int(time.time()) + 300
                        and tok.get("access_token")
                        and _scope_has_activity(tok.get("scope", ""))):
                    return tok["access_token"], None
                # 缓存缺失/过期/缺活动 scope 时，落到下面刷新，看能否拿到正确 scope
            except Exception:
                pass
        # 2) 否则刷新；刷新返回的 token 必须含活动 scope，否则视为不可用
        try:
            token, scope = refresh_token(cfg)
            if not _scope_has_activity(scope):
                return None, _scope_err(scope)
            return token, None
        except Exception as e:
            return None, f"刷新失败: {e}"


# ---------- Strava API ----------
def _api_get(token, path, params=None):
    url = f"{STRAVA_API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={**API_HEADERS, "Authorization": f"Bearer {token}"})
    _log("strava", f"GET {path} params={params or ''}")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
            return data
    except Exception as e:
        _log("strava", f"GET {path} 失败: {e}")
        raise


def get_activities_page(token, page=1, per_page=100, after=None):
    params = {"per_page": per_page, "page": page}
    if after:
        params["after"] = after
    return _api_get(token, "/athlete/activities", params)


# 同步进度（供前端轮询 /api/sync/progress）
SYNC_PROGRESS = {"running": False, "page": 0, "fetched": 0, "message": "", "done": False, "error": None}


def sync_from_strava(token, limit_pages=20):
    """全量/增量同步 Strava→SQLite。返回统计。同步期间更新 SYNC_PROGRESS 供前端轮询进度。"""
    SYNC_PROGRESS["running"] = True
    SYNC_PROGRESS["error"] = None
    SYNC_PROGRESS["message"] = "开始同步"
    all_acts = []
    page = 1
    try:
        while page <= limit_pages:
            acts = get_activities_page(token, page=page, per_page=100)
            SYNC_PROGRESS["page"] = page
            if not acts:
                break
            all_acts.extend(acts)
            SYNC_PROGRESS["fetched"] = len(all_acts)
            SYNC_PROGRESS["message"] = f"已拉取第 {page} 页 · {len(all_acts)} 条"
            _log("strava", f"同步进度: 第 {page} 页, 累计 {len(all_acts)} 条")
            # 增量：若已到已知的最新活动，跳过后续页（避免重复拉取全历史）
            if page == 1:
                last_sync = db.get_meta("last_sync")
                # last_sync 是时间戳，无法直接对比活动日期；简单起见全量拉取 limit_pages
            page += 1
            if page > 1 and len(acts) < 100:
                break
        SYNC_PROGRESS["message"] = "写入本地数据库"
        added = db.upsert_activities(all_acts)
        SYNC_PROGRESS["done"] = True
        SYNC_PROGRESS["message"] = f"完成 · 拉取 {len(all_acts)} 条, 新增 {added} 条"
        _log("system", f"同步完成: 拉取 {len(all_acts)} 条, 新增 {added} 条")
        return {"activities": len(all_acts), "new": added, "page": page - 1}
    except Exception as e:
        SYNC_PROGRESS["error"] = str(e)
        SYNC_PROGRESS["message"] = f"失败: {e}"
        raise
    finally:
        SYNC_PROGRESS["running"] = False


def ensure_local_data():
    """确保本地 DB 有数据：若为空则尝试从 Strava 同步（best-effort）。

    数据接口优先读本地 SQLite，只有本地为空时才尝试调 Strava。
    Strava token 失效/未配置时静默降级，不影响读本地缓存。
    返回 (ok, err)：ok 表示已保证本地有数据（或失败但可继续读本地）。
    """
    if db.count() > 0:
        return True, None
    try:
        tok, err = get_access_token()
        if not tok:
            return False, err or "未配置"
        sync_from_strava(tok)
        return True, None
    except Exception as e:
        return False, str(e)


# ---------- 服务状态 / 日志 ----------
LOG_ARCHIVE_DIR = DATA_DIR / "logs"
# 日志来源: 名称 -> 文件（三个源分开落库）
LOG_SOURCES = {
    "system": DATA_DIR / "system.log",        # 系统状态/初始化/本地SQLite/同步
    "strava": DATA_DIR / "strava-api.log",    # 请求 Strava API（token刷新/活动拉取）
    "agent": DATA_DIR / "agent.log",          # agent 外部调用拿数据
}
# 兼容旧日志文件名（旧 strava.log）
_LEGACY_LOG = DATA_DIR / "strava.log"


def _log(source, msg):
    """向指定日志源追加一行（带时间戳）。source 需在 LOG_SOURCES 中。"""
    path = LOG_SOURCES.get(source)
    if not path:
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass


def _archive_date():
    now = datetime.datetime.now()
    return now.strftime("%Y%m%d"), now.strftime("%Y-%m-%d")


def _fmt_date(compact):
    if len(compact) == 8:
        return f"{compact[:4]}-{compact[4:6]}-{compact[6:]}"
    return compact


def archive_logs():
    """启动时归档: 把非当天的日志文件滚到 LOG_ARCHIVE_DIR/strava.log.YYYYMMDD.

    规则: 当前日志文件若修改日期不是今天, 则归档 (移动) 到归档目录,
    并清空当前文件, 让新日志只记录当天. 避免单文件无限增长.
    """
    today_compact, _ = _archive_date()
    for name, path in LOG_SOURCES.items():
        try:
            if not path.exists():
                continue
            mtime = datetime.datetime.fromtimestamp(path.stat().st_mtime)
            mday = mtime.strftime("%Y%m%d")
            if mday == today_compact:
                continue
            LOG_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
            dest = LOG_ARCHIVE_DIR / f"{name}.log.{mday}"
            content = b""
            try:
                content = path.read_bytes()
            except OSError:
                content = b""
            if dest.exists():
                with dest.open("ab") as f:
                    f.write(content)
            else:
                dest.write_bytes(content)
            path.write_bytes(b"")
        except OSError:
            continue


def list_log_dates(name):
    """返回某日志来源可用的日期列表 (含归档 + 当前). 倒序."""
    dates = []
    base = LOG_SOURCES.get(name)
    if not base:
        return dates
    try:
        if LOG_ARCHIVE_DIR.exists():
            for f in LOG_ARCHIVE_DIR.glob(f"{name}.log.[0-9]*"):
                m = re.search(rf"{name}\.log\.(\d{{8}})$", f.name)
                if m:
                    d = m.group(1)
                    dates.append((d, _fmt_date(d)))
    except OSError:
        pass
    try:
        if base.exists() and base.stat().st_size > 0:
            dates.append(_archive_date())
    except OSError:
        pass
    seen = set()
    result = []
    for compact, disp in sorted(dates, key=lambda x: x[0], reverse=True):
        if compact not in seen:
            seen.add(compact)
            result.append({"date": compact, "display": disp})
    return result


def read_logs(name, date=None, tail=500):
    """读取日志内容. name: strava. date: YYYYMMDD 或 None(当前). tail: 返回最后 N 行."""
    base = LOG_SOURCES.get(name)
    if not base:
        return None
    target = base
    display = "当前"
    if date:
        compact = date.replace("-", "")
        target = LOG_ARCHIVE_DIR / f"{name}.log.{compact}"
        display = _fmt_date(compact)
    try:
        if not target.exists():
            return {"source": name, "date": date or "current", "display": display,
                    "total": 0, "content": ""}
        raw = target.read_text(encoding="utf-8", errors="replace")
        lines = raw.splitlines()
        if tail and tail > 0 and len(lines) > tail:
            lines = lines[-tail:]
        content = "\n".join(lines)
        return {
            "source": name,
            "date": date or "current",
            "display": display,
            "total": len(raw.splitlines()),
            "content": content,
        }
    except OSError as e:
        return {"source": name, "date": date or "current", "display": display,
                "total": 0, "content": f"读取日志失败: {e}"}


def get_service_info():
    """返回服务状态，分三组: strava (API 状态) / db (本地数据库状态) / agent (外部调用状态)."""
    cfg = load_config()
    tok, err = get_access_token()
    # 本地数据库文件信息
    db_size = DB_FILE.stat().st_size if DB_FILE.exists() else 0
    # agent 外部调用统计
    try:
        agent_count = int(db.get_meta("agent_call_count") or 0)
    except (TypeError, ValueError):
        agent_count = 0
    agent_last = db.get_meta("agent_last_call")
    return {
        # Strava API 状态
        "strava": {
            "configured": has_credentials(),
            "has_token": bool(tok),
            "token_error": err,
            "athlete_id": cfg.get("athlete_id"),
            "last_sync": db.get_meta("last_sync"),
        },
        # 本地数据库状态
        "db": {
            "activities": db.count(),
            "size_bytes": db_size,
            "path": str(DB_FILE),
        },
        # Agent 外部调用状态
        "agent": {
            "api_token": bool(get_or_create_api_token()),
            "call_count": agent_count,
            "last_call": agent_last,
        },
        # 通用
        "version": APP_VERSION or "",
        "port": int(os.environ.get("PORT", "20227")),
    }


def record_agent_call():
    """记录一次 agent 外部 API 调用（计数 + 最后调用时间），持久化到 DB meta."""
    try:
        n = 0
        try:
            n = int(db.get_meta("agent_call_count") or 0)
        except (TypeError, ValueError):
            n = 0
        db.set_meta("agent_call_count", str(n + 1))
        db.set_meta("agent_last_call", datetime.datetime.now().isoformat(timespec="seconds"))
    except Exception:
        pass


def build_api_doc(lang="zh", request_host=None):
    """生成 API 使用指南 Markdown 文档 (中/英).

    base 地址按实际请求 Host 动态生成(面板里复制出来即可直接用);
    拿不到 Host 时回落 http://localhost:20227。
    """
    base = f"http://{request_host}" if request_host else "http://localhost:20227"
    en = lang != "zh"
    if en:
        return (
            "# Strava Panel Admin API Guide\n\n"
            "> Port **20227**. All endpoints except `/api/bootstrap`/`/api/status` "
            "require `Authorization: Bearer <api_token>`. Get/create the token in the "
            "panel (Dashboard → Create Token, or Settings → API).\n\n"
            "## Endpoints\n\n"
            "```bash\n"
            f'BASE="{base}"\n'
            'export TOKEN="<your-token>"\n'
            'AUTH="Authorization: Bearer $TOKEN"\n'
            "\n"
            "# 1. Get token (no auth)\n"
            'curl -s "$BASE/api/bootstrap"\n'
            "\n"
            "# 2. Service status (no auth)\n"
            'curl -s "$BASE/api/status"\n'
            "\n"
            "# 3. Riding stats (date range optional)\n"
            'curl -s -H "$AUTH" "$BASE/api/stats?start=2026-01-01&end=2026-01-31"\n'
            "\n"
            "# 4. Weekly aggregation\n"
            'curl -s -H "$AUTH" "$BASE/api/weekly"\n'
            "\n"
            "# 5. Activities list (filter)\n"
            'curl -s -H "$AUTH" "$BASE/api/activities?type=Ride&limit=10"\n'
            "\n"
            "# 6. Trigger Strava→SQLite sync\n"
            'curl -s -H "$AUTH" "$BASE/api/sync"\n'
            "\n"
            "# 7. Export all data (json/csv)\n"
            'curl -s -H "$AUTH" "$BASE/api/export?fmt=json"\n'
            'curl -s -H "$AUTH" "$BASE/api/export?fmt=csv" -o strava.csv\n'
            "\n"
            "# 8. Logs (console)\n"
            'curl -s -H "$AUTH" "$BASE/api/logs/list?source=strava"\n'
            'curl -s -H "$AUTH" "$BASE/api/logs?source=strava&tail=200"\n'
            'curl -s -H "$AUTH" -o strava.log "$BASE/api/logs/download?source=strava"\n'
            "\n"
            "# 9. Token management\n"
            'curl -s -H "$AUTH" "$BASE/api/token/view"\n'
            'curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{}" "$BASE/api/token/recreate"\n'
            "\n"
            "# 10. This doc\n"
            'curl -s -H "$AUTH" "$BASE/api/doc"\n'
            "```\n\n"
            "> Parse JSON with `python3 -m json.tool` (no jq needed).\n"
        )
    return (
        "# Strava Panel 管理面板 API 指南\n\n"
        "> 面板端口 **20227**。除 `/api/bootstrap` 和 `/api/status` 外，所有接口需 "
        "`Authorization: Bearer <api_token>`。token 在面板「仪表板 → 创建 token」或「设置 → API」查看/生成。\n\n"
        "## 各接口\n\n"
        "```bash\n"
        f'BASE="{base}"\n'
        'export TOKEN="<your-token>"\n'
        'AUTH="Authorization: Bearer $TOKEN"\n'
        "\n"
        "# 1. 获取 token（免认证）\n"
        'curl -s "$BASE/api/bootstrap"\n'
        "\n"
        "# 2. 服务状态（免认证）\n"
        'curl -s "$BASE/api/status"\n'
        "\n"
        "# 3. 骑行统计（可带日期范围）\n"
        'curl -s -H "$AUTH" "$BASE/api/stats?start=2026-01-01&end=2026-01-31"\n'
        "\n"
        "# 4. 每周聚合\n"
        'curl -s -H "$AUTH" "$BASE/api/weekly"\n'
        "\n"
        "# 5. 活动列表（支持过滤）\n"
        'curl -s -H "$AUTH" "$BASE/api/activities?type=Ride&limit=10"\n'
        "\n"
        "# 6. 触发 Strava→SQLite 同步\n"
        'curl -s -H "$AUTH" "$BASE/api/sync"\n'
        "\n"
        "# 7. 导出全量数据（json/csv）\n"
        'curl -s -H "$AUTH" "$BASE/api/export?fmt=json"\n'
        'curl -s -H "$AUTH" "$BASE/api/export?fmt=csv" -o strava.csv\n'
        "\n"
        "# 8. 日志（控制台）\n"
        'curl -s -H "$AUTH" "$BASE/api/logs/list?source=strava"\n'
        'curl -s -H "$AUTH" "$BASE/api/logs?source=strava&tail=200"\n'
        'curl -s -H "$AUTH" -o strava.log "$BASE/api/logs/download?source=strava"\n'
        "\n"
        "# 9. token 管理\n"
        'curl -s -H "$AUTH" "$BASE/api/token/view"\n'
        'curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{}" "$BASE/api/token/recreate"\n'
        "\n"
        "# 10. 本指南\n"
        'curl -s -H "$AUTH" "$BASE/api/doc"\n'
        "```\n\n"
        "> 解析 JSON 用 `python3 -m json.tool`（无需 jq）。\n"
    )



# ---------- HTTP server ----------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, rel):
        p = (WWW_DIR / rel).resolve()
        if not str(p).startswith(str(WWW_DIR.resolve())) or not p.exists():
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }.get(p.suffix, "application/octet-stream")
        body = p.read_bytes()
        # 对 index.html 注入版本号 (替换 __APP_VERSION__ 占位符，读不到时用兜底值，避免残留占位符)
        if rel == "index.html":
            ver = (APP_VERSION or "").encode("utf-8")
            body = body.replace(b"__APP_VERSION__", ver)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length).decode() if length else ""

    def _get_qs(self):
        return {k: v[0] for k, v in urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query).items()}

    def _require_token(self):
        tok, err = get_access_token()
        if not tok:
            self._send_json({"error": err or "未配置"}, 400)
            return None, err
        return tok, None

    def _require_api_token(self):
        """校验 API 访问 token（数据接口保护）。返回是否通过。"""
        # 从 Authorization header 或 ?token= 参数读取
        token = None
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        if not token:
            token = self._get_qs().get("token")
        if not api_token_valid(token):
            self._send_json({"error": "无效的 API token，请使用 Authorization: Bearer ***"}, 401)
            return False
        # 记录一次 agent 外部调用（计数 + 最后调用时间 + 日志）
        record_agent_call()
        _log("agent", f"agent 调用 {urllib.parse.urlparse(self.path).path}")
        return True

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        qs = self._get_qs()
        # Strava OAuth 回调（免认证：Strava 授权后重定向到这里）
        if path == "/oauth/callback":
            code = qs.get("code", "")
            state = qs.get("state", "")
            cfg = load_config()
            ok = False
            err = ""
            if not code:
                err = "缺少授权 code"
            elif not state or state != cfg.get("oauth_state", ""):
                err = "state 校验失败（授权已过期或来自未知请求）"
            else:
                try:
                    ok, err = exchange_code(code)
                except Exception as e:
                    err = str(e)
            # 返回一个简单的成功/失败页，可自动关闭
            if ok:
                body = (f"<html><body style='font-family:sans-serif;text-align:center;padding-top:60px;background:#fff'>"
                        f"<div style='max-width:420px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:14px'>"
                        f"<h2 style='color:#22c55e;margin:0 0 12px'>✓ Strava 授权成功</h2>"
                        f"<p style='color:#666'>refresh_token 已保存，你可以返回面板查看骑行数据了。</p>"
                        f"<p><a href='/' style='display:inline-block;margin-top:12px;padding:10px 26px;background:#fc4c02;color:#fff;border-radius:999px;text-decoration:none'>⬅ 返回面板</a></p>"
                        f"</div>"
                        f"<script>try{{if(window.opener){{window.opener.location.href='/';}}setTimeout(function(){{window.close();}},1500);}}catch(e){{}}</script>"
                        f"</body></html>")
            else:
                body = (f"<html><body style='font-family:sans-serif;text-align:center;padding-top:60px;background:#fff'>"
                        f"<div style='max-width:420px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:14px'>"
                        f"<h2 style='color:#ef4444;margin:0 0 12px'>✗ 授权失败</h2>"
                        f"<p style='color:#666'>{err}</p>"
                        f"<p><a href='/' style='display:inline-block;margin-top:12px;padding:10px 26px;background:#333;color:#fff;border-radius:999px;text-decoration:none'>⬅ 返回面板</a></p>"
                        f"</div></body></html>")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body.encode())))
            self.end_headers()
            self.wfile.write(body.encode())
            return
        if path == "/api/bootstrap":
            # 免认证：返回 API token + 版本号，供面板前端初始加载/填充 brandVer
            self._send_json({
                "api_token": get_or_create_api_token(),
                "configured": has_credentials(),
                "version": APP_VERSION or "",
            })
        elif path == "/api/status":
            cfg = load_config()
            tok, err = get_access_token()
            self._send_json({
                "configured": has_credentials(),
                "has_token": bool(tok),
                "token_error": err,
                "athlete_id": cfg.get("athlete_id"),
                "db_activities": db.count(),
                "last_sync": db.get_meta("last_sync"),
            })
        elif path == "/api/stats":
            if not self._require_api_token():
                return
            try:
                # 优先读本地缓存；仅本地为空时才尝试 Strava 同步（降级不报错）
                ensure_local_data()
                stats = db.stats(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["weekly"] = db.weekly(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["monthly"] = db.monthly(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["daily"] = db.daily(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["yearly"] = db.yearly(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["last_sync"] = db.get_meta("last_sync")
                self._send_json(stats)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/weekly":
            if not self._require_api_token():
                return
            try:
                ensure_local_data()
                self._send_json({"weekly": db.weekly(start_date=qs.get("start"), end_date=qs.get("end"))})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/activities":
            if not self._require_api_token():
                return
            try:
                ensure_local_data()
                acts = db.get_activities(
                    type_filter=qs.get("type"),
                    limit=int(qs.get("limit", 50)),
                    start_date=qs.get("start"),
                    end_date=qs.get("end"))
                self._send_json({"activities": acts, "count": len(acts)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/sync":
            if not self._require_api_token():
                return
            tok, err = self._require_token()
            if not tok:
                return
            try:
                with _lock:
                    result = sync_from_strava(tok)
                self._send_json({"ok": True, **result})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/export":
            if not self._require_api_token():
                return
            try:
                ensure_local_data()
                acts = db.get_activities(limit=100000)
                fmt = qs.get("fmt", "json")
                if fmt == "csv":
                    out = io.StringIO()
                    w = csv.writer(out)
                    w.writerow(["id","name","type","distance_km","moving_time_s","elevation_m","start_date"])
                    for a in acts:
                        w.writerow([a["id"], a["name"], a["type"],
                                    round((a.get("distance") or 0)/1000, 2),
                                    a.get("moving_time"), a.get("total_elevation_gain"),
                                    a.get("start_date")])
                    body = out.getvalue().encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="strava.csv"')
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self._send_json({"activities": acts, "count": len(acts)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/config":
            if not self._require_api_token():
                return
            cfg = load_config()
            # 本地面板（API token 保护）允许回显已存凭据，供设置页回填、免每次重输。
            # client_secret 仅在本机/局域网面板内返回（Bearer api_token 校验后）。
            self._send_json({
                "client_id": cfg.get("client_id", ""),
                "client_secret": cfg.get("client_secret", ""),
                "redirect_uri": cfg.get("redirect_uri", ""),
                "configured": has_credentials(),
                "has_token": bool(cfg.get("refresh_token", "")),
            })
        elif path == "/api/info":
            # 服务状态（含版本/端口/api_token，供仪表板）
            if not self._require_api_token():
                return
            self._send_json(get_service_info())
        elif path == "/api/sync/progress":
            # 同步进度（前端轮询）
            if not self._require_api_token():
                return
            self._send_json(SYNC_PROGRESS)
        elif path == "/api/token/view":
            if not self._require_api_token():
                return
            self._send_json({"api_token": get_or_create_api_token()})
        elif path == "/api/oauth/start":
            if not self._require_api_token():
                return
            # 用请求实际 Host 推导回调地址（否则可能落到 localhost 导致授权后 code 回不来）
            req_host = self.headers.get("Host", "")
            url, redirect_uri = build_oauth_url(req_host)
            if not url:
                self._send_json({"error": redirect_uri}, 400)
            else:
                self._send_json({"url": url, "redirect_uri": redirect_uri})
        elif path == "/api/doc":
            if not self._require_api_token():
                return
            lang = qs.get("lang", "zh")
            if lang not in ("zh", "en"):
                lang = "zh"
            self._send_json({"doc": build_api_doc(lang, self.headers.get("Host", ""))})
        elif path == "/api/logs/list":
            if not self._require_api_token():
                return
            name = qs.get("source", "strava")
            if name not in LOG_SOURCES:
                name = "strava"
            self._send_json({
                "sources": list(LOG_SOURCES.keys()),
                "dates": list_log_dates(name),
                "current": _archive_date()[0],
            })
        elif path == "/api/logs":
            if not self._require_api_token():
                return
            name = qs.get("source", "strava")
            if name not in LOG_SOURCES:
                name = "strava"
            date = qs.get("date")
            try:
                tail = int(qs.get("tail", "500"))
            except (TypeError, ValueError):
                tail = 500
            result = read_logs(name, date, tail)
            if result is None:
                self._send_json({"error": "未知日志来源"}, 404)
            else:
                self._send_json(result)
        elif path == "/api/logs/download":
            if not self._require_api_token():
                return
            name = qs.get("source", "strava")
            if name not in LOG_SOURCES:
                name = "strava"
            date = qs.get("date")
            result = read_logs(name, date, 0)
            if result is None:
                self._send_json({"error": "未知日志来源"}, 404)
                return
            fname = "strava.log"
            if date:
                fname = f"strava.log.{date.replace('-', '')}"
            body = result.get("content", "").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/" or path == "":
            self._send_file("index.html")
        elif path.startswith("/static/"):
            self._send_file(path[len("/static/"):])
        else:
            self.send_error(404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            if not self._require_api_token():
                return
            try:
                data = json.loads(self._read_body())
                # redirect_uri 必须是绝对 URL(http/https)，拒绝残缺的相对路径(如 /oauth/callback)
                # 否则 Strava 授权直接报错。
                if data.get("redirect_uri"):
                    ru = str(data["redirect_uri"]).strip()
                    if not (ru.startswith("http://") or ru.startswith("https://")):
                        self._send_json({"error": "回调地址必须是完整 URL(以 http:// 或 https:// 开头)，例如 http://localhost:20227/oauth/callback"}, 400)
                        return
                    data["redirect_uri"] = ru
                with _lock:
                    cfg = load_config()
                    for k in ("client_id", "client_secret", "refresh_token", "redirect_uri"):
                        if data.get(k):
                            cfg[k] = str(data[k]).strip()
                    save_config(cfg)
                tok, err = get_access_token()
                # 有凭据且有 token 时自动同步一次
                if tok:
                    try:
                        sync_from_strava(tok)
                    except Exception:
                        pass
                # 保存成功即返回 ok（未拿到 token 时 err 提示 token 状态）
                self._send_json({"ok": True, "token_ok": bool(tok), "error": err})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/sync":
            if not self._require_api_token():
                return
            tok, err = get_access_token()
            if not tok:
                self._send_json({"error": err or "未配置"}, 400); return
            try:
                with _lock:
                    result = sync_from_strava(tok)
                self._send_json({"ok": True, **result})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/token/recreate":
            # 重新生成 API token（立即生效）
            if not self._require_api_token():
                return
            self._send_json({"ok": True, "api_token": recreate_api_token()})
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    port = int(PORT)
    # 启动时归档非当天的日志
    archive_logs()
    _log("system", f"Strava Panel 启动 (v{APP_VERSION or '?'}, port={port}, data={DATA_DIR})")
    # SO_REUSEADDR：避免频繁重启后 TIME_WAIT 导致 "Address already in use"
    # 必须在实例化前设置类属性（socketserver 在 __init__ 时 bind）
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer((BIND_HOST, port), Handler)
    httpd.daemon_threads = True
    print(f"Strava Panel listening on {port}", flush=True)
    print(f"Data dir: {DATA_DIR}", flush=True)
    print(f"DB: {DB_FILE}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
