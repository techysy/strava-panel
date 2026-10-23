/* FIT 工具自验证（开发用，不参与打包）
 * 用法：
 *   npm install fit-file-parser --no-save   # 独立裁判，仅测试需要
 *   node scripts/fit-selftest.mjs
 * 覆盖：CRC16 / 解析 / 大端 / 压缩时间戳 / 删除功率·心率 / 拆分 / 合并 / GPX·TCX / 概览
 */
// FIT 工具自验证：以第三方解析器 fit-file-parser 为独立裁判
import { readFitMessages, fitTimestampToUnixMilliseconds } from 'fit-file-parser';
const _m = await import(new URL('../www/fit.js', import.meta.url));
const FIT = _m.FIT || _m.default;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

// ---- 合成一个结构完整的 FIT：file_id + lap + session + record×N ----
function buildFit(opts = {}) {
  const hdrSize = 12, body = [];
  const defs = new Map();
  const pushDef = (local, global, fields, dev = []) => {
    let h = local & 0x0F; h |= 0x40; if (dev.length) h |= 0x20;
    body.push(h, 0, 0);
    body.push(global & 0xFF, (global >> 8) & 0xFF);
    body.push(fields.length);
    for (const f of fields) body.push(f.num, f.size, f.base);
    if (dev.length) { body.push(dev.length); for (const f of dev) body.push(f.num, f.size, f.base); }
    defs.set(local, { global, fields, dev });
  };
  const w = (v, n) => { for (let i = 0; i < n; i++) body.push(Math.floor(v / Math.pow(2, i * 8)) & 0xFF); };
  const wr = (s, n) => { const b = Buffer.from(s, 'latin1'); for (let i = 0; i < Math.min(b.length, n - 1); i++) body.push(b[i]); body.push(0); };
  const S32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); body.push(...b); };

  const HR = opts.withHr !== false, PW = opts.withPw !== false;
  const recFields = [
    { num: 253, size: 4, base: 4 },
    { num: 0, size: 4, base: 5 }, { num: 1, size: 4, base: 5 },
    { num: 2, size: 2, base: 4 }, { num: 5, size: 4, base: 4 }, { num: 6, size: 2, base: 4 },
  ];
  if (HR) recFields.push({ num: 3, size: 1, base: 2 });
  recFields.push({ num: 4, size: 1, base: 2 });
  if (PW) recFields.push({ num: 7, size: 2, base: 4 });

  pushDef(0, 0, [   // file_id
    { num: 0, size: 1, base: 0 }, { num: 1, size: 2, base: 4 },
    { num: 2, size: 2, base: 4 }, { num: 3, size: 4, base: 12 },
    { num: 4, size: 4, base: 4 }, { num: 5, size: 2, base: 2 },
  ]);
  body.push(0x00);
  body.push(4); w(1, 2); w(2697, 2); w(12345678, 4); w(opts.time || 1000000000, 4); w(2140, 2);

  pushDef(1, 20, recFields);                    // record
  pushDef(2, 19, [                                // lap
    { num: 253, size: 4, base: 4 }, { num: 2, size: 4, base: 4 },
    { num: 7, size: 4, base: 4 }, { num: 8, size: 4, base: 4 },
    { num: 9, size: 4, base: 4 }, { num: 15, size: 2, base: 4 }, { num: 24, size: 1, base: 0 },
  ]);
  pushDef(3, 18, [                                // session
    { num: 253, size: 4, base: 4 }, { num: 2, size: 4, base: 4 },
    { num: 5, size: 1, base: 0 }, { num: 7, size: 4, base: 4 },
    { num: 8, size: 4, base: 4 }, { num: 9, size: 4, base: 4 },
    { num: 14, size: 2, base: 4 }, { num: 16, size: 2, base: 4 },
    { num: 17, size: 2, base: 4 }, { num: 26, size: 2, base: 4 },
  ]);

  const N = opts.points ?? 5;
  const base = opts.time || 1000000000;
  const step = opts.step ?? 1;
  const gapAt = opts.gapAt;
  const gapLen = opts.gapLen ?? 1000;
  let t = base;
  for (let i = 0; i < N; i++) {
    if (gapAt != null && i === gapAt) t += gapLen;
    body.push(0x01);
    w(t, 4); S32(400000000 + i * 1000); S32(1170000000 + i * 1000);
    w(250 + i, 2); w(i * 1000, 4); w(50000, 2);
    if (HR) body.push(120 + i);
    body.push(85);
    if (PW) w(200 + i * 10, 2);
    t += step;
  }
  const lastT = t - step;
  body.push(0x02); w(lastT, 4); w(base, 4); w(lastT - base, 4); w((lastT - base) * 1000, 4); w(N * 1000, 4); w(85, 2); body.push(9);
  body.push(0x03); w(lastT, 4); w(base, 4); body.push(2); w(lastT - base, 4); w((lastT - base) * 1000, 4); w(N * 1000, 4);
  w(190, 2); w(95, 2); w(0, 2); w(150, 2);

  const total = hdrSize + body.length + 2, out = new Uint8Array(total);
  out[0] = hdrSize; out[1] = 0x20;
  const dv = new DataView(out.buffer);
  dv.setUint16(2, 2140, true); dv.setUint32(4, body.length, true);
  out[8] = 0x2E; out[9] = 0x46; out[10] = 0x49; out[11] = 0x54;
  for (let i = 0; i < body.length; i++) out[hdrSize + i] = body[i];
  dv.setUint16(hdrSize + body.length, FIT.crc16(out, 0, hdrSize + body.length), true);
  return out;
}

