/* ============================================================================
 * trackmap.js — 轨迹小地图（Leaflet 本地离线库 + OSM/CARTO/卫星瓦片）
 *
 * 与 spot-studio 同一套方案：Leaflet 1.9.4 本地文件（www/leaflet.js|css），
 * 底图三选一切换（街道 OSM / 浅色 CARTO / 卫星 Esri）。瓦片为运行时数据请求，
 * 库本身不依赖任何 CDN（release-check 的「无外部 CDN」只约束代码依赖）。
 *
 * 用法：
 *   TrackMap.show(elOrId, latlngs, opts)
 *     latlngs: [{lat, lon, ele?}]（度）
 *     opts: { markers: [{lat, lon, label, kind}] , fit?: bool, height?: px }
 *   TrackMap.clear(elOrId)
 *   TrackMap.available()  → Leaflet 是否就绪（离线缺库时 UI 优雅降级）
 *
 * 标记用 divIcon（不依赖 leaflet 的 images/ 图标资源，spot-studio 同款做法）。
 * ==========================================================================*/

const TrackMap = (() => {
  const TILES = {
    street: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attr: '© OpenStreetMap contributors',
    },
    // 免 key 素底图：Esri Light Gray Canvas（CARTO 免费瓦片已改为必须 API key，
    // 匿名请求返回 "API KEY REQUIRED" 占位图，2026-10 起不可再用于无 key 场景）
    light: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      attr: '© Esri, Maxar, Earthstar Geographics',
    },
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attr: '© Esri, Maxar, Earthstar Geographics',
    },
  };
  const maps = new Map();   // containerId → { map, layer, tile, tileKey, markers:[] }

  function available() { return typeof L !== 'undefined'; }

  function el(idOrEl) { return typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl; }

  function divIcon(html, cls) {
    return L.divIcon({ html, className: 'tm-icon ' + (cls || ''), iconSize: [22, 22], iconAnchor: [11, 11] });
  }

  function ensureMap(host) {
    const id = host.id || (host.id = 'tm-' + Math.random().toString(36).slice(2, 8));
    let st = maps.get(id);
    if (st) return st;
    const map = L.map(host, {
      zoomControl: false, attributionControl: false, scrollWheelZoom: false,
      dragging: true, doubleClickZoom: true,
    });
    // 默认浅色（Esri 素底，不花）；偏好键 sp-tiles（旧键 sp-map-tiles 作废）
    st = { map, layers: [], tile: null, tileKey: localStorage.getItem('sp-tiles') || 'light', markers: [], fullscreen: false, savedView: null };
    maps.set(id, st);
    setTile(st, st.tileKey);
    buildZoomCtl(st);
    buildFullCtl(st);
    // 容器尺寸变化（展开/收起、窗口缩放）后修正
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(host);
    st.ro = ro;
    return st;
  }

  // ---- 自绘缩放控件（与面板视觉一致：surface 底/描边/圆角，替代 Leaflet 默认灰条）----
  function buildZoomCtl(st) {
    const ctl = L.control({ position: 'topleft' });
    ctl.onAdd = () => {
      const box = L.DomUtil.create('div', 'tm-zoom');
      box.innerHTML = '<button type="button" data-z="in" aria-label="zoom in">+</button>'
        + '<button type="button" data-z="out" aria-label="zoom out">−</button>';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      box.addEventListener('click', e => {
        const z = e.target?.dataset?.z;
        if (z === 'in') st.map.zoomIn();
        if (z === 'out') st.map.zoomOut();
      });
      return box;
    };
    ctl.addTo(st.map);
  }

  // ---- 全屏控件（右上角，与底图切换同排风格）----
  function buildFullCtl(st) {
    const ctl = L.control({ position: 'topright' });
    ctl.onAdd = () => {
      const box = L.DomUtil.create('div', 'tm-full');
      box.innerHTML = '<button type="button" data-f="1" title="fullscreen">⛶</button>';
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener('click', () => toggleFullscreen(st));
      return box;
    };
    ctl.addTo(st.map);
  }

  // ---- 全屏：fixed 覆盖层方案（Electron 窗口内不依赖浏览器 Fullscreen API 权限）----
  function toggleFullscreen(st) {
    if (st.fullscreen) exitFullscreen(st);
    else enterFullscreen(st);
  }
  function enterFullscreen(st) {
    const host = st.map.getContainer();
    // 浮层壳：铺满视口，内部重建一个等尺寸 host 供地图迁居
    const shell = document.createElement('div');
    shell.className = 'tm-shell';
    shell.innerHTML = '<div class="tm-fs-head"><span class="tm-fs-title"></span>'
      + '<button type="button" class="tm-fs-close" title="exit">✕</button></div>'
      + '<div class="tm-fs-map"></div>'
      + '<div class="tm-fs-extra"></div>';
    document.body.appendChild(shell);
    const fsMap = shell.querySelector('.tm-fs-map');
    // 迁移：Leaflet 不支持换容器，直接在新 host 上重建，迁移图层与视图
    const c = st.map.getCenter(), z = st.map.getZoom();
    st.map.remove();
    st.savedView = { host, center: c, zoom: z };
    const map2 = L.map(fsMap, {
      zoomControl: false, attributionControl: false, scrollWheelZoom: true,
      dragging: true, doubleClickZoom: true,
    });
    st.map = map2;
    st.layers = []; st.markers = [];
    setTile(st, st.tileKey);
    buildZoomCtl(st);
    buildFullCtl(st);
    // 全屏模式回调（各场景重绘自己的轨迹/浮窗）
    st.fullscreen = true;
    st.fsShell = shell;
    st.fsMapEl = fsMap;
    shell.querySelector('.tm-fs-close').addEventListener('click', () => exitFullscreen(st));
    if (st.onFullscreen) { try { st.onFullscreen(true, shell); } catch (e) { console.error('onFullscreen', e); } }
    setTimeout(() => { map2.invalidateSize(); rerenderFullscreen(st); }, 50);
  }
  function exitFullscreen(st) {
    if (!st.fullscreen) return;
    const orig = st.savedView;
    const cb = st.onFullscreen;
    st.fullscreen = false;
    if (st.fsShell) { st.fsShell.remove(); st.fsShell = null; }
    // 回迁：在原 host 重建
    st.map.remove();
    const map2 = L.map(orig.host, {
      zoomControl: false, attributionControl: false, scrollWheelZoom: false,
      dragging: true, doubleClickZoom: true,
    });
    st.map = map2;
    st.layers = []; st.markers = [];
    setTile(st, st.tileKey);
    buildZoomCtl(st);
    buildFullCtl(st);
    st.fsMapEl = null;
    setTimeout(() => {
      map2.invalidateSize();
      if (cb) { try { cb(false, orig.host); } catch (e) { console.error('onFullscreen', e); } }
      map2.setView(orig.center, orig.zoom, { animate: false });
    }, 50);
  }
  // 全屏（重）绘当前轨迹：优先 fsRenderer（场景自定义），否则按 lastShow 重绘
  function rerenderFullscreen(st) {
    if (st.fsRenderer) { try { st.fsRenderer(st.map, st.fsMapEl, st.fsShell?.querySelector('.tm-fs-extra')); } catch (e) { console.error('fsRenderer', e); } return; }
    if (st.lastShow) drawOn(st.map, st.lastShow.tracks, { markers: st.lastShow.markers, fit: true });
  }

  function setTile(st, key) {
    const cfg = TILES[key] || TILES.street;
    if (st.tile) st.tile.remove();
    st.tile = L.tileLayer(cfg.url, { attribution: cfg.attr, subdomains: cfg.sub || 'abc', maxZoom: 19 }).addTo(st.map);
    st.tileKey = key;
    try { localStorage.setItem('sp-tiles', key); } catch (e) {}
    // 切换控件
    let ctl = st.map._container.querySelector('.tm-tiles');
    if (!ctl) {
      ctl = document.createElement('div');
      ctl.className = 'tm-tiles';
      const order = ['light', 'street', 'sat'];   // 浅色（默认）排第一
      const lab = { street: 'map_street', light: 'map_light', sat: 'map_sat' };
      ctl.innerHTML = order.map(k => `<button type="button" data-k="${k}">${typeof t === 'function' ? t(lab[k]) : k}</button>`).join('');
      ctl.addEventListener('click', e => {
        const k = e.target?.dataset?.k;
        if (k) { setTile(st, k); }
      });
      st.map._container.appendChild(ctl);
    }
    ctl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === st.tileKey));
  }

  function clearMarkers(st) {
    (st.markers || []).forEach(m => m.remove());
    st.markers = [];
  }

  const PALETTE = ['#fc4c02', '#00b3a4', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#10b981', '#6366f1'];

  /**
   * 在容器内渲染一条或多条轨迹。
   * tracks: [{latlngs:[{lat,lon}], color?}] 或单条 latlngs 数组（兼容简写）。
   * opts.markers: [{lat, lon, label?, kind?: 's'|'e'|'wp'}]
   * 仅第一条轨迹自动加 S/E 起终点标记。
   */
  function show(idOrEl, tracks, opts = {}) {
    const host = el(idOrEl);
    if (!host) return false;
    if (!available()) { host.innerHTML = '<div class="tm-unavailable">' + (typeof t === 'function' ? t('map_unavailable') : 'map unavailable') + '</div>'; return false; }
    const st = ensureMap(host);
    clearLayers(st);
    const list = Array.isArray(tracks) && tracks.length && Array.isArray(tracks[0]) ? tracks.map((l, i) => ({ latlngs: l, color: PALETTE[i % PALETTE.length] }))
      : Array.isArray(tracks) && tracks.length && tracks[0].latlngs ? tracks
        : [{ latlngs: tracks || [], color: PALETTE[0] }];
    const all = [];
    list.forEach((tr, ti) => {
      const pts = (tr.latlngs || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (!pts.length) return;
      const ll = pts.map(p => [p.lat, p.lon]);
      all.push(...ll);
      st.layers.push(L.polyline(ll, { color: tr.color || PALETTE[ti % PALETTE.length], weight: 3.5, opacity: 0.9, lineJoin: 'round' }).addTo(st.map));
      if (ti === 0) {
        mk(st, pts[0], 's');
        if (pts.length > 1) mk(st, pts[pts.length - 1], 'e');
      }
    });
    (opts.markers || []).forEach(m => mk(st, m, m.kind || 'wp', m.label));
    // 可拖裁剪端点（fit 裁剪模式）：opts.handles = { a: {lat,lon}, b: {lat,lon}, onDrag(kind, latlng) }
    // 端点挂 st.cropHandles，由调用方通过 st.cropHandles[i].setLatLng 移动；show 的 clearLayers 不清它
    if (opts.handles) {
      st.cropHandles = [];
      [['a', 's', opts.handles.a], ['b', 'e', opts.handles.b]].forEach(([key, kind, p]) => {
        if (!p || !Number.isFinite(p.lat)) return;
        const icon = L.divIcon({ html: '<b>' + kind.toUpperCase() + '</b>', className: 'tm-icon tm-crop-handle', iconSize: [24, 24], iconAnchor: [12, 12] });
        const hm = L.marker([p.lat, p.lon], { icon, draggable: true, zIndexOffset: 1000 }).addTo(st.map);
        hm.on('drag', () => {
          const ll = hm.getLatLng();
          try { opts.handles.onDrag(key, { lat: ll.lat, lon: ll.lng }); } catch (e) { console.error('handleDrag', e); }
        });
        st.cropHandles.push(hm);
      });
    }
    // 记录最近一次绘制参数：进入全屏后 fsRenderer 重绘用
    st.lastShow = { tracks: list.map(tr => ({ latlngs: tr.latlngs, color: tr.color })), markers: opts.markers || [] };
    if (!all.length) { st.map.setView([30.5, 104.0], 5); }
    else if (opts.fit !== false) st.map.fitBounds(L.latLngBounds(all).pad(0.12), { animate: false });
    st.map.invalidateSize();
    return true;
  }

  function mk(st, p, kind, label) {
    const html = kind === 's' ? '<b>S</b>' : kind === 'e' ? '<b>E</b>' : '<i></i>';
    const m = L.marker([p.lat, p.lon], { icon: divIcon(html, 'tm-' + kind), interactive: !!label }).addTo(st.map);
    if (label) m.bindTooltip(label, { direction: 'top', offset: [0, -8] });
    st.markers.push(m);
  }

  function clearLayers(st) {
    (st.layers || []).forEach(l => l.remove());
    st.layers = [];
    clearMarkers(st);
    (st.cropHandles || []).forEach(m => m.remove());
    st.cropHandles = [];
  }

  function clear(idOrEl) {
    const host = el(idOrEl);
    if (!host) return;
    const st = maps.get(host.id);
    if (!st) return;
    clearLayers(st);
    st.lastShow = null;
  }

  /**
   * 在既有地图实例上直接绘制轨迹（不创建地图）——全屏 fsRenderer 用。
   * map 为 L.Map 实例；tracks/opts 形状同 show()。返回绘制的图层（调用方管理生命周期）。
   */
  function drawOn(map, tracks, opts = {}) {
    if (!available() || !map) return [];
    const list = Array.isArray(tracks) && tracks.length && Array.isArray(tracks[0]) ? tracks.map((l, i) => ({ latlngs: l, color: PALETTE[i % PALETTE.length] }))
      : Array.isArray(tracks) && tracks.length && tracks[0].latlngs ? tracks
        : [{ latlngs: tracks || [], color: PALETTE[0] }];
    const all = [];
    const made = [];
    list.forEach((tr, ti) => {
      const pts = (tr.latlngs || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (!pts.length) return;
      const ll = pts.map(p => [p.lat, p.lon]);
      all.push(...ll);
      made.push(L.polyline(ll, { color: tr.color || PALETTE[ti % PALETTE.length], weight: 3.5, opacity: 0.9, lineJoin: 'round' }).addTo(map));
    });
    (opts.markers || []).forEach(m => {
      const html = m.kind === 's' ? '<b>S</b>' : m.kind === 'e' ? '<b>E</b>' : '<i></i>';
      const mk2 = L.marker([m.lat, m.lon], { icon: divIcon(html, 'tm-' + (m.kind || 'wp')), interactive: !!m.label }).addTo(map);
      if (m.label) mk2.bindTooltip(m.label, { direction: 'top', offset: [0, -8] });
      made.push(mk2);
    });
    if (all.length && opts.fit !== false) map.fitBounds(L.latLngBounds(all).pad(0.12), { animate: false });
    map.invalidateSize();
    return made;
  }

  function state(idOrEl) { const host = el(idOrEl); return host ? maps.get(host.id) : null; }

  return { show, clear, available, setTile, toggleFullscreen, rerenderFullscreen, state, drawOn };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrackMap;
