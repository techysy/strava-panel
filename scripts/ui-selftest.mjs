/* 前端模块可执行性自检（零依赖，不参与打包）
 * 用法：node scripts/ui-selftest.mjs
 *
 * 背景：v2.6.1 曾把 trackmap.js 的 state() 函数误删、但 return 里仍引用，
 * 导致整个模块在解析期抛 ReferenceError —— TrackMap 从未定义，所有地图全挂。
 * 这类错误 node --check（只查语法）抓不到，CI 也只做语法检查就放行发版。
 * 本脚本用最小 Leaflet/DOM 桩真实执行各模块，确保「加载即成功」。
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

// ---- 最小 Leaflet + DOM 桩：只够让 IIFE 完成定义与导出 ----
function makeStub() {
  const chain = () => { const o = new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : chain(), apply: () => chain() }); return o; };
  const L = {
    map: () => ({ remove(){}, invalidateSize(){}, setView(){}, fitBounds(){}, zoomIn(){}, zoomOut(){}, getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 5, getContainer: () => stubEl(), addLayer(){}, on(){}, _container: stubEl() }),
    tileLayer: () => ({ addTo(){}, remove(){} }),
    polyline: () => ({ addTo(){}, remove(){} }),
    marker: () => ({ addTo(){}, remove(){}, bindTooltip(){}, on(){}, getLatLng: () => ({ lat: 0, lng: 0 }) }),
    divIcon: o => o, latLngBounds: () => ({ pad: () => ({}) }),
    control: o => ({ options: {}, onAdd: null, addTo(){}, ...(o || {}) }),
    DomUtil: { create: () => stubEl() },
    DomEvent: { disableClickPropagation(){}, disableScrollPropagation(){} },
  };
  function stubEl() {
    return {
      id: 'stub', style: {}, classList: { add(){}, remove(){}, toggle(){} },
      querySelector: () => stubEl(), querySelectorAll: () => [], appendChild(){}, remove(){},
      addEventListener(){}, insertAdjacentElement(){}, innerHTML: '', textContent: '',
    };
  }
  const document = { getElementById: () => null, createElement: () => stubEl(), querySelector: () => null, body: stubEl(), scripts: [] };
  const localStorage = { getItem: () => null, setItem(){} };
  return { L, document, localStorage, window: { addEventListener(){} } };
}

const MODULES = [
  ['../www/trackmap.js', 'TrackMap', ['show', 'clear', 'available', 'setTile', 'toggleFullscreen', 'rerenderFullscreen', 'state', 'drawOn', 'redrawTracks']],
  ['../www/fit.js', 'FIT', ['parse', 'summarize', 'cropRange', 'trackPointsIndexed', 'split', 'combine', 'toGpx', 'toTcx']],
  ['../www/gpx.js', 'GPX', ['parse', 'sample', 'profile', 'etaMinutes']],
  ['../www/fit-ui.js', 'FitUI', ['init', 'toggleCrop', 'cropApply', 'cropReset']],
];

console.log('\n[1] 模块加载（解析期不得抛错）');
for (const [file, name, methods] of MODULES) {
  const stub = makeStub();
  let err = null, exported = null;
  try {
    // 以脚本方式在桩环境里执行（与浏览器 <script> 语义一致：顶层 const 进入全局词法作用域）
    const fn = new Function('L', 'document', 'localStorage', 'window',
      read(file).replace(/^const (\w+) =/m, 'globalThis.__export =') + '\nreturn globalThis.__export;');
    exported = fn(stub.L, stub.document, stub.localStorage, stub.window);
  } catch (e) { err = e.name + ': ' + e.message; }
  ok(!err, `${name} 可执行且导出成功`, err || undefined);
  if (exported) {
    const missing = methods.filter(m => typeof exported[m] !== 'function');
    ok(!missing.length, `${name} 导出 API 完整（${methods.length} 项）`, missing);
  }
}

console.log('\n[2] 模块间符号闭合（UI 引用的 TrackMap API 必须存在）');
{
  const stub = makeStub();
  const load = (f, name) => new Function('L', 'document', 'localStorage', 'window',
    read(f).replace(/^const (\w+) =/m, 'globalThis.__export =') + '\nreturn globalThis.__export;')(stub.L, stub.document, stub.localStorage, stub.window);
  const TrackMap = load('../www/trackmap.js', 'TrackMap');
  const uiSrc = read('../www/fit-ui.js');
  const used = [...new Set([...uiSrc.matchAll(/TrackMap\.(\w+)\s*\(/g)].map(m => m[1]))];
  ok(used.length > 0, `fit-ui 调用 TrackMap（${used.join(', ')}）`);
  const undef = used.filter(m => typeof TrackMap[m] !== 'function');
  ok(!undef.length, 'fit-ui 用到的 TrackMap 方法全部存在', undef);
}

console.log('\n[3] 裁剪工具条里程单位（曾显示 9070.0 km / 实际 4.19 km）');
{
  const uiSrc = read('../www/fit-ui.js');
  // 抓 cropKm 实现并执行：输入已知两点（赤道上经度差 0.01° ≈ 1.1119 km）应得 ~1.11，不是 ~1111
  const m = uiSrc.match(/function cropKm\(i0, i1\) \{[\s\S]*?\n  \}/);
  ok(!!m, '找到 cropKm 实现');
  if (m) {
    const distM = uiSrc.match(/function TrackMapDist\(a, b\) \{[\s\S]*?\n  \}/)[0];
    const fn = new Function(distM + '\n' + m[0] + '\nlet crop={pts:[{lat:0,lon:0,idx:0},{lat:0,lon:0.01,idx:1}]}; return cropKm(0,1);');
    const km = fn();
    ok(km > 1.0 && km < 1.25, 'cropKm 返回千米（赤道 0.01° ≈ 1.11 km）', km);
    ok(km < 100, 'cropKm 无 1000 倍单位错误', km);
  }
}

console.log('\n[4] index.html 脚本顺序与引用');
{
  const html = read('../www/index.html');
  const order = [...html.matchAll(/<script src="\/static\/([\w.-]+\.js)/g)].map(m => m[1]);
  ok(order[0] === 'leaflet.js', 'leaflet 最先加载', order);
  ok(order.indexOf('trackmap.js') > order.indexOf('leaflet.js'), 'trackmap 在 leaflet 之后', order);
  // 内联脚本里的 TrackMap / FIT / GPX / FitUI 引用都必须有对应外部脚本
  const need = ['trackmap.js', 'fit.js', 'fit-ui.js', 'gpx.js'];
  const missing = need.filter(n => !order.includes(n));
  ok(!missing.length, '四个工具模块均已引入', missing);
}

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
