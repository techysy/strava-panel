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
  function renderMap(bytesList) {
    const wrap = $('fitMapWrap');
    if (!wrap) return;
    const src = bytesList || fitFiles.map(f => f.bytes);
    const tracks = src.map(b => { try { return FIT.trackPoints(b); } catch (e) { return []; } }).filter(p => p.length);
    if (!tracks.length || typeof TrackMap === 'undefined' || !TrackMap.available()) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    TrackMap.show('fitMap', tracks);
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

  return { init, addFiles, remove, clearAll, runStrip, runSplit, runCombine, runConvert };
})();
