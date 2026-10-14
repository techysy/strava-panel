/** Strava SQLite 缓存层 — 本地存储 + 查询 (Node 版, schema 与 db.py 逐字一致,
 *  已有的 strava.db 直接打开即可继续用, 无需迁移。) */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// ---- schema (与 db.py 的 CREATE TABLE / CREATE INDEX 语句完全一致) ----
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS activities(
    id INTEGER PRIMARY KEY,
    name TEXT,
    type TEXT,
    distance REAL,
    moving_time REAL,
    total_elevation_gain REAL,
    start_date TEXT,
    start_date_local TEXT,
    elapsed_time REAL,
    average_speed REAL,
    max_speed REAL
);
CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS coach_memory(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_start_date ON activities(start_date);`;

// 心率/功率扩展列:老库(PRAGMA 检测缺列)自动 ALTER 升级,新库建表后同样补齐。
const EXTRA_COLS = [['average_heartrate', 'REAL'], ['max_heartrate', 'REAL'],
                    ['average_watts', 'REAL'], ['kilojoules', 'REAL']];

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// ISO 星期几: 周一=1 … 周日=7 (Python date.isoweekday)
const isoWeekday = (d) => ((d.getDay() + 6) % 7) + 1;

// ISO 周 (周一为周首; Python date.isocalendar) — 用 UTC 算避免夏令时漂移
function isoCalendar(d) {
  const dow = isoWeekday(d);
  const thu = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + (4 - dow));
  const dThu = new Date(thu);
  const jan1 = Date.UTC(dThu.getUTCFullYear(), 0, 1);
  const week = Math.round(1 + (thu - jan1) / 604800000);
  return [dThu.getUTCFullYear(), week];
}

// 解析 YYYY-MM-DD, 非法日期返回 null (等价 Python date.fromisoformat 的校验语义)
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}

// Python round(x, ndigits) 等价: 十进制正确 half-even(四舍六入五成双)舍入,
// 与 CPython round 的 double-correct 行为一致 —— JS Math.round 是 half-up, 在 .5 处不一致。
export function pyRound(value, digits = 0) {
  if (!Number.isFinite(value) || value === 0) return value;
  const neg = value < 0;
  // V8 toPrecision(100) 生成 double 的精确十进制展开 (如 12.35 实为 ...4999...),
  // 据此十进制舍入等价 CPython round 的 double-correct 行为
  let s = Math.abs(value).toPrecision(100);
  let exp10 = 0;
  const ei = s.indexOf('e');
  if (ei !== -1) { exp10 = parseInt(s.slice(ei + 1), 10); s = s.slice(0, ei); }
  const di = s.indexOf('.');
  const fracLen = di === -1 ? 0 : s.length - di - 1;
  const scale = fracLen - exp10;              // value = d0 × 10^(-scale)
  let d = s.replace('.', '').replace(/^0+/, '');
  if (!d) return 0;
  const drop = scale - digits;                // 要丢弃的十进制位数 (≤0 表示已是目标精度)
  if (drop <= 0) return value;
  const keep = d.length - drop;               // 保留的位数 (可能 ≤ 0)
  if (keep < 0) return neg ? -0 : 0;          // 绝对值太小, 舍入为 0
  let carry = false;
  if (keep === 0) {
    // 最高位正好在舍入位: >5 进位; ==5 恰为一半(后面无非零)时 half-even 落 0
    if (d[0] > '5' || (d[0] === '5' && /[1-9]/.test(d.slice(1)))) carry = true;
    d = '';
  } else {
    const cut = d[keep];
    if (cut > '5') carry = true;
    else if (cut === '5') {
      // 恰为一半 → half-even: 末位奇数则进位; 后面还有非零则大于一半, 进位
      carry = /[1-9]/.test(d.slice(keep + 1)) || (d.charCodeAt(keep - 1) - 48) % 2 === 1;
    }
    d = d.slice(0, keep);
  }
  if (carry) {
    const dd = d.split('');
    let i = dd.length - 1;
    while (i >= 0 && dd[i] === '9') { dd[i] = '0'; i--; }
    if (i < 0) dd.unshift('1'); else dd[i] = String(Number(dd[i]) + 1);
    d = dd.join('');
  }
  if (!d || /^0*$/.test(d)) return neg ? -0 : 0;
  // 拼回十进制字符串再转 number (与 Python float(十进制串) 一样取最近 double)
  let out;
  const intLen = d.length - digits;
  if (digits > 0) {
    out = intLen > 0 ? d.slice(0, intLen) + '.' + d.slice(intLen) : '0.' + '0'.repeat(-intLen) + d;
  } else if (digits === 0) {
    out = d;
  } else {
    out = d + '0'.repeat(-digits);
  }
  return Number((neg ? '-' : '') + out);
}

const emptyBucket = () => ({ count: 0, dist_km: 0.0, duration_h: 0.0, elev_m: 0.0 });

// ---- Python 风格序列化 ----
// JS number 不区分 int/float; 为了 JSON/CSV 输出与 Python 端 (json.dumps / str) 逐字节一致,
// 对来自 SQLite REAL 列和聚合计算的值打 PyFloat 标记, 序列化时按 Python float repr 输出
// (整数取浮点值补 ".0"; 指数阈值按 Python: 十进制指数 >=16 或 <-4 时切科学计数法)。
export class PyFloat {
  constructor(v) { this.v = v; }
}
export const pyf = (v) => (v === null || v === undefined ? null : new PyFloat(v));

export function pyFloatRepr(x) {
  // 模拟 Python float 的 repr/str (最短十进制, e10 为值首有效数字十进制指数+1)
  if (!Number.isFinite(x)) return String(x); // NaN/Infinity 不出现在本程序数据里
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0 ? '-' : '';
  let s = Math.abs(x).toString();
  let exp = 0;
  const ei = s.indexOf('e');
  if (ei !== -1) { exp = parseInt(s.slice(ei + 1), 10); s = s.slice(0, ei); }
  const di = s.indexOf('.');
  const digits = s.replace('.', '');
  const point = (di === -1 ? s.length : di) + exp; // 小数点在 digits 串中的位置
  let lead = 0;
  while (lead < digits.length && digits[lead] === '0') lead++;
  const e10 = point - lead;                        // value = 0.digits_sig × 10^e10
  const ds = digits.slice(lead).replace(/0+$/, '');
  if (!ds) return neg + '0.0';
  if (e10 < -3 || e10 >= 17) {
    // 科学计数法: Python 指数 = e10 - 1; repr(1e16)='1e+16', repr(1.5e-07)='1.5e-07' (指数至少两位)
    const m = ds.length > 1 ? ds[0] + '.' + ds.slice(1) : ds;
    const eExp = e10 - 1;
    let ae = String(Math.abs(eExp));
    if (ae.length < 2) ae = '0' + ae;
    return `${neg}${m}e${eExp < 0 ? '-' : '+'}${ae}`;
  }
  if (e10 <= 0) return `${neg}0.${'0'.repeat(-e10)}${ds}`;
  if (e10 >= ds.length) return neg + ds + '0'.repeat(e10 - ds.length) + '.0';
  return neg + ds.slice(0, e10) + '.' + ds.slice(e10);
}

// Python json.dumps(obj, ensure_ascii=False) 默认分隔符: ', ' 和 ': '
export function pyDump(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (obj instanceof PyFloat) return pyFloatRepr(obj.v);
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return Number.isInteger(obj) ? String(obj) : pyFloatRepr(obj);
  if (typeof obj === 'string') return pyJsonStr(obj);
  if (Array.isArray(obj)) return '[' + obj.map(pyDump).join(', ') + ']';
  return '{' + Object.entries(obj).map(([k, v]) => pyJsonStr(k) + ': ' + pyDump(v)).join(', ') + '}';
}

function pyJsonStr(s) {
  return '"' + s.replace(/["\\\u0000-\u001f]/g, (ch) => {
    switch (ch) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    }
  }) + '"';
}

// Python str(v) (csv 写出用): 浮点走 repr 格式, None → 'None'
export function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v instanceof PyFloat) return pyFloatRepr(v.v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return String(v);
}

// activities 表 REAL 列 (读出行时打浮点标记)
const REAL_COLS = ['distance', 'moving_time', 'total_elevation_gain', 'elapsed_time', 'average_speed', 'max_speed'];
const wrapRow = (r) => {
  const overrides = {};
  for (const c of REAL_COLS) if (r[c] !== null && r[c] !== undefined) overrides[c] = pyf(r[c]);
  return { ...r, ...overrides };
};

// 解包 PyFloat → 数值 (聚合累加用); Python a.get("x") or 0 语义
const numOf = (v) => {
  if (v instanceof PyFloat) return v.v;
  return v === null || v === undefined ? 0 : (v || 0);
};

// 聚合桶输出: count 整数, 其余浮点 (与 Python 桶 {"count": 0, "dist_km": 0.0, ...} 一致)
const bucketOut = (v) => ({ count: v.count, dist_km: pyf(v.dist_km), duration_h: pyf(v.duration_h), elev_m: pyf(v.elev_m) });

export class StravaDB {
  constructor(dbPath) {
    this.dbPath = String(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    // 确保 schema 存在 (幂等; 兼容 db 文件被删/重建)
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA_SQL);
    // 心率/功率列自动迁移:老库缺列则 ALTER 补齐(幂等)
    const existing = new Set(this.db.prepare('PRAGMA table_info(activities)').all().map(c => c.name));
    for (const [col, type] of EXTRA_COLS) {
      if (!existing.has(col)) this.db.exec(`ALTER TABLE activities ADD COLUMN ${col} ${type}`);
    }
  }

  // ---- write ----
  upsertActivities(activities) {
    /** 批量写入活动 (upsert by id), 返回新增数 */
    let added = 0;
    const sel = this.db.prepare('SELECT id FROM activities WHERE id=?');
    const ins = this.db.prepare(`INSERT OR REPLACE INTO activities
        (id,name,type,distance,moving_time,total_elevation_gain,
         start_date,start_date_local,elapsed_time,average_speed,max_speed,
         average_heartrate,max_heartrate,average_watts,kilojoules)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const a of activities) {
      const rid = a && a.id;
      if (!rid) continue;
      if (sel.get(rid) === undefined) added += 1;
      ins.run(rid, a.name ?? null, a.type ?? null, a.distance ?? null,
        a.moving_time ?? null, a.total_elevation_gain ?? null,
        a.start_date ?? null, a.start_date_local ?? null,
        a.elapsed_time ?? null, a.average_speed ?? null, a.max_speed ?? null,
        a.average_heartrate ?? null, a.max_heartrate ?? null,
        a.average_watts ?? null, a.kilojoules ?? null);
    }
    this.setMeta('last_sync', localIsoNow());
    return added;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
      .run(key, String(value));
  }

  getMeta(key, fallback = null) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return r ? r.value : fallback;
  }

  // ---- query ----
  getActivities(typeFilter = null, limit = 200, startDate = null, endDate = null) {
    let q = 'SELECT * FROM activities WHERE 1=1';
    const params = [];
    if (typeFilter) { q += ' AND type=?'; params.push(typeFilter); }
    if (startDate) { q += ' AND start_date >= ?'; params.push(startDate); }
    if (endDate) { q += ' AND start_date <= ?'; params.push(endDate + 'T23:59:59'); }
    q += ' ORDER BY start_date DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(q).all(...params).map(wrapRow);
  }

  getRides(startDate = null, endDate = null, limit = 100000) {
    return this.getActivities('Ride', limit, startDate, endDate);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT id) d FROM activities').get().n;
  }

  stats(startDate = null, endDate = null) {
    /** 统计骑行数据, 支持日期范围过滤 */
    let q = `SELECT COUNT(*) total_rides,
                    SUM(distance) total_distance,
                    SUM(moving_time) total_moving_time,
                    SUM(total_elevation_gain) total_elevation,
                    AVG(average_heartrate) avg_hr,
                    MAX(max_heartrate) max_hr,
                    AVG(average_watts) avg_watts,
                    SUM(kilojoules) total_kj,
                    SUM(CASE WHEN average_heartrate IS NOT NULL THEN 1 ELSE 0 END) hr_count,
                    SUM(CASE WHEN average_watts IS NOT NULL THEN 1 ELSE 0 END) pw_count
             FROM activities WHERE type='Ride'`;
    const params = [];
    if (startDate) { q += ' AND start_date >= ?'; params.push(startDate); }
    if (endDate) { q += ' AND start_date <= ?'; params.push(endDate + 'T23:59:59'); }
    const r = this.db.prepare(q).get(...params);
    const n = r.total_rides || 0;
    const dist = (r.total_distance || 0) / 1000;
    const dur = (r.total_moving_time || 0) / 3600;
    // SUM 无行为 NULL: Python r["total_elevation"] or 0 → int 0, round 后仍输出 0 (非 0.0)
    const elev = r.total_elevation || 0;
    return {
      total_rides: n,
      total_distance_km: pyf(pyRound(dist, 1)),
      total_duration_h: pyf(pyRound(dur, 1)),
      total_elevation_m: r.total_elevation === null ? 0 : pyf(pyRound(elev, 0)),
      avg_distance_km: n ? pyf(pyRound(dist / n, 1)) : 0,
      // 心率/功率:无数据时输出 null(前端据此隐藏卡片),有数据取整
      avg_heartrate: r.hr_count ? pyRound(r.avg_hr, 0) : null,
      max_heartrate: r.hr_count ? pyRound(r.max_hr, 0) : null,
      avg_watts: r.pw_count ? pyRound(r.avg_watts, 0) : null,
      total_kilojoules: r.pw_count ? pyRound(r.total_kj || 0, 0) : null,
      hr_count: r.hr_count || 0,
      power_count: r.pw_count || 0,
    };
  }

  _dateRange(startDate, endDate) {
    /** 返回 [start, end] Date 对象。start_date 缺省用数据最早; end_date 缺省用今天。 */
    if (!startDate) return [null, null];
    const s = parseDate(String(startDate).slice(0, 10));
    if (!s) throw new Error(`Invalid isoformat string: ${startDate}`);
    let e = endDate ? parseDate(String(endDate).slice(0, 10)) : new Date();
    if (!e) throw new Error(`Invalid isoformat string: ${endDate}`);
    if (!endDate) e = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    if (e < s) return [e, s];
    return [s, e];
  }

  daily(startDate = null, endDate = null) {
    /** 按天聚合; 范围内每一天都返回 (无骑行则为 0, 避免图表时间轴断裂)。 */
    const rows = this.getRides(startDate, endDate, 100000);
    const days = new Map();
    for (const a of rows) {
      const d = String(a.start_date || '').slice(0, 10);
      if (!parseDate(d)) continue;
      let day = days.get(d);
      if (!day) { day = emptyBucket(); days.set(d, day); }
      day.count += 1;
      day.dist_km += numOf(a.distance) / 1000;
      day.duration_h += numOf(a.moving_time) / 3600;
      day.elev_m += numOf(a.total_elevation_gain);
    }
    const [s, e] = this._dateRange(startDate, endDate);
    if (s && e) {
      const out = [];
      const d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      while (d <= e) {
        const k = fmtDate(d);
        out.push({ day: k, ...bucketOut(days.get(k) || emptyBucket()) });
        d.setDate(d.getDate() + 1);
      }
      return out;
    }
    return [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({ day: k, ...bucketOut(v) }));
  }

  weekly(startDate = null, endDate = null) {
    /** 按 ISO 周聚合; 范围内每周都返回 (无骑行则为 0)。 */
    const rows = this.getRides(startDate, endDate, 100000);
    const weeks = new Map();
    for (const a of rows) {
      const d = String(a.start_date || '').slice(0, 10);
      const dt = parseDate(d);
      if (!dt) continue;
      const [iy, iw] = isoCalendar(dt);
      const key = `${iy}-W${pad2(iw)}`;
      let w = weeks.get(key);
      if (!w) { w = emptyBucket(); weeks.set(key, w); }
      w.count += 1;
      w.dist_km += numOf(a.distance) / 1000;
      w.duration_h += numOf(a.moving_time) / 3600;
      w.elev_m += numOf(a.total_elevation_gain);
    }
    const [s, e] = this._dateRange(startDate, endDate);
    if (s && e) {
      // 从 start 所在周的周一到 end 所在周的周日, 逐周填
      const out = [];
      const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate() - (isoWeekday(s) - 1)); // 回退到周一
      const last = new Date(e.getFullYear(), e.getMonth(), e.getDate() + (7 - isoWeekday(e))); // 推到 end 周日
      while (cur <= last) {
        const [iy, iw] = isoCalendar(cur);
        const k = `${iy}-W${pad2(iw)}`;
        out.push({ week: k, ...bucketOut(weeks.get(k) || emptyBucket()) });
        cur.setDate(cur.getDate() + 7);
      }
      return out;
    }
    return [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({ week: k, ...bucketOut(v) }));
  }

  monthly(startDate = null, endDate = null) {
    /** 按月份聚合; 范围内每月都返回 (无骑行则为 0)。 */
    const rows = this.getRides(startDate, endDate, 100000);
    const months = new Map();
    for (const a of rows) {
      const d = String(a.start_date || '').slice(0, 10);
      const dt = parseDate(d);
      if (!dt) continue;
      const key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
      let m = months.get(key);
      if (!m) { m = emptyBucket(); months.set(key, m); }
      m.count += 1;
      m.dist_km += numOf(a.distance) / 1000;
      m.duration_h += numOf(a.moving_time) / 3600;
      m.elev_m += numOf(a.total_elevation_gain);
    }
    const [s, e] = this._dateRange(startDate, endDate);
    if (s && e) {
      const out = [];
      let y = s.getFullYear();
      let mo = s.getMonth() + 1;
      while (y < e.getFullYear() || (y === e.getFullYear() && mo <= e.getMonth() + 1)) {
        const k = `${y}-${pad2(mo)}`;
        out.push({ month: k, ...bucketOut(months.get(k) || emptyBucket()) });
        mo += 1;
        if (mo > 12) { mo = 1; y += 1; }
      }
      return out;
    }
    return [...months.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({ month: k, ...bucketOut(v) }));
  }

  yearly(startDate = null, endDate = null) {
    /** 按年聚合 (返回年度汇总) */
    const rows = this.getRides(startDate, endDate, 100000);
    const years = new Map();
    for (const a of rows) {
      const d = String(a.start_date || '').slice(0, 10);
      const dt = parseDate(d);
      if (!dt) continue;
      const key = `${dt.getFullYear()}`;
      let y = years.get(key);
      if (!y) { y = emptyBucket(); years.set(key, y); }
      y.count += 1;
      y.dist_km += numOf(a.distance) / 1000;
      y.duration_h += numOf(a.moving_time) / 3600;
      y.elev_m += numOf(a.total_elevation_gain);
    }
    return [...years.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({ year: k, ...bucketOut(v) }));
  }

  // ---- 训练建议记忆 (coach_memory) ----
  addMemory(role, content) {
    /** 追加一条对话记忆(role: user|assistant),返回新 id */
    const r = this.db.prepare('INSERT INTO coach_memory(role,content,created_at) VALUES(?,?,?)')
      .run(String(role), String(content), localIsoNow());
    return Number(r.lastInsertRowid);
  }

  getMemory(limit = 40) {
    /** 取最近 limit 条(按时间正序返回,便于拼上下文) */
    const n = Math.max(1, Math.min(200, limit | 0));
    const rows = this.db.prepare('SELECT id,role,content,created_at FROM coach_memory ORDER BY id DESC LIMIT ?').all(n);
    return rows.reverse();
  }

  countMemory() {
    return this.db.prepare('SELECT COUNT(*) n FROM coach_memory').get().n;
  }

  clearMemory() {
    const r = this.db.prepare('DELETE FROM coach_memory').run();
    return Number(r.changes);
  }
}

// Python datetime.now().isoformat() 风格的本地时间戳 (补 6 位微秒)
function localIsoNow() {
  const d = new Date();
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${fmtDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ms}000`;
}
