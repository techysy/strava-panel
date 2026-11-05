/**
 * trip.js — 户外出行规划后端（移植自 Hermes skill: cycling/outdoor-trip-planner）
 *
 * 两个能力，均由面板服务端代理（浏览器直连 12306 会被 CORS 拦截）：
 *   tripWeather(qs)  → Open-Meteo 逐时天气（免费无 key）
 *   tripTrains(qs)   → 12306 余票查询（站点数据缓存 7 天）
 *
 * 流程参考 skill 原文：确认日期 → 查目的地天气 → 查高铁票 → 常用目的地数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const HEADERS = { 'User-Agent': UA };

function fetchTimeout(url, opts = {}, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

// ===================== 天气（Open-Meteo） =====================

// WMO 天气代码 → 图标/文字（与 skill 的映射一致，补充常见项）
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴伴冰雹',
};

export async function tripWeather(qs) {
  const lat = Number(qs.lat), lon = Number(qs.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('缺少 lat/lon 参数');
  const days = Math.min(7, Math.max(1, Number(qs.days) || 7));
  const tz = qs.tz || 'Asia/Shanghai';
  const baseParams = '&hourly=temperature_2m,precipitation_probability,precipitation,weathercode,wind_speed_10m,wind_direction_10m,wind_gusts_10m'
    + `&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;
  const baseUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`;

  // 多模型并行：主结果取默认（Open-Meteo 自动择优），另取两个独立模型做交叉校验。
  // ECMWF(欧洲中心) / GFS(美国) / ICON(德国) 是全球三大主力，山区短临预报分歧往往很大，
  // 只报单一模型会给出虚假的确定感。
  const EXTRA_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
  const [mainResp, ...modelResps] = await Promise.all([
    fetchTimeout(baseUrl + baseParams, { headers: HEADERS }, 15000),
    ...EXTRA_MODELS.map(m => fetchTimeout(
      baseUrl + baseParams + '&models=' + m, { headers: HEADERS }, 15000
    ).then(r => r.ok ? r.json() : null).catch(() => null)),
  ]);
  if (!mainResp.ok) throw new Error(`Open-Meteo HTTP ${mainResp.status}`);
  const d = await mainResp.json();
  const h = d.hourly || {};
  // 全量逐时行（前端逐时图表 + 运动窗口用）
  const hourly = (h.time || []).map((t, i) => ({
    time: t,
    temp: h.temperature_2m?.[i],
    rainProb: h.precipitation_probability?.[i],
    rainMm: h.precipitation?.[i],
    code: h.weathercode?.[i],
    wind: h.wind_speed_10m?.[i],
    windDir: h.wind_direction_10m?.[i],
    gust: h.wind_gusts_10m?.[i],
  }));
  // 兼容旧结构：逐日 × 6~18 点运动窗口聚合
  const byDay = {};
  for (const x of hourly) {
    const day = x.time.slice(0, 10), hour = Number(x.time.slice(11, 13));
    if (hour < 6 || hour > 18) continue;
    (byDay[day] ??= []).push(x);
  }
  const daysOut = Object.entries(byDay).map(([day, hours]) => ({
    day, hours,
    // 全天概要：最高/最低温、最大降雨概率、代表天气
    tMax: Math.max(...hours.map(x => x.temp ?? -99)),
    tMin: Math.min(...hours.map(x => x.temp ?? 99)),
    rainMax: Math.max(0, ...hours.map(x => x.rainProb ?? 0)),
    worst: hours.slice().sort((a, b) => (b.rainProb ?? 0) - (a.rainProb ?? 0))[0]?.code,
  }));
  // ---- 多模型一致性校验 ----
  // 对每个时刻，取各模型温度/降雨概率的离散度：温差越大、降雨分歧越大，
  // 预报越不可信。输出逐时 spread 供前端提示，并汇总成 overall 等级。
  const models = [];
  for (let mi = 0; mi < EXTRA_MODELS.length; mi++) {
    const md = modelResps[mi];
    if (!md || !md.hourly || md.error) continue;
    models.push({ id: EXTRA_MODELS[mi], time: md.hourly.time || [], temp: md.hourly.temperature_2m || [], rain: md.hourly.precipitation_probability || [] });
  }
  const idxByTime = new Map(hourly.map((x, i) => [x.time, i]));
  const spread = hourly.map((x, i) => {
    const temps = [], rains = [];
    if (Number.isFinite(x.temp)) temps.push(x.temp);
    if (Number.isFinite(x.rainProb)) rains.push(x.rainProb);
    for (const m of models) {
      const j = m.time.indexOf(x.time);   // 模型时间轴可能不一致，按时间查找
      if (j < 0) continue;
      if (Number.isFinite(m.temp[j])) temps.push(m.temp[j]);
      if (Number.isFinite(m.rain[j])) rains.push(m.rain[j]);
    }
    if (temps.length < 2) return null;
    const tMin = Math.min(...temps), tMax = Math.max(...temps);
    const rMin = rains.length ? Math.min(...rains) : null;
    const rMax = rains.length ? Math.max(...rains) : null;
    return {
      tempRange: +(tMax - tMin).toFixed(1),
      rainRange: (rMin != null && rMax != null) ? Math.round(rMax - rMin) : null,
      n: temps.length,
    };
  });
  const vals = spread.filter(Boolean);
  const avgTempSpread = vals.length ? +(vals.reduce((a, b) => a + b.tempRange, 0) / vals.length).toFixed(1) : null;
  const maxTempSpread = vals.length ? Math.max(...vals.map(v => v.tempRange)) : null;
  // 一致性等级：平均温差 ≤1.5°C 高、≤3.5°C 中、否则低（预报越分歧越不可信）
  const consistency = avgTempSpread == null ? null
    : avgTempSpread <= 1.5 ? 'high' : avgTempSpread <= 3.5 ? 'medium' : 'low';

  return {
    ok: true, tz,
    unit: { temp: d.hourly_units?.temperature_2m || '°C', wind: d.hourly_units?.wind_speed_10m || 'km/h' },
    hourly, days: daysOut, wmo: WMO,
    // 多模型校验（前端据此提示「预报分歧大」「多模型一致」）
    verification: {
      models: models.map(m => m.id),
      spread,                 // 逐时：{tempRange, rainRange, n} 或 null
      avgTempSpread,          // 全程平均温差（°C）
      maxTempSpread,          // 最大温差
      consistency,            // 'high' | 'medium' | 'low' | null
    },
  };
}

// ===================== 地理编码（Open-Meteo，免费无 key） =====================

export async function tripGeocode(qs) {
  const name = String(qs.name || '').trim();
  if (!name) throw new Error('缺少 name 参数');
  const count = Math.min(10, Math.max(1, Number(qs.count) || 8));
  const lang = qs.language === 'en' ? 'en' : 'zh';
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}`
    + `&count=${count}&language=${lang}&format=json`;
  const resp = await fetchTimeout(url, { headers: HEADERS }, 15000);
  if (!resp.ok) throw new Error(`Open-Meteo geocoding HTTP ${resp.status}`);
  const d = await resp.json();
  const results = (d.results || []).map(r => ({
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    lat: r.latitude, lon: r.longitude,
    elevation: r.elevation ?? null,
    timezone: r.timezone || '',
  }));
  return { ok: true, results };
}

// ===================== 沿途天气（多点并行，Open-Meteo） =====================

/**
 * pts 编码: "lat,lon;lat,lon;..."（≤8 点，GET 紧凑传输，避免给零依赖服务端加 POST body 解析）
 * 每点返回 2 天逐时（温度/降雨概率/降雨量/天气码/风），前端按各采样点 ETA 时刻就近取值。
 *
 * 所有点合并为**单次** Open-Meteo 请求（latitude/longitude 逗号分隔 → 响应为结果数组），
 * 避免逐点并行触发免费层限流（HTTP 429）。结果按索引与请求点对应
 * （Open-Meteo 返回的 latitude/longitude 是网格对齐后的值，不能用于匹配）。
 */