const readByOracle = (u8) => readFitMessages(new Uint8Array(u8), { mode: 'list' });
const fieldsOf = (r3, gmn) => r3.messages.filter(m => m.globalMessageNumber === gmn);
const val = (m, num) => { const f = m.fields.find(x => x.fieldNumber === num); return f ? decode(f.bytes, f.baseType, f.size) : undefined; };
function decode(bytes, baseType, size) {
  if (baseType === 7) return null;
  let v = 0; for (let i = 0; i < size; i++) v += bytes[i] * Math.pow(2, i * 8);
  if (size < 8) { const sp = Math.pow(2, size * 8); v = v % sp; if ([1, 3, 5, 14].includes(baseType) && v >= sp / 2) v -= sp; }
  return v;
}

console.log('\n[1] 基础解析 + CRC');
const f1 = buildFit();
const r1 = readByOracle(f1);
const m1 = FIT.parse(f1);
ok(m1.crcOk, '自校验 CRC 通过');
ok(r1.issues.filter(i => i.code === 'invalid_crc').length === 0, '独立解析器无 invalid_crc');
ok(fieldsOf(r1, 20).length === 5, '独立解析器读到 5 条 record', fieldsOf(r1, 20).length);
ok(m1.messages.filter(x => x.type === 'data' && x.global === 20).length === 5, '我的解析器读到 5 条 record');
const rec0 = fieldsOf(r1, 20)[0];
ok(val(rec0, 253) === 1000000000, 'record.timestamp 正确', val(rec0, 253));
ok(val(rec0, 0) === 400000000, 'record.position_lat 正确', val(rec0, 0));
ok(val(rec0, 2) === 250, 'record.altitude 正确', val(rec0, 2));
ok(val(rec0, 3) === 120, 'record.heart_rate 正确', val(rec0, 3));
ok(val(rec0, 7) === 200, 'record.power 正确', val(rec0, 7));

console.log('\n[2] CRC 抗错');
const t = Uint8Array.from(f1); t[40] ^= 0xFF;
ok(FIT.parse(t).crcOk === false, '篡改 1 字节 → CRC 失败');
let threw = false; try { readByOracle(t); } catch (e) { threw = e.code === 'invalid_crc'; }
ok(threw, '独立解析器也判定 invalid_crc');

