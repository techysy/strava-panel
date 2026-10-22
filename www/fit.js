/* ============================================================================
 * fit.js — 原生 FIT 文件工具（合并 / 拆分 / 删除功率·心率 / 转 GPX·TCX）
 *
 * 全部在浏览器本地完成，文件不上传任何服务器。
 *
 * FIT 文件结构（Garmin FIT Protocol）：
 *   [文件头 12 或 14 字节]
 *      0     headerSize   (12 或 14)
 *      1     protocolVer  (0x10 = 1.0, 0x20 = 2.0)
 *      2-3   profileVer   uint16 LE
 *      4-7   dataSize     uint32 LE  —— 后面记录区的字节数
 *      8-11  ".FIT"
 *      12-13 CRC          uint16 LE（仅 headerSize==14 时存在）
 *   [记录区：每条记录首字节为记录头]
 *      bit7=1 → 压缩时间戳记录（后续 2 字节时间偏移）
 *      bit6=1 → 定义消息（localMsgType / hasDev / reserved）
 *      bit6=0 → 数据消息（localMsgType）
 *   [文件尾 CRC]  uint16 LE，覆盖整个文件除最后 2 字节
 *
 * 每条记录都有 2 字节 CRC —— 改任何字节都必须重算，否则设备直接判定文件损坏。
 * ==========================================================================*/

