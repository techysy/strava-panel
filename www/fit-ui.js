/* ============================================================================
 * FIT 工具 UI —— 合并 / 拆分 / 删除功率·心率 / 转换 GPX·TCX
 * 全部在本地浏览器完成，文件不上传任何服务器。
 * ==========================================================================*/

const FitUI = (() => {
  const fitFiles = [];    // { name, bytes, sum }
  const $ = id => document.getElementById(id);

  const fmtDur = s => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + t('fit_durH') : '') + (h || m ? m + t('fit_durM') : '') + (h ? '' : ss + t('fit_durS'));
  };
  const fmtSize = b => b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
  const fmtTime = u => u ? new Date(u * 1000).toLocaleString() : '-';
  const cropBytesRev = new WeakSet();   // 已应用过裁剪的文件（避免文件名反复叠加 -crop）

  function renderList() {
    const box = $('fitFileList');
    if (!fitFiles.length) {
      box.innerHTML = '<div class="fit-empty" data-i18n="fit_empty">拖入 .fit 文件，或点击选择</div>';
      return;
    }
    box.innerHTML = fitFiles.map((f, i) => {
      const s = f.sum;
      const tags = [];
      if (s.has.power) tags.push('<b class="t-pw">' + escapeHtml(t('fit_stripPower')) + '</b>');
      if (s.has.hr) tags.push('<b class="t-hr">' + escapeHtml(t('fit_stripHr')) + '</b>');
      if (s.has.cadence) tags.push('<b class="t-cad">' + escapeHtml(t('fit_tagCad')) + '</b>');
      if (s.has.lat) tags.push('<b class="t-geo">' + escapeHtml(t('fit_tagGeo')) + '</b>');
      // 裁剪模式：卡片可点切换裁剪目标，当前目标高亮
      const cropCls = cropMode && crop && crop.fileIdx === i ? ' ff-crop-target' : '';
      const cropTag = cropMode && crop && crop.fileIdx === i ? '<b class="t-crop">' + escapeHtml(t('fit_cropTarget')) + '</b>' : '';
      const clickAttr = cropMode ? ` onclick="FitUI.cropSelectFile(${i})" style="cursor:pointer" title="${escapeHtml(t('fit_cropTargetHint'))}"` : '';
      return `<div class="fit-file${cropCls}" data-i="${i}"${clickAttr}>
        <div class="ff-main">
          <div class="ff-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="ff-meta">${s.points} ${escapeHtml(t('fit_tagPoints'))} · ${fmtDur(s.duration)} · ${s.distanceKm != null ? s.distanceKm.toFixed(2) + ' km' : escapeHtml(t('fit_noDist'))} · ${fmtSize(s.size)}</div>
          <div class="ff-tags">${cropTag}${tags.join('')}${s.crcOk ? '' : '<b class="t-bad">' + escapeHtml(t('fit_tagCrcBad')) + '</b>'}</div>
        </div>
        <div class="ff-time">${fmtTime(s.startUnix)}</div>
        <button class="ff-del" onclick="FitUI.remove(${i})" title="${escapeHtml(t('fit_remove'))}">×</button>
      </div>`;
    }).join('');
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      if (!/\.fit$/i.test(file.name)) { toast(t('fit_onlyFit') + ': ' + file.name, false); continue; }
      const buf = new Uint8Array(await file.arrayBuffer());
      let sum;
      try { sum = FIT.summarize(buf); }
      catch (e) { toast(t('fit_parseFail') + ': ' + file.name + ' - ' + e.message, false); continue; }
      if (!sum.points) { toast(t('fit_noPoints') + ': ' + file.name, false); continue; }
      if (!sum.crcOk) { toast(t('fit_crcBad') + ': ' + file.name, false); }
      fitFiles.push({ name: file.name, bytes: buf, sum });
    }
    crop = null;   // 文件集合变化，裁剪目标失效（下次进裁剪重新初始化）
    renderList();
    renderPanel();
  }

  function remove(i) {
    fitFiles.splice(i, 1);
    if (crop && crop.fileIdx === i) crop = null;              // 删的是裁剪目标 → 失效
    else if (crop && crop.fileIdx > i) crop.fileIdx--;        // 删的是前面的文件 → 索引前移
    if (!fitFiles.length) exitCrop();
    renderList(); renderPanel();
  }
  function clearAll() { fitFiles.length = 0; crop = null; exitCrop(); renderList(); renderPanel(); }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const baseName = (n) => n.replace(/\.fit$/i, '');

  // ---- 各工具执行 ----
  function runStrip() {
    const f = fitFiles[0];
    const dropPw = $('fitDropPower').checked, dropHr = $('fitDropHr').checked;
    if (!f) return;
    try {
      const r = FIT.stripFields(f.bytes, { power: dropPw, heartRate: dropHr });
      download(new Blob([r.bytes], { type: 'application/octet-stream' }), baseName(f.name) + '-stripped.fit');
      renderMap([r.bytes]);
      toast(t('fit_doneStrip', { n: r.count }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  function runSplit() {
    const f = fitFiles[0];
    if (!f) return;
    const mode = $('fitSplitMode').value;
    const opt = mode === 'gap'
      ? { mode: 'gap', gapSeconds: Number($('fitSplitGap').value) || 300 }
      : { mode: 'count', chunkSize: Number($('fitSplitCount').value) || 1000 };
    try {
      const files = FIT.split(f.bytes, opt);
      files.forEach((b, i) => {
        setTimeout(() => download(new Blob([b], { type: 'application/octet-stream' }),
          baseName(f.name) + `-part${i + 1}.fit`), i * 250);
      });
      renderMap(files);   // 拆分产物在地图上多色渲染
      toast(t('fit_doneSplit', { n: files.length }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  function runCombine() {
    if (fitFiles.length < 2) { toast(t('fit_needMulti'), false); return; }
    try {
      const r = FIT.combine(fitFiles.map(f => f.bytes));
      download(new Blob([r.bytes], { type: 'application/octet-stream' }), 'combined.fit');
      renderMap([r.bytes]);   // 合并产物在地图上渲染
      toast(t('fit_doneCombine', { n: r.count }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  function runConvert(fmt) {
    const f = fitFiles[0];
    if (!f) return;
    try {
      const name = $('fitActName').value.trim() || baseName(f.name);
      if (fmt === 'gpx') {
        download(new Blob([FIT.toGpx(f.bytes, name)], { type: 'application/gpx+xml' }), name + '.gpx');
      } else {
        download(new Blob([FIT.toTcx(f.bytes, name)], { type: 'application/xml' }), name + '.tcx');
      }
      toast(t('fit_doneConvert'), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  // 轨迹小地图：多文件多色；拆分/合并/删除后的产物同样可渲染
  // 裁剪模式（cropMode=true）：单文件轨迹 + 可拖 S/E 端点，实时预览保留区间
  let cropMode = false;
  let cropHandles = null;   // { s: marker, e: marker } Leaflet 可拖端点
  function renderMap(bytesList) {
    const wrap = $('fitMapWrap');
    if (!wrap) return;
    if (cropMode) { renderCropMap(); syncCropBtn(); return; }   // 非裁剪产物变化时也走裁剪渲染
    syncCropBtn();
    const src = bytesList || fitFiles.map(f => f.bytes);
    const tracks = src.map(b => { try { return FIT.trackPoints(b); } catch (e) { return []; } }).filter(p => p.length);
    if (!tracks.length || typeof TrackMap === 'undefined' || !TrackMap.available()) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    TrackMap.show('fitMap', tracks);
  }

  // ---- 裁剪模式：地图拖端点调整起止 ----
  // crop = { i0, i1 } 当前记录索引区间（含），持久到下一次进入裁剪或换目标文件。
  // 多文件时每个文件各自记忆裁剪区间（perFile 数组），点文件卡片切换裁剪目标。
  let crop = null;   // { i0, i1, pts: [{lat,lon,idx}], fileIdx }
  function initCropFor(fi) {
    try {
      const pts = FIT.trackPointsIndexed(fitFiles[fi].bytes);
      if (pts.length < 2) return false;
      crop = { i0: 0, i1: pts[pts.length - 1].idx, pts, fileIdx: fi };
      return true;
    } catch (e) { return false; }
  }
  function enterCrop() {
    if (!fitFiles.length) return;
    cropMode = true;
    // 上次的裁剪目标仍在文件列表里就沿用（区间也保留），否则落到第一个有 GPS 的文件
    if (!crop || !fitFiles[crop.fileIdx]) {
      const fi = fitFiles.findIndex(f => { try { return FIT.trackPointsIndexed(f.bytes).length >= 2; } catch (e) { return false; } });
      if (fi < 0 || !initCropFor(fi)) { cropMode = false; toast(t('fit_fail') + ' — no GPS', false); return; }
    }
    const st = (typeof TrackMap !== 'undefined') ? TrackMap.state('fitMap') : null;
    if (st) registerFs(st);
    renderList();
    renderPanel();
    renderCropMap();
    renderCropBar();
  }
  // 切换裁剪目标文件（点文件卡片）；再点当前目标 = 应用裁剪到列表
  function cropSelectFile(i) {
    if (!cropMode || !fitFiles[i]) return;
    if (crop && crop.fileIdx === i) { cropApply(); return; }
    if (!initCropFor(i)) { toast(t('fit_fail') + ' — no GPS', false); return; }
    renderList();
    renderCropMap();
    renderCropBar();
  }
  // 全屏回调注册（须在地图实例存在后调用；首次进全屏前若未注册，enterCrop 里兜底再试）
  function registerFs(st) {
    if (!st || st.fsRenderer) return;
    st.onFullscreen = (on) => {
      cropHandles = null;
      if (on && cropMode) {
        const bar = document.getElementById('fitCropBar');
        if (bar) st.fsShell.querySelector('.tm-fs-head').appendChild(bar);
      } else if (cropMode) {
        const bar = document.getElementById('fitCropBar');
        if (bar) $('fitMapWrap').insertAdjacentElement('afterend', bar);
      }
      renderCropMap(); renderCropBar();
    };
    st.fsRenderer = (map) => {
      if (!cropMode || !crop) {
        const tracks = fitFiles.map(f => { try { return FIT.trackPoints(f.bytes); } catch (e) { return []; } }).filter(p => p.length);
        if (tracks.length) { st.fsLayers = TrackMap.drawOn(map, tracks, { fit: true }); }
        return;
      }
      // 全屏裁剪：三色轨迹 + 可拖 S/E 端点（drawOn 会把端点挂到实例上）
      st.fsLayers = TrackMap.drawOn(map, cropTracks(), { fit: true, noAutoSE: true, handles: cropHandlesOpts() });
    };
  }
  function exitCrop() {
    cropMode = false;
    cropHandles = null;
    renderPanel();
  }
  function toggleCrop() { cropMode ? exitCrop() : enterCrop(); syncCropBtn(); }
  // 裁剪入口按钮态（无文件/裁剪中禁用与高亮）
  function syncCropBtn() {
    const b = document.getElementById('fitCropToggle');
    if (!b) return;
    b.classList.toggle('on', cropMode);
    b.disabled = !fitFiles.length;
    b.textContent = cropMode ? t('fit_cropDone') : t('fit_crop');
  }

  function renderCropBar() {
    let bar = document.getElementById('fitCropBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fitCropBar';
      bar.className = 'fit-cropbar';
      $('fitMapWrap').insertAdjacentElement('afterend', bar);
    }
    if (!cropMode || !crop) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    updateCropBarText();
  }
  // 只刷新区间/里程文本（拖拽中用），不动按钮
  function updateCropBarText() {
    const bar = document.getElementById('fitCropBar');
    if (!bar || !cropMode || !crop) return;
    if (!bar.querySelector('.fc-range')) { renderCropBarFull(bar); return; }
    const pts = crop.pts;
    bar.querySelector('.fc-range').textContent = t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length - 1].idx + 1 });
    bar.querySelector('.fc-meta').textContent = cropKm(crop.i0, crop.i1).toFixed(1) + ' km';
  }
  function cropKm(i0, i1) {
    let d = 0, prev = null;
    for (const p of crop.pts) { if (p.idx < i0 || p.idx > i1) continue; if (prev) d += TrackMapDist(prev, p); prev = p; }
    return d / 1000;   // TrackMapDist 返回米，工具条按 km 显示
  }
  function renderCropBarFull(bar) {
    const pts = crop.pts;
    bar.style.display = '';
    bar.innerHTML = '<span class="fc-t">' + escapeHtml(t('fit_cropTitle')) + '</span>'
      + '<span class="fc-range">' + escapeHtml(t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length-1].idx + 1 })) + '</span>'
      + '<span class="fc-meta">' + cropKm(crop.i0, crop.i1).toFixed(1) + ' km</span>'
      + '<button class="btn" onclick="FitUI.cropApply()" style="padding:4px 12px">' + escapeHtml(t('fit_cropApply')) + '</button>'
      + '<button class="btn" onclick="FitUI.cropDownload()" style="padding:4px 10px">' + escapeHtml(t('fit_cropDl')) + '</button>'
      + '<button class="btn" onclick="FitUI.cropReset()" style="padding:4px 10px">' + escapeHtml(t('fit_cropReset')) + '</button>'
      + '<button class="btn" onclick="FitUI.toggleCrop()" style="padding:4px 10px">' + escapeHtml(t('fit_cropDone')) + '</button>';
  }
  // 两点球面距离（米）——本地小工具，避免引 GPX 模块
  function TrackMapDist(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // 裁剪分段：目标文件三色（灰-裁掉/橙-保留/灰-裁掉）+ 可拖 S/E；
  // 其他文件淡灰背景（单文件时无）。全部轨迹都参与渲染，不再「全屏只剩一个文件」。
  function cropTracks() {
    if (!crop) return [];
    const pts = crop.pts;
    const segA = pts.filter(p => p.idx < crop.i0);
    const segKeep = pts.filter(p => p.idx >= crop.i0 && p.idx <= crop.i1);
    const segB = pts.filter(p => p.idx > crop.i1);
    const tracks = [];
    fitFiles.forEach((f, i) => {
      if (i === crop.fileIdx) return;
      try {
        const bg = FIT.trackPointsIndexed(f.bytes, 400);
        if (bg.length > 1) tracks.push({ latlngs: bg, color: '#c9c9c9', weight: 2.2, opacity: 0.55 });
      } catch (e) { /* 无 GPS 文件跳过 */ }
    });
    if (segA.length > 1) tracks.push({ latlngs: segA, color: '#b6b6b6' });
    if (segKeep.length > 1) tracks.push({ latlngs: segKeep, color: '#fc4c02' });
    if (segB.length > 1) tracks.push({ latlngs: segB, color: '#b6b6b6' });
    return tracks;
  }

  function renderCropMap() {
    const wrap = $('fitMapWrap');
    if (!wrap || !crop || typeof TrackMap === 'undefined' || !TrackMap.available()) { if (wrap) wrap.style.display = 'none'; return; }
    const st = TrackMap.state('fitMap');
    // 全屏态：由 st.fsRenderer 绘制到全屏地图（含可拖端点）
    if (st && st.fullscreen) { wrap.style.display = ''; TrackMap.rerenderFullscreen(st); return; }
    wrap.style.display = '';
    const tracks = cropTracks();
    // 首次进入裁剪才自动缩放；之后（拖拽松手/重绘）保留用户当前视图
    const st0 = TrackMap.state('fitMap');
    const firstFit = !st0 || !st0.cropHandles || !st0.cropHandles.length;
    TrackMap.show('fitMap', tracks, { fit: firstFit, noAutoSE: true, handles: cropHandlesOpts() });
  }
  // 吸附最近轨迹点，返回 { idx }（找不到则 null）
  function snapIdx(ll) {
    let best = null, bd = Infinity;
    for (const p of crop.pts) { const d = distM(ll, p); if (d < bd) { bd = d; best = p; } }
    return best ? best.idx : null;
  }
  // 端点配置（内嵌/全屏共用）：无裁剪会话返回 null（fsRenderer 兜底走普通渲染）。
  // 拖动中只更新区间并刷新工具条文本（不重建任何 Leaflet 对象，否则拖拽被打断）；
  // 松手（drop）才重绘折线并把端点吸附到新位置。
  function cropHandlesOpts() {
    if (!crop) return null;
    const pts = crop.pts;
    const apply = (kind, ll) => {
      const idx = snapIdx(ll);
      if (idx == null) return false;
      if (kind === 'a') crop.i0 = Math.min(idx, crop.i1 - 1);
      else crop.i1 = Math.max(idx, crop.i0 + 1);
      return true;
    };
    return {
      a: nearestPt(pts, crop.i0), b: nearestPt(pts, crop.i1),
      onDrag: (kind, ll) => { if (apply(kind, ll)) updateCropBarText(); },
      // 松手：重画折线并按新区间重建端点（a/b 本身就是吸附后的最近轨迹点）。
      // 拖拽已结束，重建不打断下一次拖拽；不传 handles 会让 clearLayers 把端点删掉不补（S/E 消失的根因）。
      onDrop: (kind, ll) => {
        apply(kind, ll);
        updateCropBarText();
        const st = TrackMap.state('fitMap');
        if (!st) return;
        TrackMap.redrawTracks(st, cropTracks(), { fit: false, noAutoSE: true, handles: cropHandlesOpts() });
      },
    };
  }
  function nearestPt(pts, idx) {
    let best = null;
    for (const p of pts) { if (best === null || Math.abs(p.idx - idx) < Math.abs(best.idx - idx)) best = p; }
    return best;
  }
  function distM(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // 生成裁剪产物（cropRange 出合法 FIT 字节）；失败返回 null
  function buildCrop() {
    if (!crop || !fitFiles[crop.fileIdx]) return null;
    const f = fitFiles[crop.fileIdx];
    // 已裁过的文件不再叠加 -crop 后缀（二次裁剪沿用原名）
    const stem = cropBytesRev.has(f) ? baseName(f.name) : baseName(f.name) + '-crop';
    try { return { bytes: FIT.cropRange(f.bytes, crop.i0, crop.i1 + 1), name: stem + '.fit', f }; }
    catch (e) { toast(t('fit_fail') + ' ' + e.message, false); return null; }
  }
  // 下载裁剪产物（原行为保留）
  function cropDownload() {
    const r = buildCrop();
    if (!r) return;
    const blob = new Blob([r.bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(t('fit_cropDone2'), true);
  }
  // 应用到列表：裁剪结果原地替换文件字节，多文件「各自裁完 → 直接合并」不出页面
  function cropApply() {
    const r = buildCrop();
    if (!r) return;
    const dropped = crop.i1 - crop.i0 + 1 !== r.f.sum.points;   // 区间是否真的裁过
    const fi = crop.fileIdx;
    r.f.bytes = r.bytes;
    r.f.sum = FIT.summarize(r.bytes);
    r.f.name = r.name;
    cropBytesRev.add(r.f);            // 标记已裁剪（防止重复命名叠加）
    // 字节已换：以新字节重建当前文件的裁剪会话（回到全区间）。
    // 不能把 crop 置 null 留着 cropMode——全屏态 fsRenderer/cropTracks 读 crop.pts 会炸，
    // 地图状态从此不一致（应用后退出全屏容器崩溃的根因）。
    if (!initCropFor(fi)) { crop = null; exitCrop(); }
    renderList(); renderPanel();
    toast(t('fit_cropApplied', { n: r.f.sum.points }), true);
    if (!dropped) toast(t('fit_cropNoop'), false);
  }
  function cropReset() {
    if (!crop) return;
    crop.i0 = 0; crop.i1 = crop.pts[crop.pts.length - 1].idx;
    renderCropMap(); renderCropBar();
  }

  function renderPanel() {
    const n = fitFiles.length;
    $('fitPanel').style.display = n ? '' : 'none';
    if (!n) return;
    const one = n >= 1;
    $('fitToolStrip').style.display = one ? '' : 'none';
    $('fitToolSplit').style.display = one ? '' : 'none';
    $('fitToolConvert').style.display = one ? '' : 'none';
    $('fitToolCombine').style.display = n >= 2 ? '' : 'none';
    $('fitCombineHint').textContent = t('fit_combineHint', { n });
    $('fitStripTarget').textContent = fitFiles[0] ? baseName(fitFiles[0].name) : '-';
    $('fitSplitTarget').textContent = fitFiles[0] ? baseName(fitFiles[0].name) : '-';
    $('fitConvertTarget').textContent = fitFiles[0] ? baseName(fitFiles[0].name) : '-';
    renderMap();
  }

  function init() {
    const drop = $('fitDrop');
    const input = $('fitInput');
    if (!drop || !input) return;
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', e => { addFiles(e.target.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { if (e.dataTransfer.files) addFiles(e.dataTransfer.files); });

    $('fitSplitMode').addEventListener('change', () => {
      const m = $('fitSplitMode').value;
      $('fitGapRow').style.display = m === 'gap' ? '' : 'none';
      $('fitCountRow').style.display = m === 'count' ? '' : 'none';
    });
    $('fitSplitMode').dispatchEvent(new Event('change'));
    renderList(); renderPanel();
  }

  return { init, addFiles, remove, clearAll, runStrip, runSplit, runCombine, runConvert, toggleCrop, cropApply, cropDownload, cropReset, cropSelectFile };
})();