console.log('\n[3] 时间基准');
for (const ts of [0, 1000000000, 4000000000]) {
  ok(fitTimestampToUnixMilliseconds(ts) === FIT.fitToUnix(ts) * 1000, `时间戳换算 ts=${ts}`);
}

// ================= 工具测试 =================
console.log('\n[4] 工具：删除功率/心率');
const fStrip = buildFit({ points: 6 });
const stripped = FIT.stripFields(fStrip, { power: true, heartRate: true });
const rStrip = readByOracle(stripped.bytes);
const stripRecs = fieldsOf(rStrip, 20);
ok(FIT.parse(stripped.bytes).crcOk, '输出 CRC 正确');
ok(stripRecs.length === 6, '采样点数量不变 (6)', stripRecs.length);
ok(stripRecs.every(r => r.fields.find(f => f.fieldNumber === 7) === undefined), 'power 字段已从定义消息移除');
ok(stripRecs.every(r => r.fields.find(f => f.fieldNumber === 3) === undefined), 'heart_rate 字段已从定义消息移除');
ok(stripRecs.every(r => val(r, 253) != null), '每条采样都仍有 timestamp');
const ts0 = val(stripRecs[0], 253), ts5 = val(stripRecs[5], 253);
ok(ts0 === 1000000000 && ts5 === 1000000005, '时间戳未被破坏', [ts0, ts5]);
ok(val(stripRecs[0], 4) === 85, 'cadence 保留');
ok(val(stripRecs[0], 0) === 400000000, '经纬度保留');

console.log('\n[5] 工具：拆分（按时间断点）');
const fSplit = buildFit({ points: 10, gapAt: 5, gapLen: 1000 });   // 第 6 个点前有 1000 秒断点
const parts = FIT.split(fSplit, { mode: 'gap', gapSeconds: 600 });
ok(parts.length >= 2, `按 600s 断点拆分 → ${parts.length} 份`, parts.length);
ok(parts.every(b => FIT.parse(b).crcOk), '每个分片 CRC 正确');
ok(parts.every(b => readByOracle(b).issues.filter(i => i.code === 'invalid_crc').length === 0), '独立解析器接受每个分片');
const partRecs = parts.map(b => fieldsOf(readByOracle(b), 20).length);
ok(partRecs.reduce((a,b)=>a+b,0) === 10, '分片采样点总数 = 原文件 (10)', partRecs);

console.log('\n[6] 工具：合并');
const cA = buildFit({ points: 5, time: 1000000000 });
const cB = buildFit({ points: 5, time: 1000000100 });
const combined = FIT.combine([cA, cB]);
const rC = readByOracle(combined.bytes);
ok(FIT.parse(combined.bytes).crcOk, '合并后 CRC 正确');
ok(fieldsOf(rC, 20).length === 10, '合并后采样点 = 5+5 = 10', fieldsOf(rC, 20).length);
const cTs = fieldsOf(rC, 20).map(r => val(r, 253));
ok(cTs.every((v, i) => i === 0 || v > cTs[i-1]), '时间戳严格递增（无重叠）', cTs);
ok(cTs[5] >= cTs[4] + 1, '第二段起点在第一段结束后', [cTs[4], cTs[5]]);

console.log('\n[7] 工具：转换 GPX/TCX');
const gpx = FIT.toGpx(fSplit, '测试骑行');
ok(gpx.includes('<gpx'), 'GPX 根元素正确');
ok((gpx.match(/<trkpt /g) || []).length === 10, 'GPX 含 10 个轨迹点', (gpx.match(/<trkpt /g) || []).length);
// 坐标精度回归：fixture lat=400000000 半圆 → 400000000·180/2^31 ≈ 33.5282°（曾错 32400 倍）
const gLat = +(gpx.match(/<trkpt lat="([\d.-]+)"/) || [])[1];
ok(gLat != null && Math.abs(gLat - 33.5282) < 0.001, 'GPX 纬度半圆→度换算正确 ≈33.5282', gLat);
ok(gpx.includes('<gpxtpx:hr>120</gpxtpx:hr>'), 'GPX 含心率扩展');
ok(gpx.includes('<power>200</power>'), 'GPX 含功率');
const tcx = FIT.toTcx(fSplit, '测试骑行');
ok(tcx.includes('<TrainingCenterDatabase'), 'TCX 根元素正确');
ok((tcx.match(/<Trackpoint>/g) || []).length === 10, 'TCX 含 10 个轨迹点');