export async function tripRouteWeather(qs) {
  const raw = String(qs.pts || '').trim();
  if (!raw) throw new Error('缺少 pts 参数');
  const pts = raw.split(';').map(s => {
    const [la, lo] = s.split(',').map(Number);
    return { lat: la, lon: lo };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)).slice(0, 8);
  if (!pts.length) throw new Error('pts 无有效坐标');
  const tz = qs.tz || 'Asia/Shanghai';
  const days = Math.min(3, Math.max(1, Number(qs.days) || 2));
  const lats = pts.map(p => p.lat.toFixed(4)).join(',');
  const lons = pts.map(p => p.lon.toFixed(4)).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
    + `&hourly=temperature_2m,precipitation_probability,precipitation,weathercode,wind_speed_10m,wind_direction_10m,wind_gusts_10m`
    + `&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;
  const resp = await fetchTimeout(url, { headers: HEADERS }, 25000);
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const d = await resp.json();
  // 多点 → 数组；单点 → 对象（Open-Meteo 两种形态都可能返回，统一成数组）
  const list = Array.isArray(d) ? d : [d];
  const points = pts.map((p, i) => {
    const h = list[i]?.hourly || {};
    return {
      lat: p.lat, lon: p.lon,
      hourly: (h.time || []).map((t, k) => ({
        time: t,
        temp: h.temperature_2m?.[k],
        rainProb: h.precipitation_probability?.[k],
        rainMm: h.precipitation?.[k],
        code: h.weathercode?.[k],
        wind: h.wind_speed_10m?.[k],
        windDir: h.wind_direction_10m?.[k],
        gust: h.wind_gusts_10m?.[k],
      })),
    };
  });
  return { ok: true, tz, wmo: WMO, unit: { temp: '°C', wind: 'km/h' }, points };
}

// ===================== 高铁票（12306） =====================

const STATION_CACHE_TTL = 7 * 24 * 3600 * 1000;
// 12306 leftTicket 响应为竖线分隔字段；索引映射取自 skill（ref: CSDN 86302597）
const F = {
  trainNo: 2, trainCode: 3, fromCode: 6, toCode: 7,
  departTime: 8, arriveTime: 9, duration: 10, canBuy: 11, date: 13,
  gr: 21, rw: 23, rz: 24, tz: 25, wz: 26, yw: 28, yz: 29,
  ze: 30, zy: 31, swz: 32, dw: 33,
};

function stationCacheFile(dataDir) {
  return path.join(dataDir, 'stations_12306.json');
}

async function fetchStationScript() {
  const homeRes = await fetchTimeout('https://www.12306.cn/index/', { headers: HEADERS }, 15000);
  const homeHtml = await homeRes.text();
  const versionMatch = homeHtml.match(/station_name\.js\?station_version=([\d.]+)/);
  const jsUrl = versionMatch
    ? `https://www.12306.cn/index/script/station_name.js?station_version=${versionMatch[1]}`
    : 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';
  const jsRes = await fetchTimeout(jsUrl, { headers: HEADERS }, 15000);
  return jsRes.text();
}

