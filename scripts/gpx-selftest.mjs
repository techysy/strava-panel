/* GPX 工具自验证（开发用，不参与打包）
 * 用法：node scripts/gpx-selftest.mjs
 * 覆盖：点提取 / haversine 距离 / 阈值爬升 / 里程等距采样 / 海拔剖面 / 坏点与回退 / ETA
 *
 * 距离真值用独立公式核对（不引第三方，直接按经纬度算大圆），
 * 爬升用「阈值累计法」的已知输入手算期望值。
 */
const _m = await import(new URL('../www/gpx.js', import.meta.url));
const GPX = _m.GPX || _m.default;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// 独立大圆距离（米），作为 GPX.haversine 的裁判
function refDist(aLat, aLon, bLat, bLon) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function trk(pts, tag = 'trkpt', wrap = true) {
  const body = pts.map(p => {
    const a = `lat="${p[0]}" lon="${p[1]}"`;
    return p[2] != null ? `<${tag} ${a}><ele>${p[2]}</ele></${tag}>` : `<${tag} ${a}/>`;
  }).join('');
  return wrap ? `<?xml version="1.0"?><gpx><trk><trkseg>${body}</trkseg></trk></gpx>` : body;
}

console.log('# GPX selftest');

// ---- 1. 基本解析：3 点带高程 ----
{
  // 沿同一经线向北每点 ~0.01°，纬度 1° ≈ 111195 m
  const g = trk([[30, 120, 100], [30.01, 120, 120], [30.02, 120, 110]]);
  const r = GPX.parse(g);
  ok(r.points.length === 3, 'trkpt 提取 3 点', r.points.length);
  ok(r.hasEle === true, 'hasEle=true');
  const seg = refDist(30, 120, 30.01, 120);
  ok(near(r.distanceKm * 1000, seg * 2, seg * 0.02), '距离≈2段大圆和', { got: r.distanceKm * 1000, want: seg * 2 });
  // 爬升: +20 越过阈值3计入; 下降 -10 计入 loss。gain=20 loss=10
  ok(r.elevGain === 20, 'elevGain=20', r.elevGain);
  ok(r.elevLoss === 10, 'elevLoss=10', r.elevLoss);
  ok(r.minEle === 100 && r.maxEle === 120, 'min/maxEle', [r.minEle, r.maxEle]);
  ok(near(r.points[2].cumKm, r.distanceKm, 1e-9), '末点 cumKm == distanceKm');
  ok(r.center && near(r.center.lat, 30.01, 1e-9), 'center.lat');
  ok(r.bounds && r.bounds.minLat === 30 && r.bounds.maxLat === 30.02, 'bounds.lat');
}

// ---- 2. haversine 与裁判一致 ----
{
  const a = { lat: 31.23, lon: 121.47 }, b = { lat: 39.90, lon: 116.40 };  // 上海→北京
  ok(near(GPX.haversine(a, b), refDist(a.lat, a.lon, b.lat, b.lon), 0.5), 'haversine==裁判', GPX.haversine(a, b));
}

// ---- 3. 阈值去噪：小抖动不计入爬升 ----
{
  // 100 → 100.5 → 100 → 100.5 …(±0.5m 抖动，阈值 1m 应吞掉)，末点回到基线
  // （阈值已与 fit.js 对齐为 1m：±1m 精确越阈会计入，与 FIT 行为一致）
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push([30 + i * 0.0001, 120, 100 + 0.5 * (i % 2)]);
  const r = GPX.parse(trk(pts));
  ok(r.elevGain === 0 && r.elevLoss === 0, '±0.5m 抖动爬升=0', [r.elevGain, r.elevLoss]);
}

// ---- 4. 持续爬升不丢：每步 +2m 共 10 步 = +20m（应全部计入）----
{
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push([30 + i * 0.0002, 120, 100 + i * 2]);
  const r = GPX.parse(trk(pts));
  ok(r.elevGain === 20, '持续爬升 gain=20', r.elevGain);
}

// ---- 5. 等距采样 ----
{
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push([30 + i * 0.001, 120, 100]);   // 沿经线均分
  const r = GPX.parse(trk(pts));
  const s = GPX.sample(r, 6);
  ok(s.length === 6, 'sample 返回 6 点', s.length);
  ok(s[0].distKm === 0 && near(s[5].distKm, r.distanceKm, 1e-9), 'sample 首尾=起终点', [s[0].distKm, s[5].distKm]);
  // 等距：相邻采样里程差应近似相等
  const d = [];
  for (let i = 1; i < s.length; i++) d.push(s[i].distKm - s[i - 1].distKm);
  ok(d.every(x => near(x, d[0], d[0] * 0.15)), 'sample 近似等距', d);
  ok(GPX.sample(r, 1).length === 2, 'sample n=1 归一到 2 点', GPX.sample(r, 1).length);
}