console.log('\n[8] 文件概览');
const sum = FIT.summarize(fSplit);
ok(sum.points === 10, '概览采样点数', sum.points);
ok(sum.has.power && sum.has.hr && sum.has.cadence, '概览识别到功率/心率/踏频');
ok(sum.duration === 1009, '概览时长(秒，含1000秒断点)', sum.duration);
ok(sum.moveTime === 8, '概览移动时间(秒，已排除1000秒断点)', sum.moveTime);
ok(sum.maxGap === 1001, '概览最大时间断点(秒)', sum.maxGap);

// ================= 压缩时间戳 + 大端 =================
// 这两条路径是本轮修复的真 bug（旧实现运算符优先级错、完全忽略大端标志），
// 必须有回归覆盖。
console.log('\n[9] 压缩时间戳头');
function buildCompressed(){
  const hdr=12, body=[];
  const s32=v=>{const b=Buffer.alloc(4);b.writeInt32LE(v,0);body.push(...b);};
  const w=(v,n)=>{for(let i=0;i<n;i++)body.push(Math.floor(v/Math.pow(256,i))&0xFF);};
  // 定义 A（普通）：local0 global20 [timestamp(253), lat(0), lon(1), hr(3)]
  body.push(0x00|0x40,0,0); body.push(20,0); body.push(4);
  body.push(253,4,4); body.push(0,4,5); body.push(1,4,5); body.push(3,1,2);
  // 定义 B（压缩）：local1 global20 [lat, lon, hr] —— 不含 253
  body.push(0x01|0x40,0,0); body.push(20,0); body.push(3);
  body.push(0,4,5); body.push(1,4,5); body.push(3,1,2);
  const base=1000000000;
  body.push(0x00); w(base,4); s32(400000000); s32(1170000000); body.push(120);   // 播种累积器
  for(let i=1;i<=5;i++){
    const ch=0x80|((1&0x3)<<5)|((i*2)&0x1F);
    body.push(ch); s32(400000000+i*1000); s32(1170000000+i*1000); body.push(120+i);
  }
  const total=hdr+body.length+2, out=new Uint8Array(total);
  out[0]=hdr;out[1]=0x20;const dv=new DataView(out.buffer);
  dv.setUint16(2,2140,true);dv.setUint32(4,body.length,true);
  out[8]=0x2E;out[9]=0x46;out[10]=0x49;out[11]=0x54;
  for(let i=0;i<body.length;i++)out[hdr+i]=body[i];
  dv.setUint16(hdr+body.length, FIT.crc16(out,0,hdr+body.length), true);
  return out;
}
const cf=buildCompressed();
const cp=FIT.parse(cf);
ok(cp.crcOk,'压缩文件 CRC 正确');
const crecs=cp.messages.filter(m=>m.type==='data'&&m.global===20);
ok(crecs.length===6,'读到 6 条 record（1 普通 + 5 压缩）', crecs.length);
const cts=crecs.map(r=>r.data[253]);
ok(cts[0]===1000000000 && cts[5]===1000000010,'压缩偏移经累积器还原为完整时间戳', cts);
ok(crecs[1].data[3]===121,'压缩消息其余字段正确', crecs[1].data[3]);
ok(crecs[1].fields.some(f=>f.num===253),'压缩消息字段表补入 timestamp(253)');
FIT.tagDefs(cp);
const reCmp=FIT.serialize(cp.messages.filter(m=>m.type==='data'));
const rp=FIT.parse(reCmp);
ok(rp.crcOk,'压缩→普通 重序列化 CRC 正确');
const rrecs=rp.messages.filter(m=>m.type==='data'&&m.global===20);
ok(rrecs.length===6 && rrecs[0].data[253]===1000000000 && rrecs[5].data[253]===1000000010,'重序列化后时间戳保持', rrecs.map(r=>r.data[253]));
const rOracle = readByOracle(reCmp);
ok(rOracle.issues.filter(i=>i.code==='invalid_crc').length===0,'独立解析器接受重序列化结果');
ok(fieldsOf(rOracle,20).length===6,'独立解析器同样读到 6 条 record', fieldsOf(rOracle,20).length);