function parseStationData(jsText) {
  // 格式: @bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||
  const raw = jsText.match(/'([^']+)'/)?.[1] || '';
  const entries = raw.split('@').filter(Boolean);
  const STATIONS = {}, CITY_STATIONS = {}, NAME_STATIONS = {}, CITY_CODES = {};
  for (const entry of entries) {
    const parts = entry.split('|');
    const name = parts[1], code = parts[2], pinyin = parts[3], shortPy = parts[4];
    const city = parts[7] || name;
    if (!name || !code) continue;
    STATIONS[code] = { station_name: name, station_code: code, station_pinyin: pinyin, station_short: shortPy, city };
    NAME_STATIONS[name] = { station_code: code, station_name: name };
    (CITY_STATIONS[city] ??= []).push({ station_code: code, station_name: name });
    if (name === city) CITY_CODES[city] = { station_code: code, station_name: name };
  }
  return { STATIONS, CITY_STATIONS, NAME_STATIONS, CITY_CODES };
}

async function loadStations(dataDir) {
  const file = stationCacheFile(dataDir);
  try {
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - cached.ts < STATION_CACHE_TTL) return cached.data;
    }
  } catch { /* 缓存损坏则重取 */ }
  const data = parseStationData(await fetchStationScript());
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), data }), 'utf8');
  } catch { /* 缓存写失败不影响查询 */ }
  return data;
}

