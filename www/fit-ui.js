/* ============================================================================
 * FIT 工具 UI —— 合并 / 拆分 / 删除功率·心率 / 转换 GPX·TCX / 上传到 Strava
 * 本地解析处理；上传仅把选定文件经本地服务代理推给 Strava（不经过其它服务器）。
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

  // 列表 = 「添加文件」入口卡（与文件卡同排同规格）+ 各文件卡。
  // 拖放/点击都走隐藏的 <input>；fitFileList 本身也是拖放落点（整行可投）。
  function addCardHtml() {
    return `<div class="fit-file fit-add" id="fitAddCard" onclick="FitUI.pickFiles()" title="${escapeHtml(t('fit_addSub'))}">
      <svg class="ic" aria-hidden="true"><use href="#i-plus"/></svg>
      <div class="fa-t" data-i18n="fit_addCard">${escapeHtml(t('fit_addCard'))}</div>
      <div class="fa-s" data-i18n="fit_addSub">${escapeHtml(t('fit_addSub'))}</div>
    </div>`;
  }
  function renderList() {
    const box = $('fitFileList');
    if (!box) return;
    const sel = getSelectedFile();
    const fileCards = fitFiles.map((f, i) => {
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
    box.innerHTML = addCardHtml() + fileCards;
  }

  // 打开文件选择器（供「添加」卡片点击调用）
  function pickFiles() { const i = $('fitInput'); if (i) i.click(); }

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
    const list = Array.from(fileList || []);
    if (!list.length) return;
    for (const file of list) {
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
    if (!fitFiles.length) {
      crop = null;
      cropDraft.clear();
      cropMode = false;
      splitMode = false;
      cropHandles = null;
      const st = typeof TrackMap !== 'undefined' ? TrackMap.state('fitMap') : null;
      if (st && st.fullscreen) {
        try { TrackMap.toggleFullscreen(st); } catch (e) {}
      }
    }
    renderList();
    renderPanel();
    renderCropBar();
    renderFsSide();
  }
  function clearAll() {
    selectedFid = 0;
    fitFiles.length = 0;
    crop = null;
    cropDraft.clear();
    cropMode = false;
    splitMode = false;
    cropHandles = null;
    const st = typeof TrackMap !== 'undefined' ? TrackMap.state('fitMap') : null;
    if (st && st.fullscreen) {
      try { TrackMap.toggleFullscreen(st); } catch (e) {}
    }
    renderList();
    renderPanel();
    renderCropBar();
    renderFsSide();
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const baseName = (n) => n.replace(/\.fit$/i, '');

  // 派生产物入列表（合并/拆分结果）：命名去重（combined-2.fit 等），解析摘要，可选中/上传。
  // 不清裁剪草稿——列表新增文件不影响既有裁剪会话（按 fid 引用）。
  function pushDerived(name, bytes) {
    let sum; try { sum = FIT.summarize(bytes); } catch (e) { return null; }
    if (!sum.points) return null;
    let nm = name, n = 1; const stem = baseName(name);
    while (fitFiles.some(f => f.name === nm)) { n++; nm = `${stem}-${n}.fit`; }
    const f = { id: ++seq, name: nm, bytes, sum };
    fitFiles.push(f);
    return f;
  }

  // ---- 各工具执行 ----
  function runStrip(mode) {
    const f = getSelectedFile();
    const dropPw = $('fitDropPower').checked, dropHr = $('fitDropHr').checked;
    if (!f) return;
    try {
      const r = FIT.stripFields(f.bytes, { power: dropPw, heartRate: dropHr });
      if (mode === 'list') {
        const a = pushDerived(baseName(f.name) + '-stripped.fit', r.bytes);
        if (!a) { toast(t('fit_parseFail'), false); return; }
        selectedFid = a.id;
        renderList(); renderPanel();
        toast(t('fit_doneStrip', { n: r.count }), true);
        return;
      }
      download(new Blob([r.bytes], { type: 'application/octet-stream' }), baseName(f.name) + '-stripped.fit');
      renderMap([r.bytes]);
      toast(t('fit_doneStrip', { n: r.count }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  function runConvert(fmt) {
    const f = getSelectedFile();
    if (!f) return;
    try {
      const name = $('fitConvertName').value.trim() || baseName(f.name);
      if (fmt === 'gpx') {
        download(new Blob([FIT.toGpx(f.bytes, name)], { type: 'application/gpx+xml' }), name + '.gpx');
      } else {
        download(new Blob([FIT.toTcx(f.bytes, name)], { type: 'application/xml' }), name + '.tcx');
      }
      toast(t('fit_doneConvert'), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  // ---- 海拔校准（Open-Meteo DEM）与 GCJ-02 坐标校正 ----
  let _eleBusy = false;
  const DEM_URL = 'https://api.open-meteo.com/v1/elevation';
  async function fetchDem(pts) {
    const cache = new Map();
    const out = new Array(pts.length).fill(null);
    const BATCH = 100;   // Open-Meteo elevation 单次上限 100 坐标
    for (let i = 0; i < pts.length; i += BATCH) {
      const idxs = [], lats = [], lons = [];
      for (let j = i; j < Math.min(i + BATCH, pts.length); j++) {
        const k = pts[j].lat.toFixed(4) + ',' + pts[j].lon.toFixed(4);   // ~11m 网格去重
        if (cache.has(k)) { out[j] = cache.get(k); continue; }
        idxs.push(j); lats.push(pts[j].lat.toFixed(5)); lons.push(pts[j].lon.toFixed(5));
      }
      if (!idxs.length) continue;
      // 超时保护：网络挂起时不能无限等（按钮会永远停在「查询中…」）
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      let d;
      try {
        const resp = await fetch(DEM_URL + '?latitude=' + lats.join(',') + '&longitude=' + lons.join(','), { signal: ac.signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        d = await resp.json();
      } finally { clearTimeout(timer); }
      // Open-Meteo 对越界坐标返回 HTTP 200 + {error:true}（无 elevation 字段），
      // 此时该批全部失败，必须报错而不是静默留 0（否则用户以为已补全）
      if (d && d.error) throw new Error(String(d.reason || 'DEM 查询失败'));
      const eles = d && Array.isArray(d.elevation) ? d.elevation : null;
      if (!eles) throw new Error('DEM 返回数据格式异常');
      if (eles.length !== idxs.length) {
        // 数量不符就不能一一对应（否则会给 A 点写入 B 点海拔）
        throw new Error('DEM 返回点数与请求不符（' + eles.length + '/' + idxs.length + '）');
      }
      eles.forEach((ele, k) => {
        if (ele == null || !Number.isFinite(ele)) return;
        out[idxs[k]] = ele;
        cache.set(pts[idxs[k]].lat.toFixed(4) + ',' + pts[idxs[k]].lon.toFixed(4), ele);
      });
    }
    return out;
  }
  async function runEleCalib(mode) {
    const f = getSelectedFile();
    if (!f || _eleBusy) return;
    _eleBusy = true;
    const btn = $('fitEleBtn');
    const btnTxt = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = t('fit_eleQuerying'); }
    try {
      // elevationTargets 也在 try 内：损坏文件会抛错，必须给出提示而非
      // 变成无人处理的 Promise rejection（用户看不到任何反馈）
      const t0 = FIT.elevationTargets(f.bytes);
      if (!t0.count) { toast(t('fit_eleNone'), true); return; }
      const eles = await fetchDem(t0.pts);
      const r = FIT.applyElevation(f.bytes, eles);
      if (!r.bytes) { toast(t('fit_eleNone'), true); return; }
      if (mode === 'list') {
        const a = pushDerived(baseName(f.name) + '-ele.fit', r.bytes);
        if (!a) { toast(t('fit_parseFail'), false); return; }
        selectedFid = a.id;
        renderList(); renderPanel();
      } else {
        download(new Blob([r.bytes], { type: 'application/octet-stream' }), baseName(f.name) + '-ele.fit');
        renderMap([r.bytes]);
      }
      toast(t('fit_eleDone', { n: r.count }), true);
    } catch (e) {
      toast(t('fit_eleFail') + (e.message || e), false);
    } finally {
      _eleBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = btnTxt; }
    }
  }
  function runGcjFix(mode) {
    const f = getSelectedFile();
    if (!f) return;
    try {
      const r = FIT.fixGcj02(f.bytes);
      if (!r.bytes) { toast(t('fit_gcjNone'), true); return; }
      if (mode === 'list') {
        const a = pushDerived(baseName(f.name) + '-wgs84.fit', r.bytes);
        if (!a) { toast(t('fit_parseFail'), false); return; }
        selectedFid = a.id;
        renderList(); renderPanel();
      } else {
        download(new Blob([r.bytes], { type: 'application/octet-stream' }), baseName(f.name) + '-wgs84.fit');
        renderMap([r.bytes]);
      }
      toast(t('fit_gcjDone', { n: r.count }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  function runSplit(mode) {
    const f = getSelectedFile();
    if (!f) return;
    const smode = $('fitSplitMode').value;
    const opt = smode === 'gap'
      ? { mode: 'gap', gapSeconds: Number($('fitSplitGap').value) || 300 }
      : { mode: 'count', chunkSize: Number($('fitSplitCount').value) || 1000 };
    try {
      const files = FIT.split(f.bytes, opt);
      if (mode === 'list') {
        const added = [];
        files.forEach((b, i) => { const a = pushDerived(baseName(f.name) + `-part${i + 1}.fit`, b); if (a) added.push(a); });
        if (!added.length) { toast(t('fit_parseFail'), false); return; }
        selectedFid = added[added.length - 1].id;
        renderList(); renderPanel();
        toast(t('fit_splitInList', { n: added.length }), true);
        return;
      }
      files.forEach((b, i) => {
        setTimeout(() => download(new Blob([b], { type: 'application/octet-stream' }),
          baseName(f.name) + `-part${i + 1}.fit`), i * 250);
      });
      renderMap(files);   // 拆分产物在地图上多色渲染
      toast(t('fit_doneSplit', { n: files.length }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  // 合并产物。mode='dl' 下载；mode='list' 作为一个新文件并入列表（可被选中上传/再处理）。
  function runCombine(mode) {
    if (fitFiles.length < 2) { toast(t('fit_needMulti'), false); return; }
    try {
      const r = FIT.combine(fitFiles.map(f => f.bytes));
      // 去重提示：同一活动被导出/合并多份时，明确告知已去掉重复采样点
      const dupNote = (r.skippedDup || r.deduped)
        ? t('fit_combineDedup', { d: r.skippedDup || 0, p: r.deduped || 0 }) : '';
      if (mode === 'list') {
        const added = pushDerived('combined.fit', r.bytes);
        if (!added) { toast(t('fit_parseFail'), false); return; }
        selectedFid = added.id;
        renderList(); renderPanel();
        toast(t('fit_combineInList', { name: added.name }) + dupNote, true);
      } else {
        download(new Blob([r.bytes], { type: 'application/octet-stream' }), 'combined.fit');
        renderMap([r.bytes]);   // 合并产物在地图上渲染
        toast(t('fit_doneCombine', { n: r.count }) + dupNote, true);
      }
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }

  // 轨迹小地图：多文件多色；拆分/合并/删除后的产物同样可渲染
  // 裁剪模式（cropMode=true）：单文件轨迹 + 可拖 S/E 端点，实时预览保留区间
  let cropMode = false;
  let splitMode = false;   // 在裁剪会话基础上叠加拆切点编辑（S/E 裁首尾 + C 切点）
  let _cutSeq = 0;         // 切点 id 计数（仅 UI 标记用）
  let cropHandles = null;   // { s: marker, e: marker } Leaflet 可拖端点
  function renderMap(bytesList) {
    const wrap = $('fitMapWrap');
    if (!wrap) return;
    if (!fitFiles.length && !bytesList) {
      wrap.style.display = 'none';
      if (typeof TrackMap !== 'undefined') TrackMap.clear('fitMap');
      syncCropBtn();
      return;
    }
    if (cropMode) { renderCropMap(); syncCropBtn(); return; }   // 非裁剪产物变化时也走裁剪渲染
    syncCropBtn();
    const src = bytesList || fitFiles.map(f => f.bytes);
    const tracks = src.map(b => { try { return FIT.trackPoints(b); } catch (e) { return []; } }).filter(p => p.length);
    if (!tracks.length || typeof TrackMap === 'undefined' || !TrackMap.available()) {
      wrap.style.display = 'none';
      if (typeof TrackMap !== 'undefined') TrackMap.clear('fitMap');
      return;
    }
    wrap.style.display = '';
    TrackMap.show('fitMap', tracks);
    const st = TrackMap.state('fitMap');
    if (st) registerFs(st);   // 地图实例此刻才存在 → 注册全屏回调
    if (st) registerFs(st);
  }

  // ---- 海拔剖面（内嵌卡片 + 全屏右下玻璃浮窗，与 GPX 同款交互）----
  // 数据：选中文件轨迹抽稀 ~400 桶；hover 联动内嵌/全屏地图指示圆点。
  // 头部按钮：校准海拔（DEM 补全）与 GCJ-02 → WGS-84 校正。
  function eleProfileData(f) {
    let pts; try { pts = FIT.trackPoints(f.bytes); } catch (e) { return null; }
    if (!pts || pts.length < 2) return null;
    let d = 0; const cum = [0];
    for (let i = 1; i < pts.length; i++) { d += TrackMapDist(pts[i - 1], pts[i]); cum.push(d); }
    const totalKm = d / 1000;
    const hasEle = pts.some(p => p.ele != null);
    const NB = 400, step = Math.max(1, Math.floor(pts.length / NB));
    const prof = [];
    let lastEle = null;
    for (let i = 0; i < pts.length; i += step) {
      if (pts[i].ele != null) lastEle = pts[i].ele;
      prof.push({ distKm: cum[i] / 1000, ele: lastEle, _lat: pts[i].lat, _lon: pts[i].lon });
    }
    if (pts[pts.length - 1].ele != null) lastEle = pts[pts.length - 1].ele;
    prof.push({ distKm: totalKm, ele: lastEle, _lat: pts[pts.length - 1].lat, _lon: pts[pts.length - 1].lon });
    // 爬升/下降（±3m 阈值锚点法，与码表习惯一致）
    let gain = 0, loss = 0, anchor = null;
    for (const p of pts) {
      if (p.ele == null) continue;
      if (anchor == null) { anchor = p.ele; continue; }
      if (p.ele - anchor > 3) { gain += p.ele - anchor; anchor = p.ele; }
      else if (p.ele - anchor < -3) { loss += anchor - p.ele; anchor = p.ele; }
    }
    return { prof, totalKm, hasEle, gain, loss };
  }
  function drawEleProfile(container, pd, linkedMap) {
    if (!container || !pd || !pd.prof.length) return;
    const prof = pd.prof;
    const C = chartColors();
    const w = Math.max(280, container.clientWidth || 560), h = 120, padL = 36, padR = 8, padT = 8, padB = 16;
    const iw = w - padL - padR, ih = h - padT - padB;
    const es = prof.filter(p => p.ele != null).map(p => p.ele);
    let eMin = es.length ? Math.min(...es) : 0, eMax = es.length ? Math.max(...es) : 0;
    if (eMax - eMin < 10) { const mid = (eMax + eMin) / 2; eMin = mid - 5; eMax = mid + 5; }
    const X = i => padL + iw * i / (prof.length - 1);
    const Y = e => padT + ih - (e - eMin) / (eMax - eMin) * ih;
    const line = prof.map((p, i) => X(i).toFixed(1) + ',' + Y(p.ele).toFixed(1)).join(' ');
    const area = `M${X(0).toFixed(1)},${(padT + ih).toFixed(1)} L${line.split(' ').join(' L')} L${X(prof.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} Z`;
    container.innerHTML = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block;width:100%">'
      + '<path d="' + area + '" fill="' + C.viz + '" opacity="0.18"/>'
      + '<polyline points="' + line + '" fill="none" stroke="' + C.viz + '" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<line class="pc-cursor" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + ih) + '" stroke="' + C.brand + '" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>'
      + '<circle class="pc-dot" r="4" fill="' + C.brand + '" stroke="#fff" stroke-width="1.5" opacity="0"/>'
      + '<text x="' + (padL - 4) + '" y="' + (padT + 8) + '" text-anchor="end" font-size="9" fill="' + C.muted + '">' + Math.round(eMax) + 'm</text>'
      + '<text x="' + (padL - 4) + '" y="' + (padT + ih) + '" text-anchor="end" font-size="9" fill="' + C.muted + '">' + Math.round(eMin) + 'm</text>'
      + '<text x="' + padL + '" y="' + (h - 4) + '" font-size="9" fill="' + C.muted + '">0 km</text>'
      + '<text x="' + (w - padR) + '" y="' + (h - 4) + '" text-anchor="end" font-size="9" fill="' + C.muted + '">' + pd.totalKm.toFixed(1) + ' km</text>'
      + '</svg><div class="prof-tip" style="opacity:0"></div>';
    const svg = container.querySelector('svg'), cursor = container.querySelector('.pc-cursor'),
      dot = container.querySelector('.pc-dot'), tip = container.querySelector('.prof-tip');
    let mapDot = null;
    svg.addEventListener('mousemove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * (w / rect.width);
      const frac = Math.max(0, Math.min(1, (px - padL) / iw));
      const i = Math.round(frac * (prof.length - 1));
      const p = prof[i];
      const cx = X(i), cy = Y(p.ele);
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('opacity', '1');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', '1');
      tip.textContent = p.distKm.toFixed(1) + ' km · ' + Math.round(p.ele) + ' m';
      tip.style.opacity = '1';
      tip.style.left = (cx / w * 100) + '%';
      tip.style.top = (cy / h * 100) + '%';
      if (linkedMap && p._lat != null) {
        if (!mapDot) mapDot = L.circleMarker([p._lat, p._lon], { radius: 6, color: '#fc4c02', weight: 2, fillColor: '#fff', fillOpacity: 0.9 }).addTo(linkedMap);
        else mapDot.setLatLng([p._lat, p._lon]);
      }
    });
    svg.addEventListener('mouseleave', () => {
      cursor.setAttribute('opacity', '0'); dot.setAttribute('opacity', '0'); tip.style.opacity = '0';
      if (mapDot) { mapDot.remove(); mapDot = null; }
    });
  }
  function renderProfile() {
    const card = $('fitEleCard');
    if (!card) return;
    const sf = getSelectedFile();
    if (!sf) { card.style.display = 'none'; return; }
    card.style.display = '';
    const body = $('fitEleProfile');
    const stats = $('fitEleStats');
    const pd = eleProfileData(sf);
    if (!pd) { body.innerHTML = ''; if (stats) stats.textContent = '-'; return; }
    const es = pd.prof.filter(p => p.ele != null).map(p => p.ele);
    const eMin = es.length ? Math.round(Math.min(...es)) : null, eMax = es.length ? Math.round(Math.max(...es)) : null;
    if (stats) {
      if (!pd.hasEle) stats.textContent = t('fit_eleNoData');
      else if (eMax === 0) stats.textContent = t('fit_eleZeroHint');
      else stats.textContent = '↑' + Math.round(pd.gain) + 'm · ↓' + Math.round(pd.loss) + 'm · ' + eMin + '~' + eMax + 'm';
    }
    if (!pd.hasEle) { body.innerHTML = ''; return; }
    const st = (typeof TrackMap !== 'undefined') ? TrackMap.state('fitMap') : null;
    const linked = st && !st.fullscreen ? st.map : null;
    drawEleProfile(body, pd, linked);
  }
  // 剖面头部按钮（内嵌卡与全屏浮窗共用）：校准海拔 / GCJ-02 校正，各带应用到列表
  function eleButtonsHtml() {
    return '<button class="btn btn-sm" onclick="FitUI.runEleCalib()" data-i18n="fit_eleRun" data-i18n-title="fit_eleHint">' + escapeHtml(t('fit_eleRun')) + '</button>'
      + '<button class="btn btn-sm" onclick="FitUI.runEleCalib(\'list\')" data-i18n="fit_toList">' + escapeHtml(t('fit_toList')) + '</button>'
      + '<span class="fo-sep"></span>'
      + '<button class="btn btn-sm" onclick="FitUI.runGcjFix()" data-i18n="fit_gcjRun" data-i18n-title="fit_gcjHint" title="' + escapeHtml(t('fit_gcjHint')) + '">' + escapeHtml(t('fit_gcjRun')) + '</button>'
      + '<button class="btn btn-sm" onclick="FitUI.runGcjFix(\'list\')" data-i18n="fit_toList">' + escapeHtml(t('fit_toList')) + '</button>';
  }
  // 全屏态：剖面 + 校正按钮收进右下玻璃浮窗（GPX 同款 .tm-float-glass），hover 联动全屏地图
  function mountFsProfileFloat(st, map) {
    const host = st && st.fsMapEl; if (!host) return;
    let fl = host.querySelector('.tm-float-ele'); if (fl) fl.remove();
    const sf = getSelectedFile(); if (!sf) return;
    const pd = eleProfileData(sf);
    fl = document.createElement('div');
    fl.className = 'tm-float tm-float-glass tm-float-ele';
    fl.innerHTML = '<div class="tm-float-t">' + escapeHtml(t('fit_eleProfile')) + '</div>'
      + '<div class="fit-ele-head">' + eleButtonsHtml() + '</div><div class="fit-ele-body"></div>';
    host.appendChild(fl);
    const body = fl.querySelector('.fit-ele-body');
    if (pd && pd.hasEle) drawEleProfile(body, pd, map);
    else body.innerHTML = '<div class="tt" style="color:var(--text-3);font-size:11px">' + escapeHtml(t('fit_eleNoData')) + '</div>';
  }

  // ---- 裁剪模式：地图拖端点调整起止（草稿层 + 全局应用）----
  // crop = { i0, i1, pts, fid, cuts? } 当前编辑会话；cropDraft: Map<fileId,{i0,i1}> 未应用草稿。
  // 草稿语义：拖动松手即写入；切文件/退出都保留（内存级，刷新页面即失）；
  // 「全部应用」把所有草稿落到列表字节（后续可直接合并）；「应用此文件」单发。
  // splitMode 在裁剪会话上叠加拆切点（cuts = 保留区间内的 record 下标数组）：
  // 点地图加切点、点切点删、拖切点移动，S/E 仍是裁首尾 —— 选切点 + 同时裁剪。
  let crop = null;
  const cropDraft = new Map();
  let lastCropFid = 0;
  const fileByFid = () => (crop ? fitFiles.find(f => f.id === crop.fid) : null);
  const cropCuts = () => (crop && crop.cuts ? crop.cuts.filter(c => c > crop.i0 && c < crop.i1).sort((a, b) => a - b) : []);
  function openSessionFor(f) {
    try {
      const pts = FIT.trackPointsIndexed(f.bytes);
      if (pts.length < 2) return false;
      const maxIdx = pts[pts.length - 1].idx;
      const d = cropDraft.get(f.id);
      crop = { i0: d ? Math.min(d.i0, maxIdx) : 0, i1: d ? Math.min(d.i1, maxIdx) : maxIdx, pts, fid: f.id, cuts: [] };
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
  // 进入编辑态（crop=仅裁剪；split=裁剪+切点）。二者共用单文件会话 + S/E 端点。
  function openEditor(split) {
    if (!fitFiles.length) return;
    cropMode = true; splitMode = !!split;
    if (!crop || !fileByFid()) {
      // 优先当前卡片选中的文件，其次上次编辑的文件，最后第一个有 GPS 的文件
      let f = selectedFid ? fitFiles.find(x => x.id === selectedFid) : null;
      if (!f || !openSessionFor(f)) {
        f = lastCropFid ? fitFiles.find(x => x.id === lastCropFid) : null;
        if (!f || !openSessionFor(f)) {
          f = fitFiles.find(ff => { try { return FIT.trackPointsIndexed(ff.bytes).length >= 2; } catch (e) { return false; } });
          if (!f || !openSessionFor(f)) { cropMode = false; splitMode = false; toast(t('fit_fail') + ' — no GPS', false); return; }
        }
      }
    }
    if (crop && !Array.isArray(crop.cuts)) crop.cuts = [];
    if (cropDraft.size) toast(t('fit_cropDraftBack', { n: cropDraft.size }), true);
    const st = (typeof TrackMap !== 'undefined') ? TrackMap.state('fitMap') : null;
    if (st) registerFs(st);
    lastCropFid = crop.fid;
    renderList();
    renderPanel();
    renderCropMap();
    renderCropBar();
  }
  function enterCrop() { openEditor(false); }
  function enterSplit() { openEditor(true); }
  // 切换编辑目标文件（卡片/全屏侧栏点击）：当前会话存入草稿；拆分模式保留切点为空
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
    refreshUploadTarget();
  }
  // 全屏回调注册（须在地图实例存在后调用；首次建图或进全屏前自动注册）
  function registerFs(st) {
    if (!st || st._fsRegistered) return;
    st._fsRegistered = true;
    // 容器从不可见变可见（tab 切回）时 Leaflet 补画轨迹 → 此刻补注册全屏回调
    st.onShow = () => { try { registerFs(st); } catch (e) {} };
    st.onFullscreen = (on) => {
      cropHandles = null;
      if (on && cropMode) {
        const bar = document.getElementById('fitCropBar');
        const head = st.fsShell?.querySelector('.tm-fs-head');
        if (bar && head) { head.appendChild(bar); head.style.display = 'flex'; }
        renderCropMap(); renderCropBar();
        renderFsSide();
      } else if (!on) {
        if (cropMode) {
          const bar = document.getElementById('fitCropBar');
          const head = st.fsShell && st.fsShell.querySelector('.tm-fs-head');
          if (head) head.style.display = 'none';
          if (bar) $('fitMapWrap')?.insertAdjacentElement('afterend', bar);
          renderCropMap();
          renderCropBar();
        } else {
          renderMap();
        }
        renderProfile();
      }
    };
    st.fsRenderer = (map, _el, _extra, opts) => {
      if (!cropMode || !crop) {
        const tracks = fitFiles.map(f => { try { return FIT.trackPoints(f.bytes); } catch (e) { return []; } }).filter(p => p.length);
        if (tracks.length) { st.fsLayers = TrackMap.drawOn(map, tracks, { fit: opts?.fit !== false }); }
        mountFsProfileFloat(st, map);
        return;
      }
      // 全屏裁剪/拆分：三色轨迹 + 可拖 S/E 端点；拆分模式叠加可拖切点。
      // 切换文件或重绘时保持用户当前缩放比例，不重新 fitBounds
      const shouldFit = (opts && opts.fit !== undefined) ? opts.fit : (!st.cropHandles || !st.cropHandles.length);
      st.fsLayers = TrackMap.drawOn(map, cropTracks(), { fit: shouldFit, noAutoSE: true, handles: cropHandlesOpts(), cuts: cropCutsOpts() });
      mountFsProfileFloat(st, map);
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
  // 确保全屏回调已注册。地图实例只在容器可见时才创建（TrackMap.show 在容器
  // 零尺寸时提前返回），若用户在别的 tab 里加载 FIT 文件，此时 state() 为 null，
  // registerFs 不会被调用 → 全屏时缺剖面浮窗/退出全屏不重绘。
  // 因此切到 FIT 工具 tab 时必须补注册；容器刚可见时 Leaflet 建图是异步的，
  // 故连续重试几帧直到拿到实例。
  let _fsRetry = 0;
  function ensureFs() {
    if (typeof TrackMap === 'undefined') return;
    const st = TrackMap.state('fitMap');
    if (st) { registerFs(st); return; }
    if (_fsRetry++ > 10) return;
    setTimeout(ensureFs, 100);
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
    splitMode = false;
    cropHandles = null;
    if (crop) crop.cuts = [];
    renderList();
    renderPanel();
    renderCropBar();
    renderFsSide();
  }
  // 两个入口互切：拆分态点「地图裁剪」→ 回纯裁剪；裁剪态点「地图拆分」→ 叠加切点
  async function toggleCrop() {
    if (splitMode) { openEditor(false); syncCropBtn(); return; }
    if (cropMode) await exitCrop(); else enterCrop(); syncCropBtn();
  }
  function toggleSplit() {
    if (splitMode) { exitCrop(); syncCropBtn(); return; }
    if (cropMode) { openEditor(true); syncCropBtn(); return; }
    enterSplit(); syncCropBtn();
  }
  // 裁剪入口按钮态（无文件/裁剪中禁用与高亮）
  function syncCropBtn() {
    const b = document.getElementById('fitCropToggle');
    if (b) {
      b.classList.toggle('on', cropMode && !splitMode);
      b.disabled = !fitFiles.length;
      b.textContent = (cropMode && !splitMode) ? t('fit_cropDone') : t('fit_crop');
    }
    const s = document.getElementById('fitSplitToggle');
    if (s) {
      s.classList.toggle('on', splitMode);
      s.disabled = !fitFiles.length;
      s.textContent = splitMode ? t('fit_splitDone') : t('fit_splitViz');
    }
  }

  function renderCropBar() {
    let bar = document.getElementById('fitCropBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fitCropBar';
      bar.className = 'fit-cropbar';
      $('fitMapWrap').insertAdjacentElement('afterend', bar);
    }
    if (!cropMode || !crop || !fitFiles.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    updateCropBarText();
  }
  // 只刷新区间/里程/计数（拖拽中用），不重建按钮
  function updateCropBarText() {
    const bar = document.getElementById('fitCropBar');
    if (!bar || !cropMode || !crop) return;
    // 语言变化也要全量重建（fc-t/按钮文案不是 .fc-range/.fc-segs 这类局部节点）
    const wantMode = (splitMode ? 's' : 'c') + currentLang;
    if (!bar.querySelector('.fc-range') || bar.dataset.mode !== wantMode) { renderCropBarFull(bar); return; }
    const pts = crop.pts;
    bar.querySelector('.fc-range').textContent = t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length - 1].idx + 1 });
    bar.querySelector('.fc-meta').textContent = cropKm(crop.i0, crop.i1).toFixed(1) + ' km';
    const n = cropDraft.size;
    const all = bar.querySelector('.fc-apply-all');
    if (all) { all.disabled = !n; all.querySelector('.fc-n').textContent = n; }
    const segs = bar.querySelector('.fc-segs');
    if (segs) segs.textContent = t('fit_splitSegs', { n: cropCuts().length + 1 });
    const cutBtn = bar.querySelector('.fc-cutcount');
    if (cutBtn) cutBtn.textContent = cropCuts().length;
    refreshUploadTarget();   // 拖出新草稿后同步上传卡的「应用裁剪区间」可见性（签名去重，开销低）
  }
  function cropKm(i0, i1) {
    let d = 0, prev = null;
    for (const p of crop.pts) { if (p.idx < i0 || p.idx > i1) continue; if (prev) d += TrackMapDist(prev, p); prev = p; }
    return d / 1000;   // TrackMapDist 返回米，工具条按 km 显示
  }
  function renderCropBarFull(bar) {
    const pts = crop.pts;
    const n = cropDraft.size;
    bar.dataset.mode = (splitMode ? 's' : 'c') + currentLang;   // 语言入 key：切语言自动全量重建
    bar.style.display = '';
    const range = '<span class="fc-range">' + escapeHtml(t('fit_cropRange', { a: crop.i0 + 1, b: crop.i1 + 1, n: pts[pts.length-1].idx + 1 })) + '</span>'
      + '<span class="fc-meta">' + cropKm(crop.i0, crop.i1).toFixed(1) + ' km</span>';
    if (splitMode) {
      bar.innerHTML = '<span class="fc-t">' + escapeHtml(t('fit_splitVizTitle')) + '</span>' + range
        + '<span class="fc-segs" style="font-weight:700;color:var(--viz)">' + escapeHtml(t('fit_splitSegs', { n: cropCuts().length + 1 })) + '</span>'
        + '<button class="btn" onclick="FitUI.splitSuggest()" style="padding:4px 10px">' + escapeHtml(t('fit_splitSuggest')) + '</button>'
        + '<button class="btn" onclick="FitUI.splitClearCuts()" style="padding:4px 10px">' + escapeHtml(t('fit_cropReset')) + ' <b class="fc-cutcount">' + cropCuts().length + '</b></button>'
        + '<button class="btn" onclick="FitUI.splitGo()" style="padding:4px 10px">' + escapeHtml(t('fit_splitGoDl')) + '</button>'
        + '<button class="btn" onclick="FitUI.splitGo(\'list\')" style="padding:4px 10px">' + escapeHtml(t('fit_splitGoList')) + '</button>'
        + '<button class="btn" onclick="FitUI.toggleSplit()" style="padding:4px 10px">' + escapeHtml(t('fit_splitDone')) + '</button>';
      return;
    }
    bar.innerHTML = '<span class="fc-t">' + escapeHtml(t('fit_cropTitle')) + '</span>' + range
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
    if (!wrap || !crop || !fitFiles.length || typeof TrackMap === 'undefined' || !TrackMap.available()) {
      if (wrap) wrap.style.display = 'none';
      if (typeof TrackMap !== 'undefined') TrackMap.clear('fitMap');
      return;
    }
    const st = TrackMap.state('fitMap');
    const st0 = TrackMap.state('fitMap');
    const firstFit = fit !== undefined ? fit : (!st0 || !st0.cropHandles || !st0.cropHandles.length);
    // 全屏态：由 st.fsRenderer 绘制到全屏地图（含可拖端点）
    if (st && st.fullscreen) { wrap.style.display = ''; TrackMap.rerenderFullscreen(st, { fit: firstFit }); return; }
    wrap.style.display = '';
    const tracks = cropTracks();
    TrackMap.show('fitMap', tracks, { fit: firstFit, noAutoSE: true, handles: cropHandlesOpts(), cuts: cropCutsOpts() });
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
        TrackMap.redrawTracks(st, cropTracks(), { fit: false, noAutoSE: true, handles: cropHandlesOpts(), cuts: cropCutsOpts() });
      },
    };
  }
  // ---- 拆切点配置（split 模式内嵌/全屏共用）----
  // 点地图空白处 → 吸附加切点；点切点 → 删除；拖切点 → 移动。S/E 端点照常裁首尾。
  // 切点存 crop.cuts（保留区间内的 record 下标数组），label 按排序后的序号显示。
  function cropCutsOpts() {
    if (!splitMode || !crop) return null;
    const pts = crop.pts;
    const clamp = (idx) => Math.max(crop.i0 + 1, Math.min(crop.i1 - 1, idx));
    const commit = (cuts) => {
      crop.cuts = [...new Set(cuts.filter(c => c > crop.i0 && c < crop.i1))].sort((a, b) => a - b);
      const st = TrackMap.state('fitMap');
      if (!st) return;
      // 重绘切点与分段着色，视图不动（不 fit）
      if (st.fullscreen) TrackMap.rerenderFullscreen(st, { fit: false });
      else TrackMap.redrawTracks(st, cropTracks(), { fit: false, noAutoSE: true, handles: cropHandlesOpts(), cuts: cropCutsOpts() });
      updateCropBarText();
    };
    return {
      points: cropCuts().map((idx, i) => {
        const p = nearestPt(pts, idx);
        return p && Number.isFinite(p.lat) ? { id: 'c' + idx, lat: p.lat, lon: p.lon, label: String(i + 1) } : null;
      }).filter(Boolean),
      onMapClick: (ll) => {
        const idx = snapIdx(ll);
        if (idx == null) return;
        const c = clamp(idx);
        if (crop.cuts.includes(c)) return;
        commit([...crop.cuts, c]);
      },
      onCutDrag: () => {},
      onCutDrop: (id, ll) => {
        const idx = snapIdx(ll);
        const old = Number(String(id).slice(1));
        const at = crop.cuts.indexOf(old);
        if (at < 0) return;
        if (idx != null) crop.cuts[at] = clamp(idx);
        commit(crop.cuts);
      },
      onCutDelete: (id) => {
        const old = Number(String(id).slice(1));
        commit(crop.cuts.filter(c => c !== old));
      },
    };
  }
  // 一键按时间断点（沿用拆分卡的秒数输入）自动铺切点（并入已有，去重排序）
  function splitSuggest() {
    if (!splitMode || !crop) return;
    const f = fileByFid(); if (!f) return;
    const gs = Number($('fitSplitGap') && $('fitSplitGap').value) || 300;
    let cuts = [];
    try { cuts = FIT.gapIndices(f.bytes, gs); } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); return; }
    cuts = cuts.filter(c => c > crop.i0 && c < crop.i1);
    if (!cuts.length) { toast(t('fit_splitSuggestNone', { s: gs }), false); return; }
    crop.cuts = [...new Set([...(crop.cuts || []), ...cuts])].sort((a, b) => a - b);
    redrawEditorMap();
    updateCropBarText();
  }
  function splitClearCuts() {
    if (!splitMode || !crop) return;
    crop.cuts = [];
    redrawEditorMap(); updateCropBarText();
  }
  // 拆分执行：mode 省略=下载全部；'list'=产物入列表并选中最后一个
  function splitGo(mode) {
    if (!splitMode || !crop) return;
    const f = fileByFid(); if (!f) return;
    const cuts = cropCuts();
    if (!cuts.length) { toast(t('fit_splitNoCuts'), false); return; }
    try {
      const r = FIT.splitAt(f.bytes, { i0: crop.i0, i1: crop.i1, cuts });
      const stem = baseName(f.name);
      if (mode === 'list') {
        const added = [];
        r.files.forEach((b, i) => { const a = pushDerived(`${stem}-part${i + 1}.fit`, b); if (a) added.push(a); });
        if (!added.length) { toast(t('fit_parseFail'), false); return; }
        selectedFid = added[added.length - 1].id;
        renderList(); renderPanel();
        toast(t('fit_splitInList', { n: added.length }), true);
        return;
      }
      r.files.forEach((b, i) => {
        setTimeout(() => download(new Blob([b], { type: 'application/octet-stream' }), `${stem}-part${i + 1}.fit`), i * 250);
      });
      toast(t('fit_doneSplit', { n: r.files.length }), true);
    } catch (e) { toast(t('fit_fail') + ' ' + e.message, false); }
  }
  // 编辑态局部重绘（加/删/拖切点后；不 fit 视图）
  function redrawEditorMap() {
    const st = TrackMap.state('fitMap');
    if (!st) return;
    if (st.fullscreen) { TrackMap.rerenderFullscreen(st, { fit: false }); return; }
    TrackMap.redrawTracks(st, cropTracks(), { fit: false, noAutoSE: true, handles: cropHandlesOpts(), cuts: cropCutsOpts() });
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
    cropMode = false; cropHandles = null; splitMode = false;
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

  // 语言切换重渲染（index.html setLang 调用）：卡片标签/工具条/裁剪条/底图按钮
  // 都是运行时用 t() 拼的动态 DOM，applyI18n 的静态 data-i18n 覆盖不到。
  // _upSig 缓存的是含语言文案的 DOM 状态，须一并失效。renderMap 在裁剪模式下
  // 走 renderCropMap（fit:false），视图与切点状态保持不变。
  function relang() {
    _upSig = '';
    renderList();
    renderPanel();   // → renderMap：非裁剪全量重绘 / 裁剪态走 renderCropMap + syncCropBtn
    if (cropMode) { renderCropBar(); renderFsSide(); }
    refreshAuthPill();   // 胶囊文案跟随语言
    // 底图切换按钮文案在 setTile 首建时写死，语言切换只刷这里（含全屏壳）
    const labKey = { light: 'map_light', street: 'map_street', sat: 'map_sat' };
    document.querySelectorAll('.tm-tiles button[data-k]').forEach(b => {
      if (labKey[b.dataset.k]) b.textContent = t(labKey[b.dataset.k]);
    });
  }

  function renderPanel() {
    const n = fitFiles.length;
    $('fitPanel').style.display = n ? '' : 'none';
    if (!n) {
      const wrap = $('fitMapWrap');
      if (wrap) wrap.style.display = 'none';
      if (typeof TrackMap !== 'undefined') TrackMap.clear('fitMap');
      const eleCard = $('fitEleCard'); if (eleCard) eleCard.style.display = 'none';
      refreshAuthPill();
      syncCropBtn();
      return;
    }
    const one = n >= 1;
    $('fitOpSplit').style.display = one ? '' : 'none';
    $('fitOpCombine').style.display = n >= 2 ? '' : 'none';
    const upOp = $('fitOpUpload'); if (upOp) upOp.style.display = one ? '' : 'none';
    $('fitOpMini').style.display = one ? '' : 'none';
    $('fitCombineHint').textContent = t('fit_combineHint', { n });
    const sf = getSelectedFile();
    const sfName = sf ? baseName(sf.name) : '-';
    $('fitSplitTarget').textContent = sfName;
    $('fitStripTarget').textContent = sfName;
    $('fitConvertTarget').textContent = sfName;
    refreshUploadTarget();
    renderMap();
    renderProfile();
  }

  // ---- 上传到 Strava（经本地服务代理，浏览器直连被 CORS 拦） ----
  let _uploadPending = null;   // 缺 write scope 时暂存 {bytes,fields}，授权后自动续传
  let _upSig = '';             // 上传卡上次渲染签名：无变化不动 DOM（拖拽高频回调下防重排）
  function refreshUploadTarget() {
    const sel = $('fitUploadTarget'); if (!sel) return;
    const sf = getSelectedFile();
    const sig = fitFiles.map(f => f.id + ':' + f.name).join('|') + '#' + (sf ? sf.id : 0) + '#' + (sf && cropDraft.has(sf.id) ? 1 : 0);
    if (sig === _upSig) return;
    _upSig = sig;
    sel.innerHTML = fitFiles.map((f, i) =>
      `<option value="${i}"${sf && f.id === sf.id ? ' selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
    const row = $('fitUploadCropRow');
    if (row) row.style.display = (sf && cropDraft.has(sf.id)) ? '' : 'none';
  }
  function setUploadBusy(on) {
    const b = $('fitUploadBtn'); if (!b) return;
    b.disabled = on; b.textContent = on ? t('fit_uploading') : t('fit_uploadDo');
  }
  function showProg(msg) { const p = $('fitUploadProgress'); if (p) { p.style.display = ''; p.textContent = msg; } }
  function hideProg() { const p = $('fitUploadProgress'); if (p) p.style.display = 'none'; }
  function showResult(html, ok) {
    const r = $('fitUploadResult'); if (!r) return;
    r.style.display = ''; r.innerHTML = html; r.style.color = ok ? 'var(--ok,#16a34a)' : 'var(--err,#dc2626)';
  }
  async function pollUploadProgress() {
    try {
      const p = await apiGet('/api/strava/upload/progress');
      if (!p || !p.running) return;
      // 服务端 message 是固定中文；前端按 state 映射本地化文案
      showProg(p.state === 'uploading' ? t('fit_uploading') : t('fit_uploadProcessing'));
    } catch { /* 忽略轮询失败 */ }
  }
  async function runUpload() {
    const f = getSelectedFile(); if (!f) return;
    if (typeof ensureApiToken === 'function') await ensureApiToken();
    const cropRow = $('fitUploadCropRow');
    const useCrop = cropRow && cropRow.style.display !== 'none' && $('fitUploadUseCrop').checked;
    let bytes = f.bytes, shownName = baseName(f.name);
    if (useCrop) {
      const r = buildCrop(f);
      if (r) { bytes = r.bytes; shownName = baseName(r.name); }
      else { toast(t('fit_cropNoop'), false); }
    }
    const name = ($('fitUploadName').value || '').trim() || shownName;
    const fields = { name };
    if ($('fitUploadPrivate').checked) fields.private = '1';
    if ($('fitUploadCommute').checked) fields.commute = '1';
    await doUpload(bytes, fields);
  }
  async function doUpload(bytes, fields) {
    setUploadBusy(true); hideProg();
    const resEl = $('fitUploadResult'); if (resEl) resEl.style.display = 'none';
    const authEl = $('fitUploadAuthHint'); if (authEl) authEl.style.display = 'none';
    showProg(t('fit_uploading'));
    const poll = setInterval(pollUploadProgress, 1200);
    try {
      const q = new URLSearchParams({ type: 'fit', fields: JSON.stringify(fields), name: fields.name }).toString();
      const resp = await fetch(`${API}/api/strava/upload?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + apiToken },
        body: bytes,
      });
      const d = await resp.json().catch(() => ({ error: '响应解析失败' }));
      if (d.code === 'MISSING_SCOPES') {
        _uploadPending = { bytes, fields };
        if (authEl) authEl.style.display = '';
        showResult(t('fit_uploadFail') + t('fit_uploadAuthNeed'), false);
        return;
      }
      if (d.ok && d.activity_id) {
        hideProg();
        const link = `https://www.strava.com/activities/${d.activity_id}`;
        showResult(`${escapeHtml(t('fit_uploadDoneT'))} · <a href="${link}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">${escapeHtml(t('fit_uploadView'))}</a>`, true);
        toast(t('fit_uploadDoneT'), true);
      } else if (d.code === 'DUPLICATE') {
        showResult(t('fit_uploadDup'), false);
      } else if (d.code === 'TIMEOUT') {
        showResult(t('fit_uploadTimeout'), false);
      } else {
        showResult(t('fit_uploadFail') + escapeHtml(d.error || '未知错误'), false);
      }
    } catch (e) {
      showResult(t('fit_uploadFail') + escapeHtml(String(e.message || e)), false);
    } finally {
      clearInterval(poll); hideProg(); setUploadBusy(false);
    }
  }
  // 缺 write scope → 走一次强制 OAuth，轮询 can_upload 成功后自动续传暂存上传
  let _reauthBusy = false;      // 防重入：反复点胶囊会开出多个授权窗口 + 多个轮询
  async function reauthForUpload() {
    if (_reauthBusy) return;
    _reauthBusy = true;
    if (typeof ensureApiToken === 'function') await ensureApiToken();
    const pill = $('fitUploadAuthPill'); if (pill) pill.style.display = 'none';   // 授权中隐藏状态胶囊，避免和进度文案重复
    showProg(t('fit_uploadReauthWait'));
    try {
      const r = await apiGet('/api/oauth/start');
      if (!r.url) { showResult(t('fit_uploadFail') + escapeHtml(r.error || ''), false); hideProg(); _reauthBusy = false; return; }
      let w = null; try { w = window.open(r.url, '_blank', 'width=520,height=700'); } catch { w = null; }
      // 弹窗被拦截时给一个可点的兜底链接（设置页同样做法），
      // 否则用户只能干等 2 分钟直到轮询超时
      if (!w) {
        showResult(t('fit_uploadAuthOpenHint') + ' <a href="' + escapeHtml(r.url) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">' + escapeHtml(t('fit_uploadAuthOpenLink')) + '</a>', false);
      }
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        try {
          const info = await apiGet('/api/info');
          if (info && info.strava && info.strava.can_upload) {
            clearInterval(timer);
            try { if (w && !w.closed) w.close(); } catch { /* noop */ }
            hideProg();
            showResult(t('fit_uploadReauthOk'), true);
            const pend = _uploadPending; _uploadPending = null;
            const authEl = $('fitUploadAuthHint'); if (authEl) authEl.style.display = 'none';
            _reauthBusy = false;
            if (pend) await doUpload(pend.bytes, pend.fields);
          }
        } catch { /* 轮询忽略 */ }
        if (tries > 120) { clearInterval(timer); hideProg(); showResult(t('fit_uploadReauthFail'), false); _reauthBusy = false; }
      }, 1000);
    } catch (e) {
      hideProg(); showResult(t('fit_uploadFail') + escapeHtml(String(e.message || e)), false);
      _reauthBusy = false;
    }
  }

  // 授权状态胶囊：can_upload=true → 绿「已授权」；false → 红胶囊可点击=授权按钮
  // unknown（未登录/请求失败）→ 隐藏。授权完成自动续传逻辑见 reauthForUpload。
  let _authPillTimer = null;
  async function refreshAuthPill() {
    const pill = $('fitUploadAuthPill'); if (!pill) return;
    const n = fitFiles.length;
    if (!n) { pill.style.display = 'none'; return; }
    let state = 'unknown';
    try {
      const info = await apiGet('/api/info');
      state = (info && info.strava && info.strava.can_upload) ? 'ok' : 'no';
    } catch { state = 'unknown'; }
    if (state === 'unknown') { pill.style.display = 'none'; return; }
    pill.style.display = '';
    pill.dataset.state = state;
    pill.textContent = state === 'ok' ? '✓ ' + t('fit_authOk') : t('fit_authNeed');
  }

  function init() {
    const list = $('fitFileList');
    const input = $('fitInput');
    if (!list || !input) return;
    input.addEventListener('change', e => {
      const files = Array.from(e.target.files || []);
      input.value = '';
      if (files.length) addFiles(files);
    });
    // 整条列表都是拖放落点：「添加」卡片常驻首位，点击开选择器，拖入任意位置都收
    ['dragenter', 'dragover'].forEach(ev => list.addEventListener(ev, e => { e.preventDefault(); list.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => list.addEventListener(ev, e => { e.preventDefault(); list.classList.remove('over'); }));
    list.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

    $('fitSplitMode').addEventListener('change', () => {
      const m = $('fitSplitMode').value;
      $('fitGapRow').style.display = m === 'gap' ? '' : 'none';
      $('fitCountRow').style.display = m === 'count' ? '' : 'none';
    });
    $('fitSplitMode').dispatchEvent(new Event('change'));
    renderList(); renderPanel();
    refreshAuthPill();
    if (_authPillTimer) clearInterval(_authPillTimer);
    _authPillTimer = setInterval(refreshAuthPill, 60000);   // 授权状态低频轮询（用户可能在别处完成授权）
  }

  return { init, relang, addFiles, remove, clearAll, pickFiles, runStrip, runConvert, runEleCalib, runGcjFix, runSplit, runCombine, toggleCrop, toggleSplit, cropApply, cropApplyAll, cropDownload, cropReset, cropSelectFile, selectFile, splitSuggest, splitClearCuts, splitGo, runUpload, reauthForUpload, ensureFs };
})();