console.log('\n[10] 大端定义消息');
function buildBigEndian(){
  const hdr=12, body=[];
  const wBE=(v,n)=>{for(let i=0;i<n;i++)body.push(Math.floor(v/Math.pow(256,n-1-i))&0xFF);};
  body.push(0x00|0x40,0,1); body.push(0,20); body.push(2); body.push(253,4,4); body.push(3,1,2);
  body.push(0x00); wBE(1000000000,4); body.push(150);
  const total=hdr+body.length+2,out=new Uint8Array(total);
  out[0]=hdr;out[1]=0x20;const dv=new DataView(out.buffer);
  dv.setUint16(2,2140,true);dv.setUint32(4,body.length,true);
  out[8]=0x2E;out[9]=0x46;out[10]=0x49;out[11]=0x54;
  for(let i=0;i<body.length;i++)out[hdr+i]=body[i];
  dv.setUint16(hdr+body.length,FIT.crc16(out,0,hdr+body.length),true);
  return out;
}
const bp=FIT.parse(buildBigEndian());
const brec=bp.messages.find(m=>m.type==='data'&&m.global===20);
ok(brec && brec.data[253]===1000000000,'大端 timestamp 正确解析', brec&&brec.data[253]);
ok(brec && brec.data[3]===150,'大端 hr 正确', brec&&brec.data[3]);


console.log('\n[11] 工具：按记录区间裁剪（地图拖端点）');
// v2.6.1 新增 FIT.cropRange：保留 [startIdx, endIdx) 的记录，重建 event/lap/session。
// 此前只在发布时跑过临时脚本，未进正式套件 —— 本段补齐。
const fCrop = buildFit({ points: 50 });
const crop = FIT.cropRange(fCrop, 10, 40);                       // 保留第 11~40 条（30 条）
ok(FIT.parse(crop).crcOk, '裁剪产物 CRC 正确');
ok(readByOracle(crop).issues.filter(i => i.code === 'invalid_crc').length === 0, '独立解析器接受裁剪产物');
const cropRecs = fieldsOf(readByOracle(crop), 20);
ok(cropRecs.length === 30, '裁剪后 record 数 = 40-10 = 30', cropRecs.length);
const cts0 = val(cropRecs[0], 253), ctsN = val(cropRecs[cropRecs.length - 1], 253);
ok(cts0 === 1000000010 && ctsN === 1000000039, '首末时间戳对应原文件第 11/40 条', [cts0, ctsN]);
ok(fieldsOf(readByOracle(crop), 18).length === 1, '合成 1 条 session');
ok(fieldsOf(readByOracle(crop), 19).length === 1, '合成 1 条 lap');
const cropLap = fieldsOf(readByOracle(crop), 19)[0];
ok(val(cropLap, 7) === (ctsN - cts0) * 1000, 'lap.total_elapsed_time = 裁剪段时长', val(cropLap, 7));
ok(val(cropLap, 8) === (ctsN - cts0) * 1000, 'lap.total_timer_time = 裁剪段时长', val(cropLap, 8));
ok(fieldsOf(readByOracle(crop), 0).length === 1, 'file_id 元数据保留');
// 裁掉的前后数据不得泄漏
ok(!cropRecs.some(r => val(r, 253) < 1000000010 || val(r, 253) > 1000000039), '裁掉区间数据不出现在产物中');
// 边界：整段保留 / 单点 / 越界参数
const cropAll = FIT.cropRange(fCrop, 0, 50);
ok(fieldsOf(readByOracle(cropAll), 20).length === 50, '全区间裁剪保留 50 条');
const cropOne = FIT.cropRange(fCrop, 7, 8);
ok(fieldsOf(readByOracle(cropOne), 20).length === 1, '单点区间保留 1 条');
const cropClamp = FIT.cropRange(fCrop, -5, 999);
ok(fieldsOf(readByOracle(cropClamp), 20).length === 50, '越界参数被钳制到合法区间');