function resolveStation(data, name) {
  const raw = String(name == null ? '' : name).trim();
  if (data.NAME_STATIONS[raw]) return data.NAME_STATIONS[raw];
  if (data.CITY_CODES[raw]) return data.CITY_CODES[raw];
  if (data.CITY_STATIONS[raw]) return data.CITY_STATIONS[raw][0];
  const trimmed = raw.replace(/[市站]$/, '');
  if (data.CITY_CODES[trimmed]) return data.CITY_CODES[trimmed];
  if (data.CITY_STATIONS[trimmed]) return data.CITY_STATIONS[trimmed][0];
  // 精确匹配失败 → 模糊匹配（12306 常见误输入：方位字记错、少字、多字、
  // 拼音/首字母输入）。候选只有一个才采用，多个歧义时交给调用方报错并列出候选，
  // 绝不静默挑一个（选错站会查出完全错误的余票）。
  const fuzzy = fuzzyStations(data, raw);
  return fuzzy.length === 1 ? fuzzy[0].station : null;
}

// 模糊匹配候选：站名/拼音/首字母包含关系 + 编辑距离兜底
function fuzzyStations(data, raw) {
  const q = String(raw == null ? '' : raw).trim();
  if (!q) return [];
  const key = q.replace(/[市站]$/, '');
  if (!key) return [];

  // 1) 站名互相包含（「淮口」⊂「淮口南」成立；「淮口北」与「淮口南」靠下面的
  //    编辑距离兜底）：
  //    输入是站名的一部分，或站名包含输入 —— 取最短（最贴近城市名）的几个
  const byContains = [];
  for (const name of Object.keys(data.NAME_STATIONS)) {
    if (!name.includes(key) && !key.includes(name)) continue;
    byContains.push({ station: data.NAME_STATIONS[name], name });
  }
  if (byContains.length) {
    // 长度差越小越贴近；同名优先
    byContains.sort((a, b) =>
      Math.abs(a.name.length - key.length) - Math.abs(b.name.length - key.length) || a.name.localeCompare(b.name));
    const best = Math.abs(byContains[0].name.length - key.length);
    // 只保留最短的那批（避免「淮口北」匹配到几十个带「淮」的站）
    const kept = byContains.filter(x => Math.abs(x.name.length - key.length) === best);
    if (kept.length === 1) return [{ station: kept[0].station, score: 0, kind: 'contains' }];
    return kept.map(x => ({ station: x.station, score: 1, kind: 'contains' }));
  }

  // 2) 同前缀 + 同长度（方位字记错：淮口北 → 淮口南）：比编辑距离更贴切，
  //    且能压住「淮北 / 河口北」这类碰巧距离 1 的干扰
  if (key.length >= 3) {
    const stem = key.slice(0, -1), tail = key.slice(-1);
    const sameStem = [];
    for (const name of Object.keys(data.NAME_STATIONS)) {
      if (name.length !== key.length || !name.startsWith(stem) || name === key) continue;
      sameStem.push({ station: data.NAME_STATIONS[name], name, same: name.slice(-1) === tail });
    }
    // 双字方位（东/南/西/北 与 东/南/西/北）取最近的；只有一个则直接采用
    if (sameStem.length === 1) return [{ station: sameStem[0].station, score: 1, kind: 'stem' }];
    if (sameStem.length > 1) return sameStem.map(x => ({ station: x.station, score: 1, kind: 'stem' }));
  }

  // 3) 编辑距离 1 的近似（错一个字）：仅当目标长度相近时做，且要求唯一
  const near = [];
  for (const name of Object.keys(data.NAME_STATIONS)) {
    if (Math.abs(name.length - key.length) > 1) continue;
    if (editDistanceAtMost1(name, key)) near.push({ station: data.NAME_STATIONS[name], name });
  }
  if (near.length) return near.map(x => ({ station: x.station, score: 2, kind: 'typo' }));

  // 3) 拼音 / 首字母前缀（用户可能输入 huikoubei / hkb）
  const pk = q.toLowerCase().replace(/[^a-z]/g, '');
  if (pk.length >= 2) {
    const byPy = [];
    for (const [code, s] of Object.entries(data.STATIONS)) {
      if ((s.station_pinyin || '').startsWith(pk) || (s.station_short || '') === pk) {
        byPy.push({ station: s, name: s.station_name });
      }
    }
    if (byPy.length) return byPy.map(x => ({ station: x.station, score: 3, kind: 'pinyin' }));
  }
  return [];
}

// 编辑距离 ≤ 1 的快速判定（插入/删除/替换单个字符）
function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < Math.min(la, lb) && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);        // 替换一个字符
  if (la > lb) return a.slice(i + 1) === b.slice(i);              // a 多一个字符
  return a.slice(i) === b.slice(i + 1);                            // b 多一个字符
}