const FIT = (() => {
  // ---- CRC16 (FIT Protocol) ----
  // FIT 用的是 16 项半字节表，每字节做两次查表（低 nibble → 高 nibble）。
  // 注意：不要替换成 256 项表 / 0x8408 逐位实现 —— 与这张表不兼容，生成的 CRC 全错。
  const CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400
  ];

  function crc16(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      let tmp = CRC_TABLE[crc & 0xF];
      crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[b & 0xF];
      tmp = CRC_TABLE[crc & 0xF];
      crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[(b >> 4) & 0xF];
    }
    return crc & 0xFFFF;
  }

  // 有符号基类型（sint8/16/32/64）：需要做二补码符号扩展
  const SIGNED = new Set([1, 3, 5, 14]);

  // ---- 基类型读写 ----
  // baseType 枚举见 FIT 规范 Profile；size 为该字段在记录中的字节宽度
  const BASE = {
    0:  { name: 'enum',   size: 1, read: v => v },
    1:  { name: 'sint8',  size: 1, read: v => (v << 24) >> 24 },
    2:  { name: 'uint8',  size: 1, read: v => v & 0xFF },
    3:  { name: 'sint16', size: 2, read: v => (v << 16) >> 16 },
    4:  { name: 'uint16', size: 2, read: v => v & 0xFFFF },
    5:  { name: 'sint32', size: 4, read: v => v | 0 },
    6:  { name: 'uint32', size: 4, read: v => v >>> 0 },
    7:  { name: 'string', size: 1, read: null },  // 按 NUL 截断
    8:  { name: 'float32', size: 4, read: v => v },
    9:  { name: 'float64', size: 8, read: v => v },
    10: { name: 'uint8z',  size: 1, read: v => v & 0xFF },
    11: { name: 'uint16z', size: 2, read: v => v & 0xFFFF },
    12: { name: 'uint32z', size: 4, read: v => v >>> 0 },
    13: { name: 'byte',   size: 1, read: v => v & 0xFF },
    14: { name: 'sint64', size: 8, read: v => v },
    15: { name: 'uint64', size: 8, read: v => v },
    16: { name: 'uint64z', size: 8, read: v => v },
  };

  // ---- FIT 无效值哨兵（Profile 规范）----
  // 全 1 位模式表示「字段存在但无值」：uint8=0xFF, uint16=0xFFFF, uint32=0xFFFFFFFF,
  // sint8=0x7F, sint16=0x7FFF, sint32=0x7FFFFFFF；*z 类型以 0 为无效。
  // 实测码表文件常见：record 的 distance/speed 等字段在停表瞬间写 0xFFFFFFFF。
  // 若当真实值用会得到天文数字（如 distance=0xFFFFFFFF cm ≈ 42949.67 km）。
  const INVALID_Z = new Set([10, 11, 12, 16]);   // *z 类型以 0 为无效
  // 无符号:全 1(0xFF/0xFFFF/0xFFFFFFFF)；有符号:最大正值(0x7F/0x7FFF/0x7FFFFFFF)
  const invMask = (base, size) => size >= 8 ? Number.MAX_SAFE_INTEGER
    : (SIGNED.has(base) ? Math.pow(2, size * 8 - 1) - 1 : Math.pow(2, size * 8) - 1);

  function readValue(view, off, size, baseType, little = true) {
    // string 单独处理：值按 NUL 截断，但字段在记录中始终占满声明的 size 字节，
    // 消费长度必须按 size 计，否则后续字段全部错位。
    if (baseType === 7) {
      let end = off;
      while (end < off + size && view.getUint8(end) !== 0) end++;
      return { value: latin1(view, off, end), size };
    }
    let v = 0;
    // 字节序按定义消息的 architecture 标志（0=小端,1=大端）；多数文件为小端
    for (let i = 0; i < size; i++) {
      const byte = view.getUint8(off + (little ? i : size - 1 - i));
      v += byte * Math.pow(2, i * 8);
    }
    // sintX 为有符号二补码，其余（enum/uintX/byte/string…）按实际位宽无符号解释。
    // 关键：位宽一律取定义消息里的 size，不能用基类型写死的宽度，
    // 因为 FIT 允许「基类型 uint16 但 size=4」这类不一致，写死会截掉高 16 位。
    let raw = v;
    if (size < 8) {
      const span = Math.pow(2, size * 8);
      raw = v % span;
      if (SIGNED.has(baseType) && raw >= span / 2) raw -= span;
    }
    // 无效哨兵 → null：调用方一律按「字段缺失」处理（距离/速度/心率等不会被天文数字污染）。
    // 写回时 serialize 会把 null 还原为哨兵，保证 parse→serialize 字节级往返一致。
    // 仅整数基类型参与（float 在本工具中从不消费，保持原始位模式往返更稳）。
    if (size < 8 && baseType !== 7 && baseType !== 8 && baseType !== 9) {
      const invalid = INVALID_Z.has(baseType) ? (raw === 0) : (raw === invMask(baseType, size));
      if (invalid) return { value: null, size };
    }
    return { value: raw, size };
  }

  function latin1(view, off, end) {
    let s = '';
    for (let i = off; i < end; i++) s += String.fromCharCode(view.getUint8(i));
    return s;
  }

  // ---- 全局消息号（本工具涉及的）----
  const MSG = { file_id: 0, device_info: 23, session: 18, lap: 19, record: 20, event: 21, activity: 34, sport: 12 };

  // record 消息里我们关心的字段号
  const REC = { timestamp: 253, position_lat: 0, position_long: 1, altitude: 2, heart_rate: 3, cadence: 4, distance: 5, speed: 6, power: 7, temperature: 13 };
  const SEMI = Math.pow(2, 31) / 180;   // 半圆/度：度 = 半圆 ÷ SEMI（FIT: 180° = 2^31 半圆）

  // ---- 解析 ----
  function parse(u8) {
    if (u8.length < 14) throw new Error('文件太小，不是有效的 FIT 文件');
    if (u8[8] !== 0x2E || u8[9] !== 0x46 || u8[10] !== 0x49 || u8[11] !== 0x54) {
      throw new Error('不是 FIT 文件（缺少 .FIT 魔数）');
    }
    const headerSize = u8[0];
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dataSize = view.getUint32(4, true);
    const dataStart = headerSize;
    const dataEnd = dataStart + dataSize;

    if (u8.length < dataEnd + 2) throw new Error('文件被截断（声明的数据长度超出实际文件大小）');

    // 校验尾部 CRC
    const fileCrc = view.getUint16(u8.length - 2, true);
    const calcCrc = crc16(u8, 0, u8.length - 2);
    const crcOk = fileCrc === calcCrc;

    // 校验头 CRC（仅 14 字节头）
    let headerCrcOk = true;
    if (headerSize === 14) {
      headerCrcOk = view.getUint16(12, true) === crc16(u8, 0, 12);
    }

    const defs = {};          // localMsgType → { global, fields:[{num,size,base}], dev:[] }
    const messages = [];      // { type:'def'|'data', local, global, fields, data, offset, end }
    let lastTs = 0;           // 压缩时间戳累积器
    let p = dataStart;

    // 压缩时间戳头（bit7=1）：local type 在 bits 5-6（仅 2 bit，共 4 种），
    // 时间偏移在 bits 0-4。它本质是数据消息，必须照常解析字段，只是 timestamp
    // 字段由累积器推出，而非内联在数据里。
    const cmpAccumulate = (raw, acc) => {
      const base = raw + (acc & ~0x1F);
      return raw < (acc & 0x1F) ? base + 32 : base;
    };

    while (p < dataEnd) {
      const recHeader = u8[p++];
      const isCompressed = (recHeader & 0x80) !== 0;
      const localType = isCompressed ? ((recHeader >> 5) & 0x3) : (recHeader & 0x0F);
      const isDef = isCompressed ? false : (recHeader & 0x40) !== 0;
      const hasDev = isCompressed ? false : (recHeader & 0x20) !== 0;

      if (isDef) {
        const reserved = u8[p++];
        if (reserved !== 0) throw new Error('定义消息 reserved 字节非法（可能文件已损坏）');
        const arch = u8[p++];
        if (arch !== 0 && arch !== 1) throw new Error('定义消息架构字节非法（仅支持 0/1）');
        const little = arch === 0;
        const global = little ? (u8[p] | (u8[p + 1] << 8)) : (u8[p] << 8 | u8[p + 1]);
        p += 2;
        const nFields = u8[p++];
        const fields = [];
        for (let i = 0; i < nFields; i++) {
          fields.push({ num: u8[p], size: u8[p + 1], base: u8[p + 2] });
          p += 3;
        }
        let dev = [];
        if (hasDev) {
          const nDev = u8[p++];
          for (let i = 0; i < nDev; i++) { dev.push({ num: u8[p], size: u8[p + 1], base: u8[p + 2] }); p += 3; }
        }
        defs[localType] = { global, fields, dev, little };
        messages.push({ type: 'def', local: localType, global, fields, dev, offset: p });
        continue;
      }

      const def = defs[localType];
      if (!def) throw new Error('数据消息引用了未定义的 local 类型 ' + localType + '（文件已损坏）');
      const data = {};
      let off = p;
      for (const f of def.fields) {
        const r = readValue(view, off, f.size, f.base, def.little !== false);
        data[f.num] = r.value;
        off += r.size;
      }
      // developer 字段跟在普通字段之后
      let devOff = off;
      const devData = {};
      for (const f of (def.dev || [])) {
        const r = readValue(view, devOff, f.size, f.base, def.little !== false);
        devData[f.num] = r.value;
        devOff += r.size;
      }
      let fields = def.fields;
      if (isCompressed) {
        // 压缩时间戳：偏移在头低 5 bit，累积器进位还原完整时间戳；
        // 时间戳字段不在消息体内，需补进字段表，序列化回普通消息时才能写出。
        lastTs = cmpAccumulate(recHeader & 0x1F, lastTs);
        data[REC.timestamp] = lastTs;
        if (!fields.some(f => f.num === REC.timestamp)) {
          fields = [{ num: REC.timestamp, size: 4, base: 4 }, ...fields];
        }
      } else if (def.global === MSG.record && data[REC.timestamp] != null) {
        lastTs = data[REC.timestamp];
      }
      messages.push({ type: 'data', local: localType, global: def.global, fields, dev: def.dev, data, devData, offset: p, end: devOff });
      p = devOff;
    }

    return { u8, view, headerSize, protocolVer: u8[1], dataSize, dataStart, dataEnd, defs, messages, crcOk, headerCrcOk, fileCrc, calcCrc };
  }

  // 按定义消息声明的 size 精确写出（不能用基类型写死的宽度：FIT 允许 size 与基类型不一致）
  function writeSized(out, value, baseType, size) {
    if (baseType === 7) {
      const s = String(value == null ? '' : value);
      const room = Math.max(1, size);
      for (let i = 0; i < room - 1; i++) out.push(i < s.length ? (s.charCodeAt(i) & 0xFF) : 0);
      out.push(0);
      return;
    }
    if ((baseType === 8 || baseType === 9)) {
      const b = new DataView(new ArrayBuffer(size));
      if (baseType === 8) b.setFloat32(0, Number(value) || 0, true);
      else b.setFloat64(0, Number(value) || 0, true);
      for (let i = 0; i < size; i++) out.push(b.getUint8(i));
      return;
    }
    let v = Math.floor(Number(value) || 0);
    // 负数按实际位宽截断（二补码低位）
    for (let i = 0; i < size; i++) {
      out.push((v % 256 + 256) % 256);
      v = Math.floor(v / 256);
    }
  }

  const defKey = (g, fields, dev) =>
    g + '|' + (fields || []).map(f => `${f.num}:${f.size}:${f.base}`).join(',') + '|' + (dev || []).map(f => `${f.num}:${f.size}:${f.base}`).join(',');

  // ---- 序列化：把消息重新写成一个合法 FIT 文件 ----
  // messages 需已调用 tagDefs() 打好 __defKey；定义消息自动去重并重新编号 local 类型。
  function serialize(messages, opts = {}) {
    const body = [];
    const byKey = new Map();      // defKey → { local, def }
    let nextLocal = 0;

    // 第一遍：收集所有用到的定义并编号
    for (const m of messages) {
      if (m.type !== 'data') continue;
      const k = m.__defKey;
      if (k === undefined) continue;
      if (byKey.has(k)) continue;
      const local = nextLocal++;
      byKey.set(k, { local, global: m.global, fields: m.fields, dev: m.dev });
      let h = local & 0x0F;
      if (m.dev && m.dev.length) h |= 0x20;
      h |= 0x40;
      body.push(h, 0, 0);
      body.push(m.global & 0xFF, (m.global >> 8) & 0xFF);
      body.push(m.fields.length);
      for (const f of m.fields) body.push(f.num, f.size, f.base);
      if (m.dev && m.dev.length) {
        body.push(m.dev.length);
        for (const f of m.dev) body.push(f.num, f.size, f.base);
      }
    }

    // 第二遍：写数据消息
    for (const m of messages) {
      if (m.type !== 'data') continue;
      const slot = byKey.get(m.__defKey);
      if (!slot) continue;
      body.push(slot.local & 0x0F);          // 数据记录头：bit6=0
      for (const f of m.fields) {
        const val = m.data[f.num];
        // undefined(字段无值)→0 保持旧行为；null(解析自无效哨兵)→写回哨兵，往返字节一致
        const out = val === undefined ? 0 : (val === null ? (INVALID_Z.has(f.base) ? 0 : invMask(f.base, f.size)) : val);
        writeSized(body, out, f.base, f.size);
      }
      if (m.dev && m.dev.length) {
        for (const f of m.dev) {
          const dv0 = m.devData ? m.devData[f.num] : undefined;
          const out = dv0 === undefined ? 0 : (dv0 === null ? (INVALID_Z.has(f.base) ? 0 : invMask(f.base, f.size)) : dv0);
          writeSized(body, out, f.base, f.size);
        }
      }
    }

    const headerSize = opts.headerSize || 12;
    const out = new Uint8Array(headerSize + body.length + 2);
    out[0] = headerSize;
    out[1] = opts.protocolVer || 0x20;
    const dv = new DataView(out.buffer);
    dv.setUint16(2, opts.profileVer || 2140, true);
    dv.setUint32(4, body.length, true);
    out[8] = 0x2E; out[9] = 0x46; out[10] = 0x49; out[11] = 0x54;   // ".FIT"
    for (let i = 0; i < body.length; i++) out[headerSize + i] = body[i] & 0xFF;
    dv.setUint16(headerSize + body.length, crc16(out, 0, headerSize + body.length), true);
    return out;
  }

  // 给每条 data 消息打上其所属定义的 key（serialize 需要）。
  // 以数据消息自身的字段表为准：压缩时间戳消息在 parse 时已把 253 补进字段表，
  // 若仍沿用原定义消息的 key，序列化时会写出与数据不符的字段布局。
  function tagDefs(parsed) {
    for (const m of parsed.messages) {
      if (m.type === 'data') m.__defKey = defKey(m.global, m.fields, m.dev);
    }
    return parsed;
  }

  // ---- 大圆距离（米）：record.distance 缺失/无效时由 GPS 轨迹兜底 ----
  const EARTH_R = 6371008.8;
  function haversineM(aLat, aLon, bLat, bLon) {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const SEMI_ = Math.pow(2, 31) / 180;   // 半圆/度（FIT: 180° = 2^31 半圆）
  // records 为已按时间排序的 record 消息数组；返回累计里程（米），无轨迹返回 null
  function gpsDistanceM(records) {
    let dist = 0, prev = null;
    for (const r of records) {
      const la = r.data[REC.position_lat], lo = r.data[REC.position_long];
      if (la == null || lo == null) continue;
      const lat = la / SEMI_, lon = lo / SEMI_;
      if (prev) dist += haversineM(prev[0], prev[1], lat, lon);
      prev = [lat, lon];
    }
    return prev ? dist : null;
  }
  // 优先 record.distance 累计字段，缺失/无效（null）时回退 GPS 轨迹
  function distanceMeters(records) {
    const first = records[0]?.data[REC.distance], last = records[records.length - 1]?.data[REC.distance];
    if (first != null && last != null && last >= first) return last - first;   // 单位 cm
    const gps = gpsDistanceM(records);
    return gps != null ? gps * 100 : null;
  }

  // ---- FIT 时间基准：1989-12-31 00:00:00 UTC = Unix 631065600 ----
  const FIT_EPOCH = 631065600;
  const fitToUnix = ts => (ts == null ? null : ts + FIT_EPOCH);
  const unixToFit = s => Math.floor(s - FIT_EPOCH);

  // ======================= 工具 1：删除功率 / 心率 =======================
  // 做法：从 record(20) 的定义消息里摘掉对应字段，数据消息同步不再写出。
  // 设备与 Strava 读的是定义消息，摘掉字段即彻底移除该数据（不是填 0）。
  function stripFields(u8, { power = true, heartRate = true } = {}) {
    const p = tagDefs(parse(u8));
    const drop = new Set();
    if (power) drop.add(REC.power);
    if (heartRate) drop.add(REC.heart_rate);
    if (!drop.size) throw new Error('没有选择要删除的字段');

    let removed = 0;
    const out = [];
    for (const m of p.messages) {
      if (m.type !== 'data') continue;
      if (m.global !== MSG.record) { out.push(m); continue; }
      const kept = m.fields.filter(f => !drop.has(f.num));
      removed += m.fields.length - kept.length ? 1 : 0;
      const nm = {
        type: 'data', local: m.local, global: m.global,
        fields: kept,
        dev: m.dev, devData: m.devData,
        data: {}, __defKey: defKey(m.global, kept, m.dev),
      };
      for (const f of kept) nm.data[f.num] = m.data[f.num];
      out.push(nm);
    }
    return { bytes: serialize(out, { protocolVer: p.protocolVer }), removed, count: out.filter(m => m.global === MSG.record).length };
  }

  // ======================= 工具 2：拆分 =======================
  // 按「时间断点」或「固定条数」把一条长活动切成多个文件。
  function split(u8, { mode = 'gap', gapSeconds = 300, chunkSize = 1000 } = {}) {
    const p = tagDefs(parse(u8));
    const dataMsgs = p.messages.filter(m => m.type === 'data');
    const records = dataMsgs.filter(m => m.global === MSG.record && m.data[REC.timestamp] != null);
    if (records.length < 2) throw new Error('该文件的采样点不足 2 条，无法拆分');

    // 找切点
    const cuts = [];   // 在 records 数组中的下标
    if (mode === 'count') {
      for (let i = chunkSize; i < records.length; i += chunkSize) cuts.push(i);
    } else {
      for (let i = 1; i < records.length; i++) {
        const dt = records[i].data[REC.timestamp] - records[i - 1].data[REC.timestamp];
        if (dt >= gapSeconds) cuts.push(i);
      }
    }
    if (!cuts.length) throw new Error(mode === 'count'
      ? `采样点仅 ${records.length} 条，未达到每份 ${chunkSize} 条`
      : `未找到超过 ${gapSeconds} 秒的时间断点（最大间隔 ${maxGap(records)} 秒），可用「按条数」方式拆分`);

    const bounds = [0, ...cuts, records.length];
    const files = [];
    for (let s = 0; s < bounds.length - 1; s++) {
      const slice = records.slice(bounds[s], bounds[s + 1]);
      if (!slice.length) continue;
      const first = slice[0], last = slice[slice.length - 1];
      const msgs = [];
      // 前置只保留元数据（file_id / device_info）；原文件的 event/lap/session
      // 不复制，统一在片段末尾按本段时间重新合成，避免出现重复计时事件。
      const baseTs = first.data[REC.timestamp];
      for (const m of dataMsgs) {
        if (m.global === MSG.file_id || m.global === MSG.device_info) msgs.push(m);
      }
      for (const r of slice) {
        const c = Object.assign({}, r);
        c.data = Object.assign({}, r.data);
        msgs.push(c);
      }
      // 合成 segment/lap/session 收尾消息，让设备能正常识别为一条完整活动
      const lastTs = last.data[REC.timestamp];
      const firstTs = first.data[REC.timestamp];
      const dur = lastTs - firstTs;
      const dist = distanceMeters(slice) ?? 0;   // cm；无效时 GPS 兜底
      const moveSec = calcMoveTime(slice);
      msgs.push(makeEvent(MSG.event, first.data, baseTs));
      msgs.push(makeLap(first.data, baseTs, dur, dist, moveSec));
      msgs.push(makeSession(first.data, baseTs, dur, dist, moveSec));
      files.push(serialize(msgs, { protocolVer: p.protocolVer }));
    }
    return files;
  }

  // ======================= 工具 5：按记录区间裁剪（地图拖端点） =======================
  // [startIdx, endIdx) 为 record 数组下标区间；复用 split 的片段重建逻辑
  // （保留 file_id/device_info 元数据，末尾合成 event/lap/session）。
  function cropRange(u8, startIdx, endIdx) {
    const p = tagDefs(parse(u8));
    const dataMsgs = p.messages.filter(m => m.type === 'data');
    const records = dataMsgs.filter(m => m.global === MSG.record && m.data[REC.timestamp] != null);
    const s = Math.max(0, Math.min(records.length - 1, Math.floor(startIdx) || 0));
    const e = Math.max(s + 1, Math.min(records.length, Math.floor(endIdx) || records.length));
    const slice = records.slice(s, e);
    if (!slice.length) throw new Error('裁剪区间为空');
    const first = slice[0], last = slice[slice.length - 1];
    const msgs = [];
    const baseTs = first.data[REC.timestamp];
    for (const m of dataMsgs) {
      if (m.global === MSG.file_id || m.global === MSG.device_info) msgs.push(m);
    }
    for (const r of slice) {
      const c = Object.assign({}, r);
      c.data = Object.assign({}, r.data);
      msgs.push(c);
    }
    const lastTs = last.data[REC.timestamp];
    const dur = lastTs - baseTs;
    const dist = distanceMeters(slice) ?? 0;
    const moveSec = calcMoveTime(slice);
    msgs.push(makeEvent(MSG.event, first.data, baseTs));
    msgs.push(makeLap(first.data, baseTs, dur, dist, moveSec));
    msgs.push(makeSession(first.data, baseTs, dur, dist, moveSec));
    return serialize(msgs, { protocolVer: p.protocolVer });
  }

  // 供 UI 拖端点用：返回按索引抽稀的轨迹点（点原始下标随行，拖动端点映射回 record 区间）
  function trackPointsIndexed(u8, maxPts = 1200) {
    const p = parse(u8);
    const recs = p.messages.filter(m => m.type === 'data' && m.global === MSG.record && m.data[REC.timestamp] != null);
    const withIdx = [];
    recs.forEach((r, i) => {
      const la = r.data[REC.position_lat], lo = r.data[REC.position_long];
      if (la == null || lo == null) return;
      withIdx.push({ lat: la / SEMI, lon: lo / SEMI, idx: i });
    });
    if (withIdx.length <= maxPts) return withIdx;
    const out = [];
    for (let i = 0; i < maxPts; i++) out.push(withIdx[Math.round(i * (withIdx.length - 1) / (maxPts - 1))]);
    return out;
  }

  function maxGap(records) {
    let m = 0;
    for (let i = 1; i < records.length; i++) {
      const d = records[i].data[REC.timestamp] - records[i - 1].data[REC.timestamp];
      if (d > m) m = d;
    }
    return m;
  }

  // 累计移动时间（秒）：过滤停表断点、红灯静止与跨文件衔接间隔
  function calcMoveTime(records) {
    if (!records || records.length < 2) return 0;
    let moveSec = 0;
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1].data, curr = records[i].data;
      const dt = curr[REC.timestamp] - prev[REC.timestamp];
      if (dt <= 0) continue;
      // 停表/长断点（>15 秒）视为暂停，不计入移动时间
      if (dt > 15) continue;

      let moving = false;
      const spd = curr[REC.speed];
      const d1 = curr[REC.distance], d0 = prev[REC.distance];

      if (spd != null && Number.isFinite(spd)) {
        // FIT speed: 1/1000 m/s，>0.5 m/s (500) 视为移动，过滤 GPS 漂移
        moving = spd > 500 || (spd > 0 && spd < 100 && spd > 0.5);
      } else if (d1 != null && d0 != null && d1 > d0) {
        // 无 speed 字段时看累计距离差值：速度 (d1-d0)/100 / dt > 0.5 m/s
        const deltaM = (d1 - d0) / 100;
        moving = deltaM / dt >= 0.5;
      } else if (curr[REC.position_lat] != null && prev[REC.position_lat] != null) {
        // 无距离字段时看 GPS 经纬度差值
        const dLat = (curr[REC.position_lat] - prev[REC.position_lat]) / SEMI;
        const dLon = (curr[REC.position_long] - prev[REC.position_long]) / SEMI;
        const degDist = Math.hypot(dLat, dLon * Math.cos((curr[REC.position_lat] / SEMI) * Math.PI / 180));
        const meterDist = degDist * 111320;
        moving = meterDist / dt >= 0.5;
      } else if (curr[REC.power] > 0 || curr[REC.cadence] > 0) {
        // 骑行台/室内无 GPS/距离，但有踏频或功率 > 0
        moving = true;
      } else {
        // 兜底：如果记录间隔紧密（<=5 秒），默认算作活动状态
        moving = dt <= 5;
      }

      if (moving) moveSec += dt;
    }
    return moveSec;
  }

  function makeEvent(global, sample, ts) {
    return {
      type: 'data', global, __defKey: defKey(global,
        [{ num: 253, size: 4, base: 4 }, { num: 0, size: 4, base: 4 }],
        null),
      fields: [{ num: 253, size: 4, base: 4 }, { num: 0, size: 4, base: 4 }],
      dev: null, devData: null,
      data: { 253: ts, 0: 0 },   // timer start
    };
  }
  function makeLap(sample, ts, dur, dist, moveTime) {
    const fields = [
      { num: 253, size: 4, base: 4 }, { num: 2, size: 4, base: 4 }, { num: 7, size: 4, base: 4 },
      { num: 8, size: 4, base: 4 }, { num: 9, size: 4, base: 4 }, { num: 15, size: 2, base: 4 },
      { num: 24, size: 1, base: 0 },
    ];
    const timer = (moveTime != null && moveTime > 0) ? moveTime : dur;
    return {
      type: 'data', global: MSG.lap, fields, dev: null, devData: null,
      __defKey: defKey(MSG.lap, fields, null),
      data: { 253: ts + dur, 2: ts, 7: dur * 1000, 8: timer * 1000, 9: dist, 15: 0, 24: 9 },
    };
  }
  function makeSession(sample, ts, dur, dist, moveTime) {
    const fields = [
      { num: 253, size: 4, base: 4 }, { num: 2, size: 4, base: 4 }, { num: 5, size: 1, base: 0 },
      { num: 7, size: 4, base: 4 }, { num: 8, size: 4, base: 4 }, { num: 9, size: 4, base: 4 },
      { num: 14, size: 2, base: 4 }, { num: 16, size: 2, base: 4 }, { num: 17, size: 2, base: 4 },
      { num: 26, size: 2, base: 4 },
    ];
    const timer = (moveTime != null && moveTime > 0) ? moveTime : dur;
    return {
      type: 'data', global: MSG.session, fields, dev: null, devData: null,
      __defKey: defKey(MSG.session, fields, null),
      data: { 253: ts + dur, 2: ts, 5: 2, 7: dur * 1000, 8: timer * 1000, 9: dist, 14: 0, 16: 0, 17: 0, 26: 0 },
    };
  }

  // ======================= 工具 3：合并 =======================
  // 把多个文件首尾相接成一条长活动：时间轴自动去重平移，采样点按时间排序，
  // 最后重建 lap/session。适合「码表分段记录」拼成一次完整骑行。
  function combine(files) {
    if (!files || files.length < 2) throw new Error('至少需要 2 个文件才能合并');
    const parsed = files.map(u8 => tagDefs(parse(u8)));

    let all = [];
    let offset = 0;
    let lastEnd = null;
    const defsPool = [];
    let sharedFileId = null;

    for (const p of parsed) {
      const recs = p.messages.filter(m => m.type === 'data' && m.global === MSG.record && m.data[REC.timestamp] != null);
      if (!recs.length) continue;
      const fid = p.messages.find(m => m.type === 'data' && m.global === MSG.file_id);
      if (!sharedFileId && fid) sharedFileId = fid;

      const first = recs[0].data[REC.timestamp];
      const last = recs[recs.length - 1].data[REC.timestamp];
      // 时间轴衔接：接不上就顺延（留 1 秒间隔），避免时间重叠/倒流
      let shift = 0;
      if (lastEnd != null) shift = Math.max(lastEnd + 1 - first, 0);

      for (const r of recs) {
        const c = Object.assign({}, r);
        c.data = Object.assign({}, r.data);
        c.data[REC.timestamp] = r.data[REC.timestamp] + shift;
        all.push(c);
      }
      lastEnd = last + shift;
      offset++;
    }
    if (!all.length) throw new Error('所有文件都没有有效的采样数据');
    all.sort((a, b) => a.data[REC.timestamp] - b.data[REC.timestamp]);

    const msgs = [];
    if (sharedFileId) {
      const c = Object.assign({}, sharedFileId);
      c.data = Object.assign({}, sharedFileId.data);
      c.__defKey = defKey(MSG.file_id, c.fields, c.dev);
      msgs.push(c);
    }
    msgs.push(...all);

    const firstTs = all[0].data[REC.timestamp];
    const lastTs = all[all.length - 1].data[REC.timestamp];
    const dur = lastTs - firstTs;
    const dist = distanceMeters(all) ?? 0;   // cm；无效时 GPS 兜底
    const moveSec = calcMoveTime(all);
    msgs.push(makeEvent(MSG.event, all[0].data, firstTs));
    msgs.push(makeLap(all[0].data, firstTs, dur, dist, moveSec));
    msgs.push(makeSession(all[0].data, firstTs, dur, dist, moveSec));

    return { bytes: serialize(msgs, { protocolVer: parsed[0].protocolVer }), count: all.length, files: offset };
  }

  // ======================= 工具 4：FIT → GPX / TCX =======================
  function toGpx(u8, name) {
    const p = tagDefs(parse(u8));
    const recs = p.messages.filter(m => m.type === 'data' && m.global === MSG.record && m.data[REC.timestamp] != null);
    if (!recs.length) throw new Error('文件内没有采样数据，无法转换');

    const xesc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const ts = new Date(FIT.fitToUnix(recs[0].data[REC.timestamp]) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

    const trkpts = recs.map(r => {
      const d = r.data;
      const lat = d[REC.position_lat] != null ? d[REC.position_lat] / SEMI : null;
      const lon = d[REC.position_long] != null ? d[REC.position_long] / SEMI : null;
      // altitude: uint16, scale 5, offset 500 → 单位米
      const ele = d[REC.altitude] != null ? (d[REC.altitude] - 500) / 5 : null;
      const time = new Date(FIT.fitToUnix(d[REC.timestamp]) * 1000).toISOString();
      let ext = '';
      if (d[REC.heart_rate] != null) ext += `<gpxtpx:hr>${d[REC.heart_rate]}</gpxtpx:hr>`;
      if (d[REC.cadence] != null) ext += `<gpxtpx:cad>${d[REC.cadence]}</gpxtpx:cad>`;
      if (d[REC.power] != null) ext += `<gpxtpx:atemp>`;   // 占位避免误标，实际功率用 power
      if (d[REC.power] != null) ext += `<power>${d[REC.power]}</power>`;
      return '        <trkpt lat="' + (lat == null ? '' : lat.toFixed(7)) + '" lon="' + (lon == null ? '' : lon.toFixed(7)) + '">' +
        (ele == null ? '' : '<ele>' + ele.toFixed(1) + '</ele>') +
        '<time>' + time + '</time>' +
        (ext ? '<extensions><gpxtpx:TrackPointExtension>' + ext + '</gpxtpx:TrackPointExtension></extensions>' : '') +
        '</trkpt>';
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Strava Panel" version="1.1"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><time>${ts}</time></metadata>
  <trk>
    <name>${xesc(name || 'FIT Activity')}</name>
    <type>cycling</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  }

  function toTcx(u8, name) {
    const p = tagDefs(parse(u8));
    const recs = p.messages.filter(m => m.type === 'data' && m.global === MSG.record && m.data[REC.timestamp] != null);
    if (!recs.length) throw new Error('文件内没有采样数据，无法转换');

    const xesc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    let dist = 0;   // TCX 的 DistanceMeters 是「自起点累计」，必须累加而非取单步增量
    const pts = recs.map((r, i) => {
      const d = r.data;
      if (i > 0 && d[REC.distance] != null && recs[i - 1].data[REC.distance] != null) {
        dist += d[REC.distance] - recs[i - 1].data[REC.distance];
      } else if (i > 0) {
        // distance 字段缺失/无效：用 GPS 增量续上累计值
        const la = d[REC.position_lat], lo = d[REC.position_long];
        const pla = recs[i - 1].data[REC.position_lat], plo = recs[i - 1].data[REC.position_long];
        if (la != null && lo != null && pla != null && plo != null) {
          dist += haversineM(pla / SEMI, plo / SEMI, la / SEMI, lo / SEMI) * 100;
        }
      }
      const lat = d[REC.position_lat] != null ? (d[REC.position_lat] / SEMI).toFixed(7) : '0';
      const lon = d[REC.position_long] != null ? (d[REC.position_long] / SEMI).toFixed(7) : '0';
      const ele = d[REC.altitude] != null ? ((d[REC.altitude] - 500) / 5).toFixed(1) : '0';
      const time = new Date(FIT.fitToUnix(d[REC.timestamp]) * 1000).toISOString();
      let ext = '';
      if (d[REC.heart_rate] != null) ext += `<ns3:HeartRateBpm><ns3:Value>${d[REC.heart_rate]}</ns3:Value></ns3:HeartRateBpm>`;
      if (d[REC.cadence] != null) ext += `<ns3:Cadence>${d[REC.cadence]}</ns3:Cadence>`;
      if (d[REC.power] != null) ext += `<ns3:Watts>${d[REC.power]}</ns3:Watts>`;
      return `          <Trackpoint>
            <Time>${time}</Time>
            <Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lon}</LongitudeDegrees></Position>
            <AltitudeMeters>${ele}</AltitudeMeters>
            <DistanceMeters>${(dist / 100).toFixed(2)}</DistanceMeters>
            ${ext ? `<Extensions>${ext}</Extensions>` : ''}
          </Trackpoint>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityTracking/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${new Date().toISOString()}</Id>
      <Lap StartTime="${new Date(FIT.fitToUnix(recs[0].data[REC.timestamp]) * 1000).toISOString()}">
        <TotalTimeSeconds>${(recs[recs.length - 1].data[REC.timestamp] - recs[0].data[REC.timestamp]).toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${((recs[recs.length - 1].data[REC.distance] || 0) / 100).toFixed(2)}</DistanceMeters>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${pts.replace(/^\s{10}/gm, '\n          ')}
        </Track>
      </Lap>
      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <Name>Strava Panel</Name>
        <UnitId>${xesc(0)}</UnitId>
        <Product><Name>Strava Panel FIT Tool</Name></Product>
      </Creator>
      <Name>${xesc(name || 'FIT Activity')}</Name>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
  }

  // ======================= 轨迹坐标提取（供地图渲染）=======================
  // 返回 [{lat, lon, ele?}]（度），无轨迹返回 []。抽稀：点数过多时等距取样，地图折线够用即可。
  function trackPoints(u8, maxPts = 2000) {
    const p = parse(u8);
    const recs = p.messages.filter(m => m.type === 'data' && m.global === MSG.record && m.data[REC.timestamp] != null);
    const pts = [];
    for (const r of recs) {
      const la = r.data[REC.position_lat], lo = r.data[REC.position_long];
      if (la == null || lo == null) continue;
      const ele = r.data[REC.altitude] != null ? (r.data[REC.altitude] - 500) / 5 : null;
      pts.push({ lat: la / SEMI, lon: lo / SEMI, ele });
    }
    if (pts.length <= maxPts) return pts;
    const out = [];
    for (let i = 0; i < maxPts; i++) out.push(pts[Math.round(i * (pts.length - 1) / (maxPts - 1))]);
    return out;
  }

  // ======================= 文件概览（供 UI 展示）=======================
  function summarize(u8) {
    const p = parse(u8);
    const recs = p.messages.filter(m => m.type === 'data' && m.global === MSG.record && m.data[REC.timestamp] != null);
    const fid = p.messages.find(m => m.type === 'data' && m.global === MSG.file_id);
    let distCm = null, lastTs = null;
    if (recs.length) {
      lastTs = recs[recs.length - 1].data[REC.timestamp];
      distCm = distanceMeters(recs);   // distance 字段无效时回退 GPS 轨迹
    }
    let has = { power: false, hr: false, cadence: false, lat: false, ele: false };
    for (const r of recs) {
      const d = r.data;
      if (d[REC.power] != null) has.power = true;
      if (d[REC.heart_rate] != null) has.hr = true;
      if (d[REC.cadence] != null) has.cadence = true;
      if (d[REC.position_lat] != null) has.lat = true;
      if (d[REC.altitude] != null) has.ele = true;
    }
    const duration = recs.length > 1 ? lastTs - recs[0].data[REC.timestamp] : 0;
    const maxG = recs.length > 1 ? maxGap(recs) : 0;

    // 移动时间：先从 records 计算（过滤停表与长断点）
    let moveTime = calcMoveTime(recs);
    // 若原文件包含官方 session 消息且有效：没有大断点 (maxGap < 20) 时优先尊重官方码表自带计时
    const sess = p.messages.find(m => m.type === 'data' && m.global === MSG.session);
    if (sess && sess.data) {
      const sessMoving = sess.data[20] != null && Number.isFinite(sess.data[20]) && sess.data[20] > 0
        ? Math.round(sess.data[20] / 1000) : null;
      const sessTimer = sess.data[8] != null && Number.isFinite(sess.data[8]) && sess.data[8] > 0
        ? Math.round(sess.data[8] / 1000) : null;
      const sessVal = sessMoving ?? sessTimer;
      if (sessVal != null && sessVal > 0 && sessVal <= duration && maxG < 20) {
        moveTime = sessVal;
      }
    }

    return {
      size: u8.length, crcOk: p.crcOk,
      points: recs.length,
      startUnix: recs.length ? FIT.fitToUnix(recs[0].data[REC.timestamp]) : null,
      endUnix: lastTs != null ? FIT.fitToUnix(lastTs) : null,
      duration,
      moveTime,
      distanceKm: distCm != null ? distCm / 100000 : null,   // cm → km
      manufacturer: fid ? fid.data[1] : null,
      product: fid ? fid.data[2] : null,
      maxGap: maxG,
      has,
    };
  }

  return {
    crc16, parse, serialize, tagDefs, BASE, MSG, REC,
    fitToUnix, unixToFit, FIT_EPOCH,
    stripFields, split, combine, toGpx, toTcx, summarize, trackPoints, cropRange, trackPointsIndexed,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FIT;
