/* ============================================================================
 * gpx.js — 原生 GPX 解析（出行计划用：路线里程 / 爬升 / 海拔剖面 / 沿途采样）
 *
 * 全部在浏览器本地完成，文件不上传任何服务器（与 fit.js 同一约定）。
 *
 * 为什么手写解析而不用 DOMParser：
 *   1. 项目零依赖约定（同 fit.js 手写 FIT 二进制解析）；
 *   2. scripts/gpx-selftest.mjs 需在 Node 下直接 import 验证，Node 无 DOMParser。
 *   GPX 的 trkpt/rtept 结构足够规整，正则+属性解析即可稳定提取。
 *
 * 支持形态：
 *   - <trkpt lat lon> 内含 <ele>（主流：Garmin / Strava / 两步路 导出）
 *   - 自闭合 <trkpt lat lon />
 *   - 单双引号、属性顺序任意、多余空白
 *   - 无 <trk> 时回退 <rtept>（路由点）
 * ==========================================================================*/

const GPX = (() => {
  const EARTH_R = 6371008.8;   // 平均地球半径（米），IUGG 推荐值
  const ELE_THRESHOLD = 3;     // 爬升/下降累计阈值（米）：低于此的抖动视为 GPS 噪声

  // ---- 属性解析：lat="1.2" / lon='3.4' 皆可 ----
  function parseAttrs(s) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s || ''))) out[m[1]] = m[3] !== undefined ? m[3] : m[4];
    return out;
  }

  // ---- 提取轨迹点 ----
  // 捕获组: 1=标签名 2=属性串 3=（/> 或 >inner</tag>） 4=inner
  function extractByTag(xml, tag) {
    const re = new RegExp('<' + tag + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\s*' + tag + '\\s*>)', 'g');
    const pts = [];
    let m;
    while ((m = re.exec(xml))) {
      const a = parseAttrs(m[1]);
      const lat = parseFloat(a.lat), lon = parseFloat(a.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;   // 明显坏点
      const inner = m[2] || '';
      const em = inner.match(/<ele\b[^>]*>([\s\S]*?)<\/\s*ele\s*>/);
      const ele = em ? parseFloat(em[1]) : null;
      pts.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
    }
    return pts;
  }

  function extractPoints(xml) {
    const trk = extractByTag(xml, 'trkpt');
    if (trk.length) return trk;
    return extractByTag(xml, 'rtept');   // 无轨迹段时回退路由点
  }

  // ---- 提取轨迹片段（支持多 <trkseg>、多 <trk>、多 <rte>）----
  // 分离非连续段，避免 Leaflet 在断开的两段之间画直线穿帮
  function extractSegments(xml) {
    const segments = [];
    const segRe = /<trkseg\b[\s\S]*?<\/trkseg>/gi;
    let sm;
    while ((sm = segRe.exec(xml))) {
      const pts = extractByTag(sm[0], 'trkpt');
      if (pts.length) segments.push(pts);
    }
    if (segments.length) return segments;

    const trkRe = /<trk\b[\s\S]*?<\/trk>/gi;
    let tm;
    while ((tm = trkRe.exec(xml))) {
      const pts = extractByTag(tm[0], 'trkpt');
      if (pts.length) segments.push(pts);
    }
    if (segments.length) return segments;

    const rteRe = /<rte\b[\s\S]*?<\/rte>/gi;
    let rm;
    while ((rm = rteRe.exec(xml))) {
      const pts = extractByTag(rm[0], 'rtept');
      if (pts.length) segments.push(pts);
    }
    if (segments.length) return segments;

    const all = extractPoints(xml);
    return all.length ? [all] : [];
  }

  // ---- 大圆距离（米）----
  function haversine(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const la1 = a.lat * rad, la2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ---- 爬升/下降：阈值累计法（Strava 同类思路）----
  // 连续小增量累加到 pending，越过阈值才计入 —— 平稳爬升不丢，GPS 抖动不涨。
  function elevationGainLoss(pts, threshold) {
    const th = Number.isFinite(threshold) ? threshold : ELE_THRESHOLD;
    let gain = 0, loss = 0, pending = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1].ele, b = pts[i].ele;
      if (a == null || b == null) continue;   // 缺高程段跳过（不断链，交由下一次比较）
      pending += b - a;
      if (pending >= th) { gain += pending; pending = 0; }
      else if (pending <= -th) { loss += -pending; pending = 0; }
    }
    return { gain, loss };
  }

  /**
   * 解析 GPX 文本。
   * @returns {{points:Array<{lat:number,lon:number,ele:number|null,cumKm:number}>,
   *            distanceKm:number, elevGain:number, elevLoss:number,
   *            minEle:number|null, maxEle:number|null, hasEle:boolean,
   *            bounds:{minLat:number,minLon:number,maxLat:number,maxLon:number}|null,
   *            center:{lat:number,lon:number}|null}}
   */
  function parse(text) {
    const xml = String(text == null ? '' : text);
    const rawSegments = extractSegments(xml);
    if (!rawSegments.length || !rawSegments[0].length) throw new Error('no track points');

    // 累计里程：在各独立 segment 内部累计，跨非连续段不虚增距离
    let distM = 0;
    const points = [];
    const tracks = [];
    for (const seg of rawSegments) {
      const segPts = [];
      for (let i = 0; i < seg.length; i++) {
        if (i > 0) distM += haversine(seg[i - 1], seg[i]);
        const pt = { lat: seg[i].lat, lon: seg[i].lon, ele: seg[i].ele, cumKm: distM / 1000 };
        segPts.push(pt);
        points.push(pt);
      }
      if (segPts.length) tracks.push(segPts);
    }

    const gl = elevationGainLoss(points, ELE_THRESHOLD);
    const eles = points.map(p => p.ele).filter(v => v != null);
    let bounds = null, center = null;
    if (points.length) {
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const p of points) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      bounds = { minLat, minLon, maxLat, maxLon };
      center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
    }

    // 海拔极值用循环求——Math.min(...eles) 在点数很大时（>12 万，1Hz 长轨迹）
    // 会因实参数量超限抛 RangeError: Maximum call stack size exceeded，
    // 整个 GPX 随之不可用。
    let minEle = null, maxEle = null;
    for (const e of eles) {
      if (minEle === null || e < minEle) minEle = e;
      if (maxEle === null || e > maxEle) maxEle = e;
    }

    return {
      points,
      tracks,
      segments: tracks,
      distanceKm: distM / 1000,
      elevGain: gl.gain,
      elevLoss: gl.loss,
      minEle,
      maxEle,
      hasEle: eles.length > 0,
      bounds, center,
    };
  }

  /**
   * 沿里程等距采样（含起终点），供「沿途天气」按 ETA 取值。
   * @returns {Array<{lat:number,lon:number,ele:number|null,distKm:number}>}
   */
  function sample(parsed, n) {
    const pts = (parsed && parsed.points) || [];
    if (!pts.length) return [];
    const want = Math.max(2, Math.min(64, Math.floor(n) || 8));
    const total = parsed.distanceKm || pts[pts.length - 1].cumKm || 0;
    const out = [];
    for (let i = 0; i < want; i++) {
      const target = total * i / (want - 1);
      // 二分找第一个 cumKm >= target 的点（cumKm 单调不减）
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].cumKm < target) lo = mid + 1; else hi = mid; }
      const p = pts[lo];
      out.push({ lat: p.lat, lon: p.lon, ele: p.ele, distKm: p.cumKm });
    }
    return out;
  }

  /**
   * 海拔剖面重采样（等距 buckets），供 SVG 面积图。无高程时返回 []。
   * @returns {Array<{distKm:number, ele:number}>}
   */
  function profile(parsed, buckets) {
    const pts = ((parsed && parsed.points) || []).filter(p => p.ele != null);
    if (pts.length < 2) return [];
    const n = Math.max(2, Math.min(2000, Math.floor(buckets) || 160));
    const total = pts[pts.length - 1].cumKm || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const target = total * i / (n - 1);
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].cumKm < target) lo = mid + 1; else hi = mid; }
      out.push({ distKm: pts[lo].cumKm, ele: pts[lo].ele });
    }
    return out;
  }

  /** 匀速行驶用时（分钟）。speed<=0 视为无效返回 null。 */
  function etaMinutes(distanceKm, speedKmh) {
    const d = Number(distanceKm), s = Number(speedKmh);
    if (!Number.isFinite(d) || !Number.isFinite(s) || s <= 0) return null;
    return d / s * 60;
  }

  return { parse, sample, profile, haversine, etaMinutes, ELE_THRESHOLD, EARTH_R };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GPX;