// ---- 6. 海拔剖面 ----
{
  const pts = [];
  for (let i = 0; i <= 50; i++) pts.push([30 + i * 0.001, 120, 100 + i]);   // 线性爬升
  const r = GPX.parse(trk(pts));
  const p = GPX.profile(r, 20);
  ok(p.length === 20, 'profile 20 桶', p.length);
  ok(p[0].ele <= p[p.length - 1].ele, 'profile 单调不减（线性爬升）', [p[0].ele, p[p.length - 1].ele]);
}

// ---- 7. 无高程 ----
{
  const r = GPX.parse(trk([[30, 120], [30.01, 120], [30.02, 120]]));
  ok(r.hasEle === false, 'hasEle=false');
  ok(r.elevGain === 0 && r.minEle === null, '无高程 gain=0/minEle=null', [r.elevGain, r.minEle]);
  ok(GPX.profile(r, 10).length === 0, 'profile 无高程返回 []');
}

// ---- 8. rtept 回退（无 trkpt）----
{
  const g = `<?xml version="1.0"?><gpx><rte><rtept lat="30" lon="120"><ele>100</ele></rtept><rtept lat="30.01" lon="120"><ele>110</ele></rtept></rte></gpx>`;
  const r = GPX.parse(g);
  ok(r.points.length === 2, 'rtept 回退提取 2 点', r.points.length);
  ok(r.elevGain === 10, 'rtept gain=10', r.elevGain);
}

// ---- 9. 单引号 / 属性乱序 / 自闭合混合 ----
{
  const g = `<gpx><trk><trkseg><trkpt lon='120' lat='30'/><trkpt lat='30.01' lon='120'></trkpt></trkseg></trk></gpx>`;
  const r = GPX.parse(g);
  ok(r.points.length === 2 && r.points[0].lat === 30, '单引号/乱序/自闭合解析', r.points);
}

// ---- 10. 坏点过滤（越界经纬度）----
{
  const g = `<gpx><trk><trkseg><trkpt lat="999" lon="120"/><trkpt lat="30" lon="120"/><trkpt lat="30.01" lon="120"/></trkseg></trk></gpx>`;
  const r = GPX.parse(g);
  ok(r.points.length === 2, '越界 lat=999 被过滤', r.points.length);
}

// ---- 11. 空/异常输入 ----
{
  let threw = false;
  try { GPX.parse('<gpx></gpx>'); } catch (e) { threw = true; }
  ok(threw, '无点时抛错');
  threw = false;
  try { GPX.parse(''); } catch (e) { threw = true; }
  ok(threw, '空串抛错');
}

// ---- 12. 多非连续段（多个 trkseg）----
{
  const g = `<gpx><trk>
    <trkseg><trkpt lat="30" lon="120"/><trkpt lat="30.01" lon="120"/></trkseg>
    <trkseg><trkpt lat="31" lon="121"/><trkpt lat="31.01" lon="121"/></trkseg>
  </trk></gpx>`;
  const r = GPX.parse(g);
  ok(r.tracks && r.tracks.length === 2, '识别到 2 个非连续轨迹段', r.tracks?.length);
  ok(r.tracks[0].length === 2 && r.tracks[1].length === 2, '各段点数正确');
  // 距离不应跨越 30,120 到 31,121 的 100 多公里断点
  ok(r.distanceKm < 5, '非连续段距离不虚增跨段间隔', r.distanceKm);
}

// ---- 13. ETA ----
{
  ok(GPX.etaMinutes(40, 20) === 120, 'ETA 40km@20km/h=120min', GPX.etaMinutes(40, 20));
  ok(GPX.etaMinutes(0, 20) === 0, 'ETA 0km=0');
  ok(GPX.etaMinutes(10, 0) === null, 'ETA 速度0=null', GPX.etaMinutes(10, 0));
  ok(GPX.etaMinutes(10, -5) === null, 'ETA 负速=null');
}

// ---- 14. 超大点数不炸栈（Math.min(...eles) 在 20 万点时 RangeError）----
{
  const N = 200000;
  let pts = '';
  for (let i = 0; i < N; i++) pts += `<trkpt lat="${(30 + i * 1e-6).toFixed(7)}" lon="120"><ele>${(500 + (i % 1000)).toFixed(1)}</ele></trkpt>`;
  const g = `<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
  let r = null, err = null;
  try { r = GPX.parse(g); } catch (e) { err = e; }
  ok(!err, '20 万点 GPX 解析不抛异常', err && err.message);
  if (r) {
    ok(r.minEle === 500, 'minEle 正确（循环求极值）', r.minEle);
    ok(r.maxEle === 1499, 'maxEle 正确（循环求极值）', r.maxEle);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
