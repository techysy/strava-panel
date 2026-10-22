/* ============================================================================
 * FIT 工具 UI —— 合并 / 拆分 / 删除功率·心率 / 转换 GPX·TCX
 * 全部在本地浏览器完成，文件不上传任何服务器。
 * ==========================================================================*/

const FitUI = (() => {
  let seq = 0;
  const fitFiles = [];    // { id, name, bytes, sum }
  const $ = id => document.getElementById(id);

  const fmtDur = s => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + t('fit_durH') : '') + (h || m ? m + t('fit_durM') : '') + (h ? '' : ss + t('fit_durS'));
  };
  const fmtSize = b => b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
  const fmtTime = u => u ? new Date(u * 1000).toLocaleString() : '-';
  const cropBytesRev = new WeakSet();   // 已应用过裁剪的文件（避免文件名反复叠加 -crop）
  let selectedFid = 0;   // 当前选中的目标文件 ID（单文件操作：删除字段/拆分/转GPX/裁剪）
  const getSelectedFile = () => {
    return fitFiles.find(f => f.id === selectedFid) || fitFiles[0] || null;
  };

  function renderList() {
    const box = $('fitFileList');
    if (!fitFiles.length) {
      box.innerHTML = '<div class="fit-empty" data-i18n="fit_empty">拖入 .fit 文件，或点击选择</div>';
      return;
    }
    const sel = getSelectedFile();
    box.innerHTML = fitFiles.map((f, i) => {
      const s = f.sum;
      const tags = [];
      if (s.has.power) tags.push('<b class="t-pw">' + escapeHtml(t('fit_stripPower')) + '</b>');
      if (s.has.hr) tags.push('<b class="t-hr">' + escapeHtml(t('fit_stripHr')) + '</b>');
      if (s.has.cadence) tags.push('<b class="t-cad">' + escapeHtml(t('fit_tagCad')) + '</b>');
      if (s.has.lat) tags.push('<b class="t-geo">' + escapeHtml(t('fit_tagGeo')) + '</b>');
      // 目标选中：裁剪模式以 crop.fid 为准；非裁剪模式以 selectedFid 为准
      const cur = cropMode && crop && crop.fid === f.id;
      const isSel = (!cropMode && sel && sel.id === f.id) || cur;
      const dft = cropMode && cropDraft.has(f.id);
      const cropCls = (cur ? ' ff-crop-target' : '') + (isSel ? ' ff-selected' : '');
      const cropTag = (cur ? '<b class="t-crop">' + escapeHtml(t('fit_cropTarget')) + '</b>' : '')
        + (dft && !cur ? '<b class="t-crop t-draft">' + escapeHtml(t('fit_cropDraft')) + '</b>' : '');
      const clickAttr = ` onclick="FitUI.selectFile(${i})" style="cursor:pointer" title="${escapeHtml(cropMode ? t('fit_cropTargetHint') : f.name)}"`;
      const dur = s.duration || 0;
      const mov = s.moveTime;
      const timePart = (mov != null && mov > 0 && Math.abs(dur - mov) >= 10)
        ? `${escapeHtml(t('fit_elapsed'))} ${fmtDur(dur)} · ${escapeHtml(t('fit_moving'))} ${fmtDur(mov)}`
        : (mov != null && mov > 0 ? `${escapeHtml(t('fit_moving'))} ${fmtDur(mov)}` : fmtDur(dur));
      return `<div class="fit-file${cropCls}" data-i="${i}"${clickAttr}>
        <div class="ff-main">
          <div class="ff-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="ff-meta">${s.points} ${escapeHtml(t('fit_tagPoints'))} · ${timePart} · ${s.distanceKm != null ? s.distanceKm.toFixed(2) + ' km' : escapeHtml(t('fit_noDist'))} · ${fmtSize(s.size)}</div>
          <div class="ff-tags">${cropTag}${tags.join('')}${s.crcOk ? '' : '<b class="t-bad">' + escapeHtml(t('fit_tagCrcBad')) + '</b>'}</div>
        </div>
        <div class="ff-time">${fmtTime(s.startUnix)}</div>
        <button class="ff-del" onclick="FitUI.remove(${i}); event.stopPropagation();" title="${escapeHtml(t('fit_remove'))}">×</button>
      </div>`;
    }).join('');
  }

  function selectFile(i) {
    if (!fitFiles[i]) return;
    selectedFid = fitFiles[i].id;
    if (cropMode) {
      cropSelectFile(i);
      return;
    }
    renderList();
    renderPanel();
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
      fitFiles.push({ id: ++seq, name: file.name, bytes: buf, sum });
    }
    if (!selectedFid && fitFiles.length) selectedFid = fitFiles[0].id;
    crop = null; cropDraft.clear();   // 文件集合变化，裁剪状态失效
    renderList();
    renderPanel();
  }

  function remove(i) {
    const [gone] = fitFiles.splice(i, 1);
    if (gone) {
      cropDraft.delete(gone.id);
      if (selectedFid === gone.id) selectedFid = fitFiles[0] ? fitFiles[0].id : 0;
    }
    if (crop && crop.fid === gone?.id) crop = null;
    if (!fitFiles.length) exitCrop();
    renderList(); renderPanel();
  }
  function clearAll() { selectedFid = 0; fitFiles.length = 0; crop = null; cropDraft.clear(); exitCrop(); renderList(); renderPanel(); }

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
    const f = getSelectedFile();
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
    const f = getSelectedFile();
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
    const f = getSelectedFile();
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

  // ---- 裁剪模式：地图拖端点调整起止（草稿层 + 全局应用）----
  // crop = { i0, i1, pts, fid } 当前编辑会话；cropDraft: Map<fileId,{i0,i1}> 未应用草稿。
  // 草稿语义：拖动松手即写入；切文件/退出都保留（内存级，刷新页面即失）；
  // 「全部应用」把所有草稿落到列表字节（后续可直接合并）；「应用此文件」单发。
  let crop = null;
  const cropDraft = new Map();
  let lastCropFid = 0;
  const fileByFid = () => (crop ? fitFiles.find(f => f.id === crop.fid) : null);
  function openSessionFor(f) {
    try {
      const pts = FIT.trackPointsIndexed(f.bytes);
      if (pts.length < 2) return false;
      const maxIdx = pts[pts.length - 1].idx;
      const d = cropDraft.get(f.id);
      crop = { i0: d ? Math.min(d.i0, maxIdx) : 0, i1: d ? Math.min(d.i1, maxIdx) : maxIdx, pts, fid: f.id };
      return true;
    } catch (e) { return false; }
  }
  // 当前会话状态落草稿（全区间视为无草稿）
  function saveDraft() {
    if (!crop) return;
    const f = fileByFid(); if (!f) return;
    const full = crop.i0 === 0 && crop.i1 === crop.pts[crop.pts.length - 1].idx;
    if (full) cropDraft.delete(f.id); else cropDraft.set(f.id, { i0: crop.i0, i1: crop.i1 });
  }
  function enterCrop() {
    if (!fitFiles.length) return;
    cropMode = true;
    if (!crop || !fileByFid()) {
      // 优先当前卡片选中的文件，其次上次编辑的文件，最后第一个有 GPS 的文件
      let f = selectedFid ? fitFiles.find(x => x.id === selectedFid) : null;
      if (!f || !openSessionFor(f)) {
        f = lastCropFid ? fitFiles.find(x => x.id === lastCropFid) : null;
        if (!f || !openSessionFor(f)) {
          f = fitFiles.find(ff => { try { return FIT.trackPointsIndexed(ff.bytes).length >= 2; } catch (e) { return false; } });
          if (!f || !openSessionFor(f)) { cropMode = false; toast(t('fit_fail') + ' — no GPS', false); return; }
        }
      }
    }
    if (cropDraft.size) toast(t('fit_cropDraftBack', { n: cropDraft.size }), true);
    const st = (typeof TrackMap !== 'undefined') ? TrackMap.state('fitMap') : null;
    if (st) registerFs(st);
    lastCropFid = crop.fid;
    renderList();
    renderPanel();
    renderCropMap();
    renderCropBar();
  }
  // 切换裁剪目标文件（卡片/全屏侧栏点击）：当前会话存入草稿
  function cropSelectFile(i) {
    if (!cropMode || !fitFiles[i]) return;
    if (crop && crop.fid === fitFiles[i].id) return;
    saveDraft();
    if (!openSessionFor(fitFiles[i])) { toast(t('fit_fail') + ' — no GPS', false); return; }
    lastCropFid = fitFiles[i].id;
    renderList();
    renderCropMap(false);   // 切换文件不重设缩放
    renderCropBar();
    renderFsSide();
  }
  // 全屏回调注册（须在地图实例存在后调用；首次进全屏前若未注册，enterCrop 里兜底再试）
  function registerFs(st) {
    if (!st || st.fsRenderer) return;
    st.onFullscreen = (on) => {
      cropHandles = null;
      if (on && cropMode) {
        const bar = document.getElementById('fitCropBar');
        const head = st.fsShell.querySelector('.tm-fs-head');
        if (bar && head) { head.appendChild(bar); head.style.display = 'flex'; }
      } else if (cropMode) {
        const bar = document.getElementById('fitCropBar');
        const head = st.fsShell && st.fsShell.querySelector('.tm-fs-head');
        if (head) head.style.display = 'none';
        if (bar) $('fitMapWrap').insertAdjacentElement('afterend', bar);
      }
      renderCropMap(); renderCropBar();
      if (on) renderFsSide();
    };
    st.fsRenderer = (map, _el, _extra, opts) => {
      if (!cropMode || !crop) {
        const tracks = fitFiles.map(f => { try { return FIT.trackPoints(f.bytes); } catch (e) { return []; } }).filter(p => p.length);
        if (tracks.length) { st.fsLayers = TrackMap.drawOn(map, tracks, { fit: opts?.fit !== false }); }
        return;
      }
      // 全屏裁剪：三色轨迹 + 可拖 S/E 端点；切换文件或重绘时保持用户当前缩放比例，不重新 fitBounds
      const shouldFit = (opts && opts.fit !== undefined) ? opts.fit : (!st.cropHandles || !st.cropHandles.length);
      st.fsLayers = TrackMap.drawOn(map, cropTracks(), { fit: shouldFit, noAutoSE: true, handles: cropHandlesOpts() });
    };
    // 退出全屏拦截：有未应用草稿时给友好提示（全部应用 / 仅退出保留草稿 / 取消）
    st.confirmExit = (proceed) => {
      saveDraft();
      if (!cropMode || !cropDraft.size) { proceed(); return; }
      appConfirm3(t('fit_cropExitTitle'), t('fit_cropExitBody', { n: cropDraft.size }),
        t('fit_cropExitOk'), t('fit_cropExitKeep'), t('modal_cancel')).then((v) => {
          if (v === 'ok') { cropApplyAll(); proceed(); }
          else if (v === 'third') { proceed(); }
        });
    };
  }
  // 全屏裁剪文件浮窗（地图左下）：列表 + 当前目标 + 待应用徽标，点击快速切换编辑对象。
  // 右下留给海拔剖面类浮窗；空态（非裁剪/退出）自动移除。
  function renderFsSide() {
    const st = (typeof TrackMap !== 'undefined') ? TrackMap.state('fitMap') : null;
    const host = st && st.fullscreen ? st.fsMapEl : null;
    let fl = host && host.querySelector('.tm-files');
    if (!host || !cropMode || !fitFiles.length) {
      const any = document.querySelector('.tm-files');
      if (any) any.remove();
      return;
    }
    if (!fl) {
      fl = document.createElement('div');
      fl.className = 'tm-float tm-float-glass tm-files';
      host.appendChild(fl);
    }
    fl.innerHTML = fitFiles.map((f, i) => {
      const cur = crop && crop.fid === f.id;
      const d = cropDraft.get(f.id);
      const badge = cur ? '<span class="si-badge edit">' + escapeHtml(t('fit_cropCur')) + '</span>'
        : d ? '<span class="si-badge draft">' + escapeHtml(t('fit_cropDraft')) + '</span>' : '';
      const range = d ? ' · ' + escapeHtml(t('fit_cropRange', { a: d.i0 + 1, b: d.i1 + 1, n: f.sum.points })) : '';
      return '<button class="tm-side-item' + (cur ? ' cur' : '') + '" onclick="FitUI.cropSelectFile(' + i + ')">'
        + '<span class="si-main"><span class="si-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>'
        + '<span class="si-meta">' + f.sum.points + ' pt · ' + (f.sum.distanceKm != null ? f.sum.distanceKm.toFixed(1) + ' km' : '-') + range + '</span></span>'
        + badge + '</button>';
    }).join('');
  }
  async function exitCrop() {
    // 退出裁剪也先拦截未应用草稿（与退出全屏同一提示）
    if (cropMode) {
      saveDraft();
      if (cropDraft.size) {
        const v = await appConfirm3(t('fit_cropExitTitle'), t('fit_cropExitBody', { n: cropDraft.size }),
          t('fit_cropExitOk'), t('fit_cropExitKeep'), t('modal_cancel'));
        if (v === false) return;
        if (v === 'ok') cropApplyAll();
      }
      lastCropFid = crop ? crop.fid : lastCropFid;
    }
    cropMode = false;
    cropHandles = null;
    renderList();
    renderPanel();
    renderCropBar();
    renderFsSide();
  }
  async function toggleCrop() { if (cropMode) await exitCrop(); else enterCrop(); syncCropBtn(); }
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
  // 只刷新区间/里程/计数（拖拽中用），不重建按钮
  function updateCropBarText() {
    const bar = document.getElementById('fitCropBar');
    if (!bar || !cropMode || !crop) return;
    if (!bar.querySelector('.fc-range')) { renderCropBarFull(bar); return; }
    const pts = crop.pts;
    bar.querySelector('.fc-range').textContent = t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length - 1].idx + 1 });
    bar.querySelector('.fc-meta').textContent = cropKm(crop.i0, crop.i1).toFixed(1) + ' km';
    const n = cropDraft.size;
    const all = bar.querySelector('.fc-apply-all');
    if (all) { all.disabled = !n; all.querySelector('.fc-n').textContent = n; }
  }
  function cropKm(i0, i1) {
    let d = 0, prev = null;
    for (const p of crop.pts) { if (p.idx < i0 || p.idx > i1) continue; if (prev) d += TrackMapDist(prev, p); prev = p; }
    return d / 1000;   // TrackMapDist 返回米，工具条按 km 显示
  }
  function renderCropBarFull(bar) {
    const pts = crop.pts;
    const n = cropDraft.size;
    bar.style.display = '';
    bar.innerHTML = '<span class="fc-t">' + escapeHtml(t('fit_cropTitle')) + '</span>'
      + '<span class="fc-range">' + escapeHtml(t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length-1].idx + 1 })) + '</span>'
      + '<span class="fc-meta">' + cropKm(crop.i0, crop.i1).toFixed(1) + ' km</span>'
      + '<button class="btn fc-apply-all" ' + (n ? '' : 'disabled ') + 'onclick="FitUI.cropApplyAll()" style="padding:4px 12px">' + escapeHtml(t('fit_cropApplyAll')) + ' <b class="fc-n">' + n + '</b></button>'
      + '<button class="btn" onclick="FitUI.cropApply()" style="padding:4px 10px">' + escapeHtml(t('fit_cropApplyOne')) + '</button>'
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
    fitFiles.forEach((f) => {
      if (f.id === crop.fid) return;
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

  function renderCropMap(fit) {
    const wrap = $('fitMapWrap');
    if (!wrap || !crop || typeof TrackMap === 'undefined' || !TrackMap.available()) { if (wrap) wrap.style.display = 'none'; return; }
    const st = TrackMap.state('fitMap');
    const st0 = TrackMap.state('fitMap');
    const firstFit = fit !== undefined ? fit : (!st0 || !st0.cropHandles || !st0.cropHandles.length);
    // 全屏态：由 st.fsRenderer 绘制到全屏地图（含可拖端点）
    if (st && st.fullscreen) { wrap.style.display = ''; TrackMap.rerenderFullscreen(st, { fit: firstFit }); return; }
    wrap.style.display = '';
    const tracks = cropTracks();
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
      // 松手：区间落草稿 → 重画折线并重建端点（a/b 本身就是吸附后的最近轨迹点）。
      // 拖拽已结束，重建不打断下一次拖拽；不传 handles 会让 clearLayers 把端点删掉不补（S/E 消失的根因）。
      onDrop: (kind, ll) => {
        apply(kind, ll);
        saveDraft();
        updateCropBarText();
        renderFsSide();
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

  // 生成裁剪产物（cropRange 出合法 FIT 字节）；区间一律取草稿
  // （调用前须先 saveDraft()，当前会话也已在草稿里）；无草稿返回 null
  function buildCrop(f) {
    f = f || fileByFid();
    if (!f) return null;
    const range = cropDraft.get(f.id);
    if (!range) return null;
    // 已裁过的文件不再叠加 -crop 后缀（二次裁剪沿用原名）
    const stem = cropBytesRev.has(f) ? baseName(f.name) : baseName(f.name) + '-crop';
    try { return { bytes: FIT.cropRange(f.bytes, range.i0, range.i1 + 1), name: stem + '.fit', f }; }
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
    saveDraft();
    const f = fileByFid();
    if (!f) return;
    const r = buildCrop(f);
    if (!r) { toast(t('fit_cropNoop'), false); return; }   // 全区间：没有草稿可言
    applyFileBytes(r);
    renderList(); renderPanel(); renderCropMap(); renderCropBar(); renderFsSide();
    toast(t('fit_cropApplied', { n: f.sum.points }), true);
  }
  // 全局应用：所有草稿（含当前会话）一次落到列表，退出裁剪态回到普通多轨迹渲染
  function cropApplyAll() {
    saveDraft();
    if (!cropDraft.size) { toast(t('fit_cropNoop'), false); return; }
    let n = 0;
    for (const [fid] of [...cropDraft]) {
      const f = fitFiles.find(x => x.id === fid);
      if (!f) { cropDraft.delete(fid); continue; }
      const r = buildCrop(f);
      if (r) { applyFileBytes(r); n++; }
    }
    cropDraft.clear();
    crop = null;
    cropMode = false; cropHandles = null;
    // 顺序要紧：先清裁剪态再重绘，renderPanel→renderMap 才会走普通多轨迹渲染
    renderList(); renderPanel(); renderCropBar(); renderFsSide(); syncCropBtn();
    toast(t('fit_cropAppliedAll', { n }), true);
  }
  // 字节替换 + 元数据刷新（单个文件）
  function applyFileBytes(r) {
    const f = r.f;
    f.bytes = r.bytes;
    f.sum = FIT.summarize(r.bytes);
    f.name = r.name;
    cropBytesRev.add(f);
    cropDraft.delete(f.id);
    if (crop && crop.fid === f.id) openSessionFor(f);   // 新字节重建会话（回全区间）
  }
  function cropReset() {
    if (!crop) return;
    crop.i0 = 0; crop.i1 = crop.pts[crop.pts.length - 1].idx;
    cropDraft.delete(crop.fid);
    renderList(); renderCropMap(); renderCropBar(); renderFsSide();
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
    const sf = getSelectedFile();
    const sfName = sf ? baseName(sf.name) : '-';
    $('fitStripTarget').textContent = sfName;
    $('fitSplitTarget').textContent = sfName;
    $('fitConvertTarget').textContent = sfName;
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

  return { init, addFiles, remove, clearAll, runStrip, runSplit, runCombine, runConvert, toggleCrop, cropApply, cropApplyAll, cropDownload, cropReset, cropSelectFile, selectFile };
})();
