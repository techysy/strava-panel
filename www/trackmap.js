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
      zoomControl: true, attributionControl: false, scrollWheelZoom: false,
      dragging: true, doubleClickZoom: true,
    });
    // 默认浅色（CARTO positron，素底图不花）；偏好键 sp-tiles（旧键 sp-map-tiles 作废，
    // 避免测试期写入的脏偏好继续生效）
    st = { map, layers: [], tile: null, tileKey: localStorage.getItem('sp-tiles') || 'light', markers: [] };
    maps.set(id, st);
    setTile(st, st.tileKey);
    // 容器尺寸变化（展开/收起、窗口缩放）后修正
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(host);
    st.ro = ro;
    return st;
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
  }

  function clear(idOrEl) {
    const host = el(idOrEl);
    if (!host) return;
    const st = maps.get(host.id);
    if (!st) return;
    clearLayers(st);
  }

  return { show, clear, available, setTile };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrackMap;
