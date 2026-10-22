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
      // 步进减半（用户反馈跨度太大）。zoomSnap 保持 1——半级缩放会让 Esri 瓦片
      // 出现灰色空洞（半级瓦片缺失），只调步进不动吸附。
      zoomSnap: 1, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
    });
    // 默认浅色（Esri 素底，不花）；偏好键 sp-tiles（旧键 sp-map-tiles 作废）
    st = { map, layers: [], tile: null, tileKey: localStorage.getItem('sp-tiles') || 'light', markers: [], fullscreen: false, savedView: null };
    maps.set(id, st);
    setTile(st, st.tileKey);
    buildZoomCtl(st);
    buildFullCtl(st);
    // 容器尺寸变化（展开/收起、窗口缩放）后修正；从 0 尺寸恢复（tab 切回）时补画暂存的轨迹
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      if (st.fullscreen || !st.map || st.map._container !== host) return;
      try { st.map.invalidateSize(); } catch (e) {}
      if (st.pendingShow) {
        const p = st.pendingShow;
        st.pendingShow = null;
        try { show(host, p.tracks, p.opts); } catch (e) { console.error('pendingShow', e); }
      }
    });
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

  // ---- 全屏控件（左上、缩放按钮下方；同键进出，全屏态橙色高亮）----
  function buildFullCtl(st) {
    const ctl = L.control({ position: 'topleft' });
    ctl.options.className = 'tm-full-ctl';   // 外层 leaflet-control 附加类，用于与缩放控件的间距
    ctl.onAdd = () => {
      const box = L.DomUtil.create('div', 'tm-full');
      box.innerHTML = '<button type="button" data-f="1" title="fullscreen">⛶</button>';
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener('click', () => toggleFullscreen(st));
      return box;
    };
    ctl.addTo(st.map);
    syncFullBtn(st);
    return ctl;
  }
  // 全屏态高亮：⛶ 加橙色线框（用户反馈：同键进出 + 醒目状态提示）
  function syncFullBtn(st) {
    const host = st.map.getContainer();
    const btn = host && host.querySelector('.tm-full button');
    if (btn) btn.classList.toggle('on', !!st.fullscreen);
  }

  // ---- 全屏：fixed 覆盖层方案（Electron 窗口内不依赖浏览器 Fullscreen API 权限）----
  // 退出可被场景钩子拦截：st.confirmExit(proceed) 存在时先问场景（如 FIT 未应用草稿提示）
  function toggleFullscreen(st) {
    if (st.fullscreen) {
      if (st.confirmExit) st.confirmExit(() => exitFullscreen(st));
      else exitFullscreen(st);
    } else enterFullscreen(st);
  }
  function enterFullscreen(st) {
    const host = st.map.getContainer();
    // 浮层壳：实体头部（不悬浮，避免压住左上地图控件）+ 地图 + extra。
    // head 默认隐藏，场景 append 内容时显示（GPX 等无头部内容的场景保持隐藏）
    const shell = document.createElement('div');
    shell.className = 'tm-shell';
    shell.innerHTML = '<div class="tm-fs-head" style="display:none"><span class="tm-fs-title"></span></div>'
      + '<div class="tm-fs-map"></div>'
      + '<div class="tm-fs-extra"></div>';
    document.body.appendChild(shell);
    const fsMap = shell.querySelector('.tm-fs-map');
    // 迁移：Leaflet 不支持换容器，直接在新 host 上重建，迁移图层与视图
    const c = st.map.getCenter(), z = st.map.getZoom();
    clearLayers(st);       // 先摘图层，避免 remove() 期间对已脱离 DOM 的标记算位置
    st.map.remove();
    st.cropHandles = [];   // 旧地图实例上的标记已随 remove 失效，直接丢引用
    st.savedView = { host, center: c, zoom: z };
    const map2 = L.map(fsMap, {
      zoomControl: false, attributionControl: false, scrollWheelZoom: true,
      dragging: true, doubleClickZoom: true,
      zoomSnap: 1, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
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
    // 全屏地图上的 ⛶ 也要高亮（buildFullCtl 的 syncFullBtn 查的是旧容器）
    const fsBtn = fsMap.querySelector('.tm-full button');
    if (fsBtn) fsBtn.classList.add('on');
    if (st.onFullscreen) { try { st.onFullscreen(true, shell); } catch (e) { console.error('onFullscreen', e); } }
    setTimeout(() => { map2.invalidateSize(); rerenderFullscreen(st); }, 50);
  }
  function exitFullscreen(st) {
    if (!st.fullscreen) return;
    const orig = st.savedView;
    const cb = st.onFullscreen;
    st.fullscreen = false;
    // 顺序要紧：先摘图层再拆 shell。若先移除 shell，Leaflet 仍持有已脱离 DOM 的标记，
    // remove() 过程中重算位置会抛 `_leaflet_pos`（真机退出全屏必现）。
    clearLayers(st);
    if (st.fsShell) { st.fsShell.remove(); st.fsShell = null; }
    // 回迁：在原 host 重建
    st.map.remove();
    st.cropHandles = [];   // 同 enterFullscreen：旧实例标记引用直接丢弃
    let map2;
    try { map2 = L.map(orig.host, {
      zoomControl: false, attributionControl: false, scrollWheelZoom: false,
      dragging: true, doubleClickZoom: true,
      zoomSnap: 1, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
    }); } catch (e) {
      // 兜底：容器残留导致重建失败时，清空容器再试一次（避免退出后地图全空）
      console.error('exitFullscreen rebuild', e);
      orig.host.innerHTML = '';
      delete orig.host._leaflet_id;
      map2 = L.map(orig.host, {
        zoomControl: false, attributionControl: false, scrollWheelZoom: false,
        dragging: true, doubleClickZoom: true,
        zoomSnap: 1, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
      });
    }
    st.map = map2;
    st.layers = []; st.markers = [];
    setTile(st, st.tileKey);
    buildZoomCtl(st);
    buildFullCtl(st);
    st.fsMapEl = null;
    st.fsSideEl = null;
    setTimeout(() => {
      map2.invalidateSize();
      let redrawn = false;
      if (cb) { try { cb(false, orig.host); redrawn = true; } catch (e) { console.error('onFullscreen', e); } }
      // 场景回调缺失或抛错时兜底重绘：按 lastShow 恢复轨迹与标记，退出后不再空白
      if (!redrawn && st.lastShow) { try { drawOn(map2, st.lastShow.tracks, { markers: st.lastShow.markers, fit: true }); } catch (e) { console.error('exitFullscreen redraw', e); } }
      // 注意：不在此处 setView 覆盖——场景回调的 show() 已做过 fitBounds；
      // 只有在没有任何重绘时才回落保存视图，避免「退出后地图空白/跳回错误位置」
      if (!redrawn) map2.setView(orig.center, orig.zoom, { animate: false });
    }, 80);
  }
  // 全屏（重）绘当前轨迹：优先 fsRenderer（场景自定义），否则按 lastShow 重绘
  function rerenderFullscreen(st, opts) {
    if (st.fsRenderer) { try { st.fsRenderer(st.map, st.fsMapEl, st.fsShell?.querySelector('.tm-fs-extra'), opts); } catch (e) { console.error('fsRenderer', e); } return; }
    if (st.lastShow) drawOn(st.map, st.lastShow.tracks, { markers: st.lastShow.markers, fit: opts?.fit !== false });
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
    // 容器不可见（tab 未激活 / 外层 display:none）：此刻建图或画标记都会让 Leaflet
    // 在零尺寸下算位置并抛 `_leaflet_pos`。暂存参数，容器可见后补画。
    if (!host.clientWidth || !host.clientHeight) {
      const prev = maps.get(host.id);
      if (prev) prev.pendingShow = { tracks, opts };
      host.__tmPending = { tracks, opts };
      // 尚未建图时没有 ResizeObserver 兜底，这里挂一个一次性观察：可见后补画
      if (!prev && !host.__tmRo) {
        host.__tmRo = new ResizeObserver(() => {
          if (!host.clientWidth || !host.clientHeight) return;
          host.__tmRo.disconnect(); host.__tmRo = null;
          const p = host.__tmPending;
          if (p) { host.__tmPending = null; try { show(host, p.tracks, p.opts); } catch (e) { console.error('pendingShow', e); } }
        });
        host.__tmRo.observe(host);
      }
      return false;
    }
    // 容器已可见：若之前是隐藏态调用，本次即补画（清掉暂存）
    const st = ensureMap(host);
    if (host.__tmPending) { host.__tmPending = null; st.pendingShow = null; }
    clearLayers(st);
    const list = normTracks(tracks);
    const { all } = paintTracks(st, list, opts);
    // 可拖裁剪端点（fit 裁剪模式）：opts.handles = { a, b, onDrag(kind,ll), onDrop(kind,ll) }
    if (opts.handles) addHandles(st, opts.handles);
    // 记录最近一次绘制参数：进入全屏 / 退出全屏兜底重绘用
    st.lastShow = { tracks: list.map(tr => ({ latlngs: tr.latlngs, color: tr.color })), markers: opts.markers || [] };
    if (!all.length) { st.map.setView([30.5, 104.0], 5); }
    else if (opts.fit !== false) st.map.fitBounds(L.latLngBounds(all).pad(0.12), { animate: false });
    st.map.invalidateSize();
    return true;
  }

  function mk(st, p, kind, label, draggable) {
    const html = kind === 's' ? '<b>S</b>' : kind === 'e' ? '<b>E</b>' : '<i></i>';
    const opts = { icon: divIcon(html, 'tm-' + kind + (draggable ? ' tm-crop-handle' : '')), interactive: true };
    if (draggable) { opts.draggable = true; opts.zIndexOffset = 1000; }
    const m = L.marker([p.lat, p.lon], opts).addTo(st.map);
    if (label) m.bindTooltip(label, { direction: 'top', offset: [0, -8] });
    st.markers.push(m);
    return m;
  }

  // ---- 可拖裁剪端点：S/E 标记本身就是抓手（不画笨重徽章）----
  // opts.handles = { a:{lat,lon}, b:{lat,lon}, onDrag(kind,{lat,lon}), onDrop(kind,{lat,lon}) }
  // onDrag 拖动中持续触发（场景只更新工具条文本，禁止重建地图对象，否则拖拽被打断）；
  // onDrop 松手触发（场景提交索引并 redrawTracks 重绘折线 + 吸附端点）。
  function addHandles(st, h) {
    (st.cropHandles || []).forEach(m => m.remove());
    st.cropHandles = [];
    if (!h) return;
    [['a', 's', h.a], ['b', 'e', h.b]].forEach(([key, kind, p]) => {
      if (!p || !Number.isFinite(p.lat)) return;
      const hm = mk(st, p, kind, null, true);   // S/E 标记 = 抓手
      hm.on('drag', () => {
        const ll = hm.getLatLng();
        try { h.onDrag && h.onDrag(key, { lat: ll.lat, lon: ll.lng }); } catch (e) { console.error('handleDrag', e); }
      });
      hm.on('dragend', () => {
        const ll = hm.getLatLng();
        try { h.onDrop && h.onDrop(key, { lat: ll.lat, lon: ll.lng }); } catch (e) { console.error('handleDrop', e); }
      });
      st.cropHandles.push(hm);
    });
  }

  // 归一化 tracks 入参（show / drawOn / redrawTracks 共用）
  function normTracks(tracks) {
    return Array.isArray(tracks) && tracks.length && Array.isArray(tracks[0]) ? tracks.map((l, i) => ({ latlngs: l, color: PALETTE[i % PALETTE.length] }))
      : Array.isArray(tracks) && tracks.length && tracks[0].latlngs ? tracks
        : [{ latlngs: tracks || [], color: PALETTE[0] }];
  }
  // 在 st.map 上绘制折线组，返回 [layers, allLatLngs]
  function paintTracks(st, list, opts) {
    const made = [], all = [];
    list.forEach((tr, ti) => {
      const pts = (tr.latlngs || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (!pts.length) return;
      const ll = pts.map(p => [p.lat, p.lon]);
      all.push(...ll);
      made.push(L.polyline(ll, { color: tr.color || PALETTE[ti % PALETTE.length], weight: 3.5, opacity: 0.9, lineJoin: 'round' }).addTo(st.map));
      // 仅第一条轨迹自动 S/E；裁剪模式 noAutoSE 关闭（端点即拖点，S/E 会误导）
      if (ti === 0 && !opts.noAutoSE) {
        mk(st, pts[0], 's');
        if (pts.length > 1) mk(st, pts[pts.length - 1], 'e');
      }
    });
    (opts.markers || []).forEach(m => mk(st, m, m.kind || 'wp', m.label));
    return { made, all };
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
   * map 属于本模块的 TrackMap 实例时（常规情况）图层记入 st，后续 clearLayers/端点重建
   * 都由实例统一管理；否则退化为仅画折线。
   */
  function drawOn(map, tracks, opts = {}) {
    if (!available() || !map) return [];
    // 找到 map 所属实例：st.map 即该实例当前生效地图
    let st = null;
    for (const s of maps.values()) { if (s.map === map) { st = s; break; } }
    if (!st) return paintTracks({ layers: [], markers: [] }, normTracks(tracks), opts).made;
    clearLayers(st);
    const { made, all } = paintTracks(st, normTracks(tracks), opts);
    if (all.length && opts.fit !== false) map.fitBounds(L.latLngBounds(all).pad(0.12), { animate: false });
    if (opts.handles) addHandles(st, opts.handles);
    map.invalidateSize();
    return made;
  }

  /**
   * 仅重绘折线/标记，保留可拖端点与当前视图——裁剪拖拽松手后的局部刷新。
   * st 为 state() 返回的实例；内嵌/全屏皆适用（st.map 指向当前生效实例）。
   * 与 show() 的区别：不重建地图、不 fitBounds（视图不跳）。
   */
  function redrawTracks(st, tracks, opts = {}) {
    if (!st || !st.map) return;
    clearLayers(st);
    paintTracks(st, normTracks(tracks), opts);
    if (opts.handles) addHandles(st, opts.handles);
    st.map.invalidateSize();
  }

  // 取实例（供 UI 注册 onFullscreen/fsRenderer、拖端点后续操作）；未建图返回 null
  function state(idOrEl) { const host = el(idOrEl); return host ? maps.get(host.id) : null; }

  return { show, clear, available, setTile, toggleFullscreen, rerenderFullscreen, state, drawOn, redrawTracks };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrackMap;