console.log('\n[12] trackPointsIndexed（裁剪端点吸附用）');
const ptsIdx = FIT.trackPointsIndexed(buildFit({ points: 100 }));
ok(ptsIdx.length === 100, '未超上限时返回全部 100 点', ptsIdx.length);
ok(ptsIdx[0].idx === 0 && ptsIdx[99].idx === 99, '首末点带原始 record 下标', [ptsIdx[0].idx, ptsIdx[99].idx]);
ok(ptsIdx.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)), '经纬度为有效数值');
// 坐标精度：lat=400000000 半圆 → 33.5282°
ok(Math.abs(ptsIdx[0].lat - 33.5282) < 0.001, 'trackPointsIndexed 坐标换算正确 ≈33.5282', ptsIdx[0].lat);
const dec = FIT.trackPointsIndexed(buildFit({ points: 3000 }), 1200);
ok(dec.length === 1200, '超上限时抽稀到 1200 点', dec.length);
ok(dec[0].idx === 0 && dec[dec.length - 1].idx === 2999, '抽稀保持首末点下标完整');
ok(dec.every((p, i) => i === 0 || p.idx > dec[i - 1].idx), '抽稀后下标严格递增（端点映射可靠）');

// 越界坐标垃圾点（非哨兵但超出 ±90/±180）必须被过滤——否则地图 fitBounds 撑到洲际尺度
{
  const f0 = buildFit({ points: 10 });
  // 手工注入一个 lat=150°（>90°）的 record：直接改解析后消息再不可行，用独立解析验证 validLatLon 语义
  const bad = FIT.trackPoints(f0);
  ok(bad.every(p => p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180), '正常文件坐标全部在合法范围');
  // 构造含越界点的文件：lat 半圆值 150° = 150*2^31/180
  const hdr=12, body=[];
  const w=(v,n)=>{for(let i=0;i<n;i++)body.push(Math.floor(v/Math.pow(2,i*8))&0xFF);};
  const S32=v=>{const b=Buffer.alloc(4);b.writeInt32LE(v,0);body.push(...b);};
  body.push(0x00|0x40,0,0); body.push(20,0); body.push(3);
  body.push(253,4,4); body.push(0,4,5); body.push(1,4,5);
  const base=1000000000;
  const lats=[30, 150, 31];   // 中间点 lat=150° 越界
  for(let i=0;i<3;i++){
    body.push(0x00);
    w(base+i,4);
    S32(Math.round(lats[i]*Math.pow(2,31)/180));
    S32(Math.round(120*Math.pow(2,31)/180));
  }
  const total=hdr+body.length+2,out=new Uint8Array(total);
  out[0]=hdr;out[1]=0x20;const dv=new DataView(out.buffer);
  dv.setUint16(2,2140,true);dv.setUint32(4,body.length,true);
  out[8]=0x2E;out[9]=0x46;out[10]=0x49;out[11]=0x54;
  for(let i=0;i<body.length;i++)out[hdr+i]=body[i];
  dv.setUint16(hdr+body.length,FIT.crc16(out,0,hdr+body.length),true);
  const tp = FIT.trackPoints(out);
  ok(tp.length===2, '越界坐标点（lat=150°）被过滤', tp.length);
  ok(tp.every(p=>p.lat>=-90&&p.lat<=90), '过滤后坐标全部合法', tp.map(p=>p.lat));
}

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
// ---- [11] 无效哨兵值（0xFFFFFFFF 等）→ null + GPS 距离兜底 + 字节级往返 ----
// 真机码表文件常见：停表瞬间 record.distance 写 0xFFFFFFFF（uint32 无效哨兵）。
// 旧实现当真实值用 → 42949.67 km。修复后应解析为 null 并由 GPS 轨迹兜底距离。
function buildSentinel() {
  const hdr=12, body=[];
  const w=(v,n)=>{for(let i=0;i<n;i++)body.push(Math.floor(v/Math.pow(2,i*8))&0xFF);};
  const S32=v=>{const b=Buffer.alloc(4);b.writeInt32LE(v,0);body.push(...b);};
  body.push(0x00|0x40,0,0); body.push(20,0); body.push(4);
  body.push(253,4,4); body.push(0,4,5); body.push(1,4,5); body.push(5,4,4);
  const base=1000000000;
  // 3 点沿经线间隔 0.001°（≈111.2m/段）；末点 distance 写无效哨兵
  const dists=[0,11120,0xFFFFFFFF];
  for(let i=0;i<3;i++){
    body.push(0x00);
    w(base+i,4);
    S32(Math.round((30+i*0.001)*Math.pow(2,31)/180));   // 度 → 半圆 = deg·2^31/180
    S32(Math.round(120*Math.pow(2,31)/180));
    w(dists[i],4);
  }
  const total=hdr+body.length+2,out=new Uint8Array(total);
  out[0]=hdr;out[1]=0x20;const dv=new DataView(out.buffer);
  dv.setUint16(2,2140,true);dv.setUint32(4,body.length,true);
  out[8]=0x2E;out[9]=0x46;out[10]=0x49;out[11]=0x54;
  for(let i=0;i<body.length;i++)out[hdr+i]=body[i];
  dv.setUint16(hdr+body.length,FIT.crc16(out,0,hdr+body.length),true);
  return out;
}
const sf=buildSentinel();
const sp=FIT.parse(sf);
const srecs=sp.messages.filter(m=>m.type==="data"&&m.global===20);
ok(srecs.length===3,"哨兵文件读到 3 条 record",srecs.length);
ok(srecs[0].data[5]===0&&srecs[1].data[5]===11120,"前两点 distance 正常",[srecs[0].data[5],srecs[1].data[5]]);
ok(srecs[2].data[5]===null,"末点 distance=0xFFFFFFFF 解析为 null",srecs[2].data[5]);
const ssum=FIT.summarize(sf);
ok(ssum.distanceKm!=null&&ssum.distanceKm>0.2&&ssum.distanceKm<0.25,"distance 无效时回退 GPS 轨迹 ≈0.222km",ssum.distanceKm);
ok(!(ssum.distanceKm>1000),"不再出现天文数字距离",ssum.distanceKm);
FIT.tagDefs(sp);
const srt=FIT.serialize(sp.messages);
ok(Buffer.from(srt).equals(Buffer.from(sf)),"parse→serialize 字节级一致（哨兵往返）");

// ---- [12] TCX DistanceMeters 为累计值（修复单步增量误当累计）----
const tf2=buildFit({points:5});
const tcx2=FIT.toTcx(tf2,"t");
// 注意：TCX 的 Lap/Activity 汇总里也有一个 DistanceMeters（总距离），Trackpoint 的在后
const dmAll=[...tcx2.matchAll(/<DistanceMeters>([\d.]+)<\/DistanceMeters>/g)].map(m=>+m[1]);
ok(dmAll[0]===40,"TCX Lap 汇总距离=40m",dmAll[0]);
const dm=dmAll.slice(1);
ok(dm.length===5,"TCX 5 个 Trackpoint DistanceMeters",dm.length);
ok(dm[0]===0&&dm[4]===40,"TCX 累计距离 0→40m",dm);
ok(dm.every((v,i)=>i===0||v>dm[i-1]),"TCX 累计距离单调递增",dm);

process.exit(fail ? 1 : 0);