// 车站解析失败的提示：列出模糊候选，让用户点选而不是干瞪眼
function stationErr(data, name, label) {
  const cands = fuzzyStations(data, name).slice(0, 6).map(c => c.station.station_name);
  if (!cands.length) return `找不到${label}：${name}`;
  if (cands.length === 1) return `找不到${label}「${name}」，是否指「${cands[0]}」？`;
  return `找不到${label}「${name}」，可能是：${cands.join(' / ')}`;
}

async function get12306Cookie() {
  const res = await fetchTimeout('https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc', {
    headers: HEADERS, redirect: 'manual',
  }, 15000);
  const cookies = res.headers.getSetCookie?.() || [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

export async function tripTrains(qs, dataDir) {
  const fromName = String(qs.from || '').trim();
  const toName = String(qs.to || '').trim();
  const date = String(qs.date || '').trim();
  if (!fromName || !toName) throw new Error('缺少出发/到达站');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');

  const data = await loadStations(dataDir);
  const from = resolveStation(data, fromName);
  const to = resolveStation(data, toName);
  if (!from) throw new Error(stationErr(data, fromName, '出发站'));
  if (!to) throw new Error(stationErr(data, toName, '到达站'));

  const cookie = await get12306Cookie();
  const params = new URLSearchParams({
    'leftTicketDTO.train_date': date,
    'leftTicketDTO.from_station': from.station_code,
    'leftTicketDTO.to_station': to.station_code,
    purpose_codes: 'ADULT',
  });
  const resp = await fetchTimeout(`https://kyfw.12306.cn/otn/leftTicket/query?${params}`, {
    headers: { ...HEADERS, Referer: 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc', Cookie: cookie },
  }, 20000);
  const json = await resp.json().catch(() => null);
  if (!json?.data?.result) throw new Error('12306 未返回数据（可能限流或维护），请稍后重试');

  const typeFilter = String(qs.type || '').toUpperCase();   // 如 GD / C
  const tickets = json.data.result.map((raw) => {
    const f = raw.split('|');
    const v = (key) => f[F[key]] || '';
    return {
      trainCode: v('trainCode'),
      from: data.STATIONS[v('fromCode')]?.station_name || v('fromCode'),
      to: data.STATIONS[v('toCode')]?.station_name || v('toCode'),
      depart: v('departTime'), arrive: v('arriveTime'), duration: v('duration'),
      canBuy: v('canBuy') === 'Y',
      seats: { swz: v('swz'), tz: v('tz'), zy: v('zy'), ze: v('ze'), gr: v('gr'), rw: v('rw'), dw: v('dw'), yw: v('yw'), rz: v('rz'), yz: v('yz'), wz: v('wz') },
    };
  }).filter(t => !typeFilter || [...typeFilter].some(ch => t.trainCode.startsWith(ch)));

  return { ok: true, from: from.station_name, to: to.station_name, date, count: tickets.length, trains: tickets };
}

// ===================== 常用目的地数据（skill 内置表） =====================

export const TRIP_DESTINATIONS = [
  { name: '松潘古城', lat: 32.6530, lon: 103.5990, alt: 2850, rail: '成都东→松潘 1h33min', ride: '雪山梁·机场路环线 80km/↑1241m', hike: '郭学寨→跨石岩(阿岭扎嘎)' },
  { name: '黄龙九寨站', lat: 32.7580, lon: 103.8200, alt: 3100, rail: '成都东→黄龙九寨 1h33min', ride: '机场路拍红星岩', hike: '牟尼沟徒步' },
  { name: '西昌邛海', lat: 27.8190, lon: 102.2850, alt: 1500, rail: '成都南→西昌西 3h', ride: '环邛海 35km + 乌龟山', hike: '泸山徒步' },
  { name: '米易梯田', lat: 26.8870, lon: 102.1000, alt: 1100, rail: '成都南→米易东 4h', ride: '新山梯田爬坡', hike: '梯田徒步' },
  { name: '峨眉山零公里', lat: 29.5520, lon: 103.4450, alt: 1300, rail: '成都东→峨眉山 1h', ride: '零公里→雷洞坪', hike: '峨眉山徒步登顶' },
];
