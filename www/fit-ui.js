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
      return `<div class="fit-file" data-i="${i}">
        <div class="ff-main">
          <div class="ff-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="ff-meta">${s.points} ${escapeHtml(t('fit_tagPoints'))} · ${fmtDur(s.duration)} · ${s.distanceKm != null ? s.distanceKm.toFixed(2) + ' km' : escapeHtml(t('fit_noDist'))} · ${fmtSize(s.size)}</div>
          <div class="ff-tags">${tags.join('')}${s.crcOk ? '' : '<b class="t-bad">' + escapeHtml(t('fit_tagCrcBad')) + '</b>'}</div>
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
    renderList();
    renderPanel();
  }

  function remove(i) { fitFiles.splice(i, 1); renderList(); renderPanel(); }
  function clearAll() { fitFiles.length = 0; renderList(); renderPanel(); }

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
    if (cropMode) { renderCropMap(); return; }
    const src = bytesList || fitFiles.map(f => f.bytes);
    const tracks = src.map(b => { try { return FIT.trackPoints(b); } catch (e) { return []; } }).filter(p => p.length);
    if (!tracks.length || typeof TrackMap === 'undefined' || !TrackMap.available()) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    TrackMap.show('fitMap', tracks);
  }

  // ---- 裁剪模式：地图拖端点调整起止 ----
  // crop = { i0, i1 } 当前记录索引区间（含），持久到下一次进入裁剪或换文件
  let crop = null;   // { i0, i1, pts: [{lat,lon,idx}], fileIdx }
  function enterCrop() {
    if (!fitFiles.length) return;
    cropMode = true;
    if (!crop || crop.fileIdx !== 0) {
      try {
        const pts = FIT.trackPointsIndexed(fitFiles[0].bytes);
        if (pts.length >= 2) crop = { i0: 0, i1: pts[pts.length - 1].idx, pts, fileIdx: 0 };
      } catch (e) { cropMode = false; toast(t('fit_fail') + ' ' + e.message, false); return; }
    }
    const st = (typeof TrackMap !== 'undefined') ? TrackMap.state('fitMap') : null;
    if (st) registerFs(st);
    renderPanel();
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
      const pts = crop.pts;
      const tracks = [];
      const segA = pts.filter(p => p.idx < crop.i0), segK = pts.filter(p => p.idx >= crop.i0 && p.idx <= crop.i1), segB = pts.filter(p => p.idx > crop.i1);
      if (segA.length > 1) tracks.push({ latlngs: segA, color: '#b6b6b6' });
      if (segK.length > 1) tracks.push({ latlngs: segK, color: '#fc4c02' });
      if (segB.length > 1) tracks.push({ latlngs: segB, color: '#b6b6b6' });
      st.fsLayers = TrackMap.drawOn(map, tracks, { fit: true, handles: cropHandlesOpts() });
    };
  }
  function exitCrop() {
    cropMode = false;
    cropHandles = null;
    renderPanel();
  }
  function toggleCrop() { cropMode ? exitCrop() : enterCrop(); }

  function renderCropBar() {
    let bar = document.getElementById('fitCropBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fitCropBar';
      bar.className = 'fit-cropbar';
      $('fitMapWrap').insertAdjacentElement('afterend', bar);
    }
    if (!cropMode || !crop) { bar.style.display = 'none'; return; }
    const pts = crop.pts;
    const idxOf = v => pts.findIndex(p => p.idx >= v);
    const pA = pts[Math.max(0, idxOf(crop.i0))], pB = pts[Math.min(pts.length - 1, idxOf(crop.i1))];
    const km = (i0, i1) => {
      let d = 0, prev = null;
      for (const p of pts) { if (p.idx < i0 || p.idx > i1) continue; if (prev) d += TrackMapDist(prev, p); prev = p; }
      return d;
    };
    bar.style.display = '';
    bar.innerHTML = '<span class="fc-t">' + escapeHtml(t('fit_cropTitle')) + '</span>'
      + '<span class="fc-range">' + escapeHtml(t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length-1].idx + 1 })) + '</span>'
      + '<span class="fc-meta">' + km(crop.i0, crop.i1).toFixed(1) + ' km</span>'
      + '<button class="btn" onclick="FitUI.cropApply()" style="padding:4px 12px">' + escapeHtml(t('fit_cropApply')) + '</button>'
      + '<button class="btn" onclick="FitUI.cropReset()" style="padding:4px 10px">' + escapeHtml(t('fit_cropReset')) + '</button>'
      + '<button class="btn" onclick="FitUI.toggleCrop()" style="padding:4px 10px">' + escapeHtml(t('fit_cropDone')) + '</button>';
  }
  // 两点球面距离（米）——本地小工具，避免引 GPX 模块
  function TrackMapDist(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function renderCropMap() {
    const wrap = $('fitMapWrap');
    if (!wrap || !crop || typeof TrackMap === 'undefined' || !TrackMap.available()) { if (wrap) wrap.style.display = 'none'; return; }
    const st = TrackMap.state('fitMap');
    // 全屏态：由 st.fsRenderer 绘制到全屏地图，普通地图仅作背景占位
    if (st && st.fullscreen) { wrap.style.display = ''; TrackMap.rerenderFullscreen(st); return; }
    wrap.style.display = '';
    const pts = crop.pts;
    const segA = pts.filter(p => p.idx < crop.i0);                    // 裁掉-前段（灰）
    const segKeep = pts.filter(p => p.idx >= crop.i0 && p.idx <= crop.i1);  // 保留段（主题色）
    const segB = pts.filter(p => p.idx > crop.i1);                    // 裁掉-后段（灰）
    const tracks = [];
    if (segA.length > 1) tracks.push({ latlngs: segA, color: '#b6b6b6' });
    if (segKeep.length > 1) tracks.push({ latlngs: segKeep, color: '#fc4c02' });
    if (segB.length > 1) tracks.push({ latlngs: segB, color: '#b6b6b6' });
    const pA = nearestPt(pts, crop.i0), pB = nearestPt(pts, crop.i1);
    TrackMap.show('fitMap', tracks, { fit: !cropHandles, handles: cropHandlesOpts() });
  }
  // 端点配置（内嵌/全屏共用）：吸附最近轨迹点并约束区间有效
  function cropHandlesOpts() {
    const pts = crop.pts;
    return {
      a: nearestPt(pts, crop.i0), b: nearestPt(pts, crop.i1),
      onDrag: (kind, ll) => {
        let best = null, bd = Infinity;
        for (const p of pts) { const d = distM(ll, p); if (d < bd) { bd = d; best = p; } }
        if (!best) return;
        if (kind === 'a') crop.i0 = Math.min(best.idx, crop.i1 - 1);
        else crop.i1 = Math.max(best.idx, crop.i0 + 1);
        renderCropMap();
        renderCropBar();
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

  function cropApply() {
    if (!crop) return;
    const f = fitFiles[0];
    try {
      const bytes = FIT.cropRange(f.bytes, crop.i0, crop.i1 + 1);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = baseName(f.name) + '-crop.fit';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(t('fit_cropDone2'), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
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

  return { init, addFiles, remove, clearAll, runStrip, runSplit, runCombine, runConvert, toggleCrop, cropApply, cropReset };
})();
