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
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,precipitation_probability,precipitation,weathercode,wind_speed_10m`
    + `&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;
  const resp = await fetchTimeout(url, { headers: HEADERS }, 15000);
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const d = await resp.json();
  const h = d.hourly || {};
  // 压缩为逐日 × 6~18 点运动窗口的行
  const byDay = {};
  (h.time || []).forEach((t, i) => {
    const day = t.slice(0, 10), hour = Number(t.slice(11, 13));
    if (hour < 6 || hour > 18) return;
    (byDay[day] ??= []).push({
      hour,
      temp: h.temperature_2m?.[i],
      rainProb: h.precipitation_probability?.[i],
      rainMm: h.precipitation?.[i],
      code: h.weathercode?.[i],
      wind: h.wind_speed_10m?.[i],
    });
  });
  const daysOut = Object.entries(byDay).map(([day, hours]) => ({
    day, hours,
    // 全天概要：最高/最低温、最大降雨概率、代表天气
    tMax: Math.max(...hours.map(x => x.temp ?? -99)),
    tMin: Math.min(...hours.map(x => x.temp ?? 99)),
    rainMax: Math.max(0, ...hours.map(x => x.rainProb ?? 0)),
    worst: hours.slice().sort((a, b) => (b.rainProb ?? 0) - (a.rainProb ?? 0))[0]?.code,
  }));
  return { ok: true, tz, unit: { temp: d.hourly_units?.temperature_2m || '°C', wind: d.hourly_units?.wind_speed_10m || 'km/h' }, days: daysOut, wmo: WMO };
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
  if (data.NAME_STATIONS[name]) return data.NAME_STATIONS[name];
  if (data.CITY_CODES[name]) return data.CITY_CODES[name];
  if (data.CITY_STATIONS[name]) return data.CITY_STATIONS[name][0];
  const trimmed = String(name).replace(/[市站]$/, '');
  if (data.CITY_CODES[trimmed]) return data.CITY_CODES[trimmed];
  if (data.CITY_STATIONS[trimmed]) return data.CITY_STATIONS[trimmed][0];
  return null;
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
  if (!from) throw new Error(`找不到车站：${fromName}`);
  if (!to) throw new Error(`找不到车站：${toName}`);

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
