/* ===== app3.js : data loading, time bar, sidebar tabs (Data, Products, Colours, QC, Temps, Flight path, LLCC, Settings) ===== */
var worker = null, jobs = {}, jobId = 0;
function decodeBuf(u8) {
  return new Promise(function (res, rej) {
    try { if (!worker) { worker = new Worker(URL.createObjectURL(new Blob([$('decoder-src').textContent], { type: 'text/javascript' }))); worker.onmessage = function (ev) { var j = jobs[ev.data.id]; delete jobs[ev.data.id]; if (!j) return; if (ev.data.error) j.rej(new Error(ev.data.error)); else j.res(ev.data.vol); }; worker.onerror = function () { worker = false; }; } } catch (e) { worker = false; }
    if (!worker) { try { res(RWDecoder.decodeLevel2(u8)); } catch (e2) { rej(e2); } return; }
    var id = ++jobId; jobs[id] = { res: res, rej: rej }; var buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); worker.postMessage({ id: id, buf: buf }, [buf]);
  });
}
function volBytes(v) { var n = 0; v.sweeps.forEach(function (s) { for (var k in s.mom) n += s.mom[k].raw.byteLength; }); return n; }
async function ingest(u8, hint) {
  u8 = await RWIO.maybeGunzip(u8); var vol = await decodeBuf(u8); vol.key = vol.site + '_' + vol.time; vol.bytes = volBytes(vol);
  var srcId = hint || (vol.site === S.nexSite || (S.sources.wsr.files.length && S.sources.wsr.files[0].site !== vol.site && /^[KTP][A-Z]{3}$/.test(vol.site)) ? 'nex' : 'wsr'), src = S.sources[srcId];
  if (src.files.some(function (f) { return f.key === vol.key; })) return null;
  if (srcId !== 'wsr') src.label = vol.site; else src.label = 'WSR ' + vol.site;
  src.files.push(vol); src.files.sort(function (a, b) { return a.time - b.time; });
  var budget = (S.memMB || 900) * 1048576 * (srcId === 'wsr' ? 0.65 : 0.35), tot = src.files.reduce(function (s, f) { return s + f.bytes; }, 0);
  while (tot > budget && src.files.length > 2) tot -= src.files.shift().bytes;
  return vol;
}
function afterData(jumpLatest) {
  ['wsr', 'nex'].forEach(rebuildFrames);
  var pf = primarySrc().frames; if (pf.length && (jumpLatest || !S.time || !frameAt(primarySrc().id, S.time, 0.01))) S.time = pf[pf.length - 1].time;
  refreshSelectors(); updateTimebar(); invalidate(); drawXS(); scheduleLLCC(); renderTab(); updateWelcome();
  if (pf.length && S.prof.isDefault && !S.profTried) { S.profTried = true; profileFetch('best_match', true); }
}
async function ingestFiles(fileList) {
  var n = 0, errs = [];
  for (var i = 0; i < fileList.length; i++) {
    var f = fileList[i]; status('Reading ' + f.name + ' …');
    try {
      var u8 = new Uint8Array(await f.arrayBuffer());
      if (u8[0] === 0x50 && u8[1] === 0x4b) { var ents = await RWIO.unzip(u8); for (var j = 0; j < ents.length; j++) { status('Decoding ' + ents[j].name + ' (' + (j + 1) + '/' + ents.length + ') …'); try { if (await ingest(ents[j].data)) n++; } catch (e) { errs.push(ents[j].name + ': ' + e.message); } } }
      else if (/\.(csv|txt|traj|tsv)$/i.test(f.name)) { loadTrajText(new TextDecoder().decode(u8), f.name); }
      else if (/\.pal$/i.test(f.name)) { var ct = RWC.parsePal(new TextDecoder().decode(u8), f.name.replace(/\.pal$/i, '')); S.cts[ct.id] = ct; bumpCt(); saveSettings(); toast('Imported colour table “' + ct.name + '”'); }
      else if (await ingest(u8)) n++;
    } catch (e) { errs.push(f.name + ': ' + e.message); }
  }
  if (errs.length) toast(errs.slice(0, 3).join('\n'), 'err'); if (n) toast('Loaded ' + n + ' radar file' + (n > 1 ? 's' : '')); status(''); afterData(true);
}
function corsHelp(e) { return e.cors ? e.message + '. The browser was refused a direct connection (usually CORS or the network). Set a relay URL under Settings → Connections, or download the file/zip in a browser tab and drop it on this page.' : e.message; }
async function pool(items, n, fn) { var i = 0; async function run() { while (i < items.length) { var k = i++; await fn(items[k], k); } } var a = []; for (var j = 0; j < n; j++) a.push(run()); await Promise.all(a); }
async function wsrLoadRange(t0, t1, quiet) {
  status('Listing WSR files …'); var rows;
  try { rows = await RWIO.wsrRange(t0, t1); S.connErr = null; } catch (e) { status(''); if (!quiet) connFail(e); return 0; }
  var have = {}; S.sources.wsr.files.forEach(function (f) { have[Math.round(f.headerTime / 1000)] = 1; have[Math.round(f.time / 1000)] = 1; });
  rows = rows.filter(function (r) { return !have[Math.round(r.time / 1000)]; }); if (rows.length > 400) rows = rows.slice(-400);
  var done = 0, ok = 0, lastErr = null;
  await pool(rows, 3, async function (r) { try { if (await ingest(await RWIO.wsrFile(r), 'wsr')) ok++; } catch (e) { lastErr = e; } status('WSR: ' + (++done) + ' / ' + rows.length + ' files'); });
  status(''); if (lastErr && !ok && !quiet) connFail(lastErr); if (ok) afterData(true); else if (!quiet && !lastErr) toast(rows.length ? 'No new files decoded' : 'No new WSR files in that window');
  return ok;
}
async function wsrLoadLatest() {
  status('Requesting latest WSR file …');
  try { var u8 = await RWIO.wsrFile(null), v = await ingest(u8, 'wsr'); status(''); S.connErr = null; afterData(true); var fr = S.sources.wsr.frames; if (v && fr.length && fr[fr.length - 1].partial && fr[fr.length - 1].sweeps.length < 4) { toast('Files hold one or two tilts each; pulling the last ' + S.wsrWindow + ' min to assemble a volume'); await wsrLoadRange(v.time - S.wsrWindow * 60000, v.time + 1000, true); } else if (v) toast('Loaded ' + v.site + ' ' + fmtT(v.time, true)); }
  catch (e) { status(''); connFail(e); }
}
var liveTimer = null;
function setLive(on) { S.live = on; clearInterval(liveTimer); if (on) { var tick = function () { var f = S.sources.wsr.files, last = f.length ? f[f.length - 1].time : Date.now() - 10 * 60000; wsrLoadRange(Math.max(last + 1000, Date.now() - 30 * 60000), Date.now() + 60000, true); }; tick(); liveTimer = setInterval(tick, 60000); } $('live').checked = on; }
async function nexradFetch(times) {
  var site = S.nexSite.toUpperCase(), got = 0;
  try {
    var seen = {}; for (var i = 0; i < times.length; i++) {
      status('Listing ' + site + ' volumes on AWS …'); var list = await RWIO.nexradList(site, times[i]), best = null; list.forEach(function (r) { if (r.time <= times[i] + 150000 && (!best || Math.abs(r.time - times[i]) < Math.abs(best.time - times[i]))) best = r; });
      if (!best || seen[best.key] || Math.abs(best.time - times[i]) > 20 * 60000) continue; seen[best.key] = 1; status('Downloading ' + best.key.split('/').pop() + ' …'); if (await ingest(await RWIO.nexradFile(best), 'nex')) got++;
    }
  } catch (e) { toast(site + ': ' + corsHelp(e), 'err'); }
  status(''); if (got) { toast('Loaded ' + got + ' ' + site + ' volume' + (got > 1 ? 's' : '')); afterData(false); } else toast('No new ' + site + ' volume found near that time');
}
async function mrmsFetch(t) {
  try { status('MRMS: finding mosaic …'); var G = await RWIO.mrmsVolume(t, gridSpecNow(), S.origin, RW.xy2ll, RW.enc, function (a, b) { status('MRMS 3-D mosaic: level ' + a + ' / ' + b); }); var fr = { time: G.time, site: 'MRMS', key: 'mrms_' + G.time, grid: G, lat: NaN, lon: NaN }; var src = S.sources.mrms; src.frames = src.frames.filter(function (f) { return f.key !== fr.key; }); src.frames.push(fr); src.frames.sort(function (a, b) { return a.time - b.time; }); while (src.frames.length > 12) src.frames.shift(); status(''); toast('MRMS mosaic ' + fmtT(G.time, true) + (G.missingLevels ? ' (' + G.missingLevels + ' levels missing)' : '')); afterData(false); }
  catch (e) { status(''); toast('MRMS: ' + corsHelp(e), 'err'); }
}
async function profileFetch(model, quiet) {
  var t = S.time || Date.now(), ll = S.traj ? S.traj.pts[0] : S.origin;
  try { status('Fetching model temperature profile …'); S.prof = await RWIO.fetchProfile(ll.lat, ll.lon, t, model); S.profV++; status(''); toast('Temperature profile: ' + S.prof.source); invalidate(); drawXS(); scheduleLLCC(); renderTab(); }
  catch (e) { status(''); if (!quiet) toast('Temperature profile: ' + e.message, 'err'); renderSetup(); }
}
function loadTrajText(txt, name) { try { var t = RW.parseTrajectory(txt); S.traj = t; S.trajName = name; prepTraj(); toast('Flight path loaded: ' + t.pts.length + ' points' + (t.notes.length ? ' · ' + t.notes.join('; ') : '')); invalidate(); drawXS(); scheduleLLCC(); renderTab(); } catch (e) { toast('Flight path: ' + e.message, 'err'); } }

/* ---------- time bar ---------- */
var playTimer = null;
function times() { return primarySrc().frames.map(function (f) { return f.time; }); }
function updateTimebar() { var t = times(), sl = $('tslider'); sl.max = Math.max(0, t.length - 1); var i = t.indexOf(S.time); if (i < 0 && t.length) { i = t.length - 1; S.time = t[i]; } sl.value = Math.max(0, i); $('tlabel').textContent = t.length ? fmtT(S.time, true) + '   (' + (i + 1) + '/' + t.length + ')' : 'no data loaded'; }
function setTimeIdx(i) { var t = times(); if (!t.length) return; i = (i + t.length) % t.length; S.time = t[i]; updateTimebar(); panelsUI.forEach(function (ui) { fillTilt(ui, S.panels[ui.pi]); }); invalidate(); drawXS(); scheduleLLCC(); if (View3D.isOpen()) View3D.rebuild(); TiltGrid.rebuild(); }
function stepTime(d) { setTimeIdx(times().indexOf(S.time) + d); }
function togglePlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; } else playTimer = setInterval(function () { stepTime(1); }, 450); $('play').textContent = playTimer ? '❚❚' : '▶'; }

/* ---------- LLCC ---------- */
var llccTimer = null;
function scheduleLLCC() { clearTimeout(llccTimer); llccTimer = setTimeout(runLLCC, 250); }
function runLLCC() {
  var P = S.panels[0], fr = curFrame(P.src); S.llccRes = null;
  if (S.trajP && S.trajP.length > 1 && fr) { var G = gridOf(P.src, fr); if (G) { var t0 = performance.now(); S.llccRes = RW.evalLLCC(G, S.prof, S.trajP, S.llcc); S.llccRes.ms = performance.now() - t0; S.llccRes.frame = fr; S.llccRes.src = P.src; } }
  panelsUI.forEach(drawOverlay); if (curTab === 'llcc') renderTab(); else renderSetup();
}
function chip(kind, text) { return h('span', { class: 'chip ' + kind, text: text }); }
function llccRows(E) {
  var L = S.llcc, rows = [], nm = function (d) { return isFinite(d) ? (d / NMI).toFixed(1) + ' nmi' : 'none within search'; };
  var thr = L.cloudThr + ' dBZ';
  if (S.sources[E.src].kind === 'radar' && S.trajP) { var cut = null, c0 = covTop(E.frame, S.trajP[0].x, S.trajP[0].y); for (var i = 0; i < S.trajP.length && !cut; i++) { var q = S.trajP[i], cv = covTop(E.frame, q.x, q.y); if (cv && q.z > cv.top) cut = { z: q.z, T: RW.tempAt(S.prof, q.z) }; } if (c0) rows.push({ rule: 'Radar coverage', item: 'Scan reaches the flight path at all altitudes checked', val: cut ? 'NO · highest tilt is ' + c0.el.toFixed(1) + '°, so the scan tops out near ' + fmtH(c0.top) + ' over the pad. The path above ' + fmtH(cut.z) + ' (' + cut.T.toFixed(0) + ' °C) is not observed, and cloud tops at that height are lower bounds. Every row below only describes what this scan can see.' : 'Yes, up to ' + fmtH(L.zMax), st: cut ? 'warn' : 'ok' }); }
  rows.push({ rule: 'All cloud rules', item: 'Flight path through radar cloud (≥' + thr + ')', val: isFinite(E.through.maxZ) ? 'YES · up to ' + E.through.maxZ.toFixed(0) + ' dBZ at ' + fmtH(E.through.at.z) + ' (' + E.through.at.T.toFixed(0) + ' °C)' : 'No echo on the path', st: isFinite(E.through.maxZ) ? 'bad' : 'ok' });
  var near = isFinite(E.through.maxZ) ? 0 : E.any.d; L.standoffs.forEach(function (s) { rows.push({ rule: 'Anvil / debris standoff', item: 'Radar cloud edge within ' + s + ' nmi (slant)', val: 'nearest ' + nm(near) + (E.any.at ? ' · at ' + fmtH(E.any.at.z) : ''), st: near <= s * NMI ? 'bad' : 'ok' }); });
  E.classes.forEach(function (c) { var d = c.d; if (isFinite(E.through.maxZ) && c.at && d < E.res * 1.5) d = 0; rows.push({ rule: 'Cumulus', item: 'Cloud with top colder than ' + c.T + ' °C ' + (c.nmi ? 'within ' + c.nmi + ' nmi' : 'on the flight path'), val: c.at ? 'nearest ' + nm(d) + ' · top ' + fmtH(c.at.topZ) + ' (' + c.at.topT.toFixed(0) + ' °C)' : 'none within search', st: !c.at ? 'ok' : (c.nmi ? d <= c.nmi * NMI : d <= E.res) ? 'bad' : 'ok' }); });
  rows.push({ rule: 'Disturbed weather', item: 'Moderate precipitation (≥' + L.modPrecip + ' dBZ) within ' + L.distWxNmi + ' nmi', val: 'nearest ' + nm(E.mod.d), st: E.mod.d <= L.distWxNmi * NMI ? 'warn' : 'ok' });
  rows.push({ rule: 'Anvil / debris (VAHIRR)', item: 'Max VAHIRR within ' + L.vahirrWithin + ' nmi of the path (limit +' + L.vahirrLimit + ' dBZ-km)', val: isFinite(E.vahirr.v) ? E.vahirr.v.toFixed(1) + ' dBZ-km (' + (E.vahirr.v * 3.28084).toFixed(0) + ' dBZ-kft) = ' + E.vahirr.at.avgZ.toFixed(1) + ' dBZ × ' + E.vahirr.at.thick.toFixed(2) + ' km' : 'no cloud colder than 0 °C in the specified volumes', st: !isFinite(E.vahirr.v) ? 'ok' : E.vahirr.v >= L.vahirrLimit ? 'bad' : 'ok' });
  rows.push({ rule: 'Thick cloud layers', item: 'Echo layer ≥' + L.thickFt + ' ft with any part between ' + L.thickTop + ' and ' + L.thickBot + ' °C, within ' + L.thickNmi + ' nmi', val: E.thick.at ? 'deepest ' + (E.thick.v / KFT * 1000).toFixed(0) + ' ft (' + fmtH(E.thick.at.base) + ' to ' + fmtH(E.thick.at.top) + ')' : 'no qualifying layer', st: E.thick.v * 1000 / KFT >= L.thickFt ? 'warn' : 'ok' });
  var tb = E.tribo; rows.push({ rule: 'Triboelectrification', item: 'Radar cloud on the path colder than ' + L.triboT + ' °C while slower than ' + L.triboFps + ' ft/s', val: tb.length ? 'YES · ' + fmtH(tb[0].z) + ' to ' + fmtH(tb[tb.length - 1].z) + (isFinite(tb[0].spd) ? '' : ' (no speed in file: all altitudes checked)') : 'none', st: tb.length ? 'warn' : 'ok' });
  return rows;
}
function exportPathCSV() { var E = S.llccRes; if (!E) return; var o = ['time_s,alt_ft,temp_C,speed_fps,dBZ_at_point,nearest_radar_cloud_nmi']; E.rows.forEach(function (r) { o.push([isFinite(r.t) ? r.t.toFixed(1) : '', (r.z / KFT * 1000).toFixed(0), r.T.toFixed(1), isFinite(r.spd) ? (r.spd / 0.3048).toFixed(0) : '', isFinite(r.dbz) ? r.dbz.toFixed(1) : '', isFinite(r.near) ? (r.near / NMI).toFixed(2) : '']); }); download('flight_path_radar_table.csv', o.join('\n')); }
function download(name, text) { var a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name }); document.body.appendChild(a); a.click(); a.remove(); }

/* ---------- sidebar ---------- */
var curTab = 'data', TABS = [['data', '1 · Radar'], ['temp', '2 · Temps'], ['path', '3 · Flight path'], ['llcc', '4 · LLCC'], ['prod', 'Products'], ['color', 'Colours'], ['qc', 'QC'], ['set', 'Settings']];
function field(label, input, hint) { return h('label', { class: 'fld' }, [h('span', { text: label }), input, hint ? h('small', { text: hint }) : null]); }
function num(val, on, attrs) { var a = Object.assign({ type: 'number', value: val }, attrs || {}); a.onchange = function (e) { var v = parseFloat(e.target.value); if (isFinite(v)) on(v); }; return h('input', a); }
function chk(val, on, label) { var i = h('input', { type: 'checkbox' }); i.checked = !!val; i.addEventListener('change', function () { on(i.checked); }); return h('label', { class: 'chk' }, [i, label]); }
function btn(text, on, cls) { return h('button', { class: cls || '', onclick: on, text: text }); }
function sel(opts, val, on) { var s = h('select', { onchange: function () { on(s.value); } }); opts.forEach(function (o) { s.appendChild(opt(o[0], o[1], String(o[0]) === String(val))); }); return s; }
function sec(title, kids) { return h('section', {}, [h('h3', { text: title })].concat(kids)); }
function note(t, cls) { return h('p', { class: 'note ' + (cls || ''), html: t }); }
function buildTabs() { var nav = $('tabs'); nav.innerHTML = ''; TABS.forEach(function (t, i) { if (i === 4) nav.appendChild(h('span', { class: 'brk' })); nav.appendChild(h('button', { class: (curTab === t[0] ? 'on ' : '') + (i < 4 ? 'flow' : 'tool'), text: t[1], onclick: function () { goTab(t[0]); } })); }); }
function goTab(t) { curTab = t; buildTabs(); renderTab(); }
function qcChanged() { S.qc.version++; S.qc.preset = 'custom'; saveSettings(); invalidate(); drawXS(); scheduleLLCC(); }
function renderTab() { renderSetup(); var b = $('tabbody'); b.innerHTML = ''; ({ data: tabData, prod: tabProd, color: tabColor, qc: tabQC, temp: tabTemp, path: tabPath, llcc: tabLLCC, set: tabSet })[curTab](b); }

function tabData(b) {
  var W = S.sources.wsr, N = S.sources.nex, M = S.sources.mrms, mins = h('select', {}, [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']].map(function (o) { return opt(o[0], o[1], o[0] === 30); }));
  var t0 = h('input', { type: 'datetime-local', step: 60 }), dur = h('select', {}, [[15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h']].map(function (o) { return opt(o[0], o[1], o[0] === 30); }));
  if (S.connErr && $('welcome').classList.contains('hidden')) b.appendChild(connBox());
  b.appendChild(sec('WSR (RAD API)', [
    h('div', { class: 'row' }, [btn('Load latest', wsrLoadLatest, 'pri'), btn('Load last', function () { wsrLoadRange(Date.now() - mins.value * 60000, Date.now() + 60000); }), mins]),
    field('Archive: start (UTC)', t0), h('div', { class: 'row' }, [dur, btn('Load window', function () { if (!t0.value) return toast('Pick a start time (UTC)', 'err'); var s = RWIO.parseTime(t0.value.length === 16 ? t0.value + ':00' : t0.value); wsrLoadRange(s, s + dur.value * 60000); })]),
    note(W.files.length ? W.files.length + ' files · ' + W.frames.length + ' frames · ' + fmtT(W.files[0].time) + ' → ' + fmtT(W.files[W.files.length - 1].time) + (W.frames.length && W.frames[W.frames.length - 1].partial ? '<br>Volumes span more than one file; each frame uses the latest sweep at each elevation within ' + S.wsrWindow + ' min.' : '') : 'Nothing loaded yet.')
  ]));
  var fi = h('input', { type: 'file', multiple: '', onchange: function () { ingestFiles(fi.files); } });
  b.appendChild(sec('Local files', [h('div', { class: 'drop', id: 'dropzone' }, ['Drop Level II files, a range-download .zip, a flight-path CSV or a .pal colour table anywhere on the page, or ', fi])]));
  var site = h('input', { type: 'text', value: S.nexSite, size: 5, onchange: function () { S.nexSite = site.value.toUpperCase().trim(); saveSettings(); } });
  b.appendChild(sec('NEXRAD comparison (AWS)', [h('div', { class: 'row' }, [site, btn('Fetch for this time', function () { nexradFetch([S.time || Date.now()]); }), btn('Match all frames', function () { var t = times(); if (t.length > 10) t = t.filter(function (_, i) { return i % Math.ceil(t.length / 10) === 0; }); nexradFetch(t.length ? t : [Date.now()]); })]), note(N.frames.length ? N.frames.length + ' volumes loaded (' + N.label + ')' : 'Pulls the Level II volume nearest the displayed time from the public NEXRAD archive.')]));
  b.appendChild(sec('MRMS comparison (AWS)', [h('div', { class: 'row' }, [btn('Fetch 3-D mosaic for this time', function () { mrmsFetch(S.time || Date.now()); })]), note(M.frames.length ? M.frames.length + ' mosaics loaded' : 'Downloads the 33-level MergedReflectivityQC mosaic (about 30 to 60 MB) and resamples it to the analysis grid, so every derived product, cross-section and the 3-D view work on it.')]));
  b.appendChild(sec('Loaded data', [h('div', { class: 'row' }, [btn('Clear WSR', function () { W.files = []; W.frames = []; afterData(); }), btn('Clear NEXRAD', function () { N.files = []; N.frames = []; afterData(); }), btn('Clear MRMS', function () { M.frames = []; afterData(); })])]));
}
function levInput(lev, on) {
  var kind = sel([['none', '—'], ['T', 'temperature °C'], ['z', 'height kft']], lev ? (lev.T != null ? 'T' : 'z') : 'none', upd), v = h('input', { type: 'number', step: 'any', value: lev ? (lev.T != null ? lev.T : +(lev.z / KFT).toFixed(2)) : 0, style: 'width:70px' });
  function upd() { var x = parseFloat(v.value); on(kind.value === 'none' || !isFinite(x) ? null : kind.value === 'T' ? { T: x } : { z: x * KFT }); } v.addEventListener('change', upd); return h('span', { class: 'row' }, [kind, v]);
}
function tabProd(b) {
  var d = { type: 'etop', thr: 10, lev: null, lev2: null, name: '' }, nameI = h('input', { type: 'text', placeholder: 'e.g. Echo top 10 dBZ' });
  var form = h('div'); function drawForm() { form.innerHTML = ''; var T = RW.PRODUCT_TYPES[d.type]; if (T.params.indexOf('thr') >= 0) form.appendChild(field('Threshold (dBZ)', num(d.thr, function (v) { d.thr = v; }, { step: 'any' }))); if (T.params.indexOf('lev') >= 0) form.appendChild(field(d.type === 'cappi' ? 'Level' : 'From (lower bound)', levInput(d.lev, function (l) { d.lev = l; }))); if (T.params.indexOf('lev2') >= 0) form.appendChild(field('To (upper bound)', levInput(d.lev2, function (l) { d.lev2 = l; }), 'Leave “—” for surface / echo top.')); }
  drawForm();
  b.appendChild(sec('Build a product', [field('Type', sel(Object.keys(RW.PRODUCT_TYPES).map(function (k) { return [k, RW.PRODUCT_TYPES[k].label]; }), d.type, function (v) { d.type = v; drawForm(); })), form, field('Name', nameI),
    btn('Add product', function () { if (d.type === 'cappi' && !d.lev) return toast('A CAPPI needs a level', 'err'); var p = { id: 'p' + Date.now().toString(36), name: nameI.value || RW.PRODUCT_TYPES[d.type].label, type: d.type, custom: true }; var T = RW.PRODUCT_TYPES[d.type]; if (T.params.indexOf('thr') >= 0) p.thr = d.thr; if (d.lev) p.lev = d.lev; if (d.lev2) p.lev2 = d.lev2; S.prods.push(p); saveSettings(); S.panels[0].prod = p.id; refreshSelectors(); invalidate(); renderTab(); }, 'pri'),
    note('Products are computed from the 3-D reflectivity grid of whichever source a panel shows (WSR, NEXRAD or MRMS), after QC. Temperature levels come from the Temps tab. Echo tops are interpolated to the threshold between grid levels.')]));
  var list = h('div', { class: 'list' }); S.prods.forEach(function (p, i) { list.appendChild(h('div', { class: 'li' }, [h('span', { text: p.name }), h('span', { class: 'row' }, [btn('show', function () { S.panels[0].prod = p.id; refreshSelectors(); invalidate(); }), btn('✕', function () { S.prods.splice(i, 1); saveSettings(); refreshSelectors(); invalidate(); renderTab(); })])])); });
  b.appendChild(sec('Product list', [list, btn('Restore defaults', function () { S.prods = JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)); saveSettings(); refreshSelectors(); renderTab(); invalidate(); })]));
}
var editCt = null;
function tabColor(b) {
  var def = prodDef(S.panels[0].prod) || prodDef('REF'); if (!editCt || !S.cts[editCt]) editCt = ctFor(def).id; var ct = S.cts[editCt];
  function changed() { ct.builtin = false; bumpCt(); saveSettings(); invalidate(); drawXS(); }
  var pal = h('input', { type: 'file', accept: '.pal,.txt', onchange: function () { ingestFiles(pal.files).then(renderTab); } });
  b.appendChild(sec('Colour table', [field('Editing', sel(Object.keys(S.cts).map(function (k) { return [k, S.cts[k].name]; }), editCt, function (v) { editCt = v; renderTab(); })),
    h('div', { class: 'cbar big', style: 'background:' + RWC.css(ct) }),
    h('div', { class: 'row' }, [btn('Use for “' + (def.label || def.name) + '”', function () { S.ctAssign[def.id] = ct.id; bumpCt(); saveSettings(); invalidate(); drawXS(); }, 'pri'), btn('Duplicate', function () { var c = JSON.parse(JSON.stringify(ct)); c.id = 'u' + Date.now().toString(36); c.name = ct.name + ' (copy)'; c.builtin = false; S.cts[c.id] = c; editCt = c.id; saveSettings(); renderTab(); })]),
    field('Name', h('input', { type: 'text', value: ct.name, onchange: function (e) { ct.name = e.target.value; changed(); } })),
    field('Blend', sel([['grad', 'Gradient between stops'], ['step', 'Solid steps']], ct.mode, function (v) { ct.mode = v; changed(); renderTab(); }))]));
  var rows = h('div', { class: 'stops' });
  ct.stops.forEach(function (s, i) { rows.appendChild(h('div', { class: 'stop' }, [num(s.v, function (v) { s.v = v; ct.stops.sort(function (a, c) { return a.v - c.v; }); changed(); renderTab(); }, { step: 'any' }), h('input', { type: 'color', value: s.c, oninput: function (e) { s.c = e.target.value; changed(); } }), ct.mode === 'grad' ? h('input', { type: 'color', value: s.c2 || (ct.stops[i + 1] || s).c, title: 'Colour at the end of this segment', oninput: function (e) { s.c2 = e.target.value; changed(); } }) : null, btn('✕', function () { if (ct.stops.length > 2) { ct.stops.splice(i, 1); changed(); renderTab(); } })])); });
  b.appendChild(sec('Stops (value → colour; values below the first stop are transparent)', [rows, h('div', { class: 'row' }, [btn('Add stop', function () { var n = ct.stops.length, a = ct.stops[n - 2], z = ct.stops[n - 1]; ct.stops.splice(n - 1, 0, { v: (a.v + z.v) / 2, c: a.c, c2: null }); changed(); renderTab(); }), btn('Export .pal', function () { download(ct.name.replace(/[^\w]+/g, '_') + '.pal', RWC.toPal(ct)); }), btn('Reset built-ins', function () { RWC.BUILTIN.forEach(function (c) { c.builtin = true; }); localStorage.removeItem('rw.settings.v1'); location.reload(); })]), field('Import GR-style .pal', pal),
    field('Layer opacity', h('input', { type: 'range', min: 60, max: 255, value: S.opacity, oninput: function (e) { S.opacity = +e.target.value; bumpCt(); invalidate(true); dirty.full = true; } }))]));
}
function tabQC(b) {
  var q = S.qc, qf = curFrame(S.panels[0].src); if (qf && S.sources[S.panels[0].src].kind === 'radar') ensureQC(qf); var st = (qf || {}).qcStats;
  b.appendChild(sec('Quality control', [field('Preset', sel([['off', 'Off (raw)'], ['light', 'Light: speckle + spikes'], ['standard', 'Standard'], ['aggressive', 'Aggressive'], ['custom', 'Custom']], q.preset, function (v) { if (RW.QC_PRESETS[v]) Object.assign(q, RW.QC_PRESETS[v]); q.preset = v; q.version++; saveSettings(); invalidate(); drawXS(); scheduleLLCC(); renderTab(); })),
    note('<b>For LLCC work, over-filtering is the unsafe direction.</b> Thin anvil and debris cloud near 0 dBZ has low signal and can fail the dual-pol tests. Check the “QC flags” product or “Reflectivity (raw)” in a second panel before trusting a clean picture.', 'warn')]));
  b.appendChild(sec('Filters', [
    field('Speckle: minimum valid neighbours (0 = off)', num(q.speckle, function (v) { q.speckle = v; qcChanged(); }, { min: 0, max: 8, step: 1 })),
    chk(q.spike, function (v) { q.spike = v; qcChanged(); }, 'Radial spike filter (sun strobes, RF interference)'),
    field('RhoHV minimum (0 = off)', num(q.rho, function (v) { q.rho = v; qcChanged(); }, { min: 0, max: 1, step: 0.05 }), 'Removes non-meteorological echo (birds, insects, chaff, clutter, sea clutter).'),
    field('Texture limit (0 = off; lower = stricter)', num(q.texture, function (v) { q.texture = v; qcChanged(); }, { min: 0, max: 20, step: 1 }), 'Gate-to-gate noisiness of Z and ZDR.'),
    field('Keep echo at or above (dBZ) regardless of dual-pol tests', num(q.rhoProtectZ, function (v) { q.rhoProtectZ = v; qcChanged(); }, { step: 1 })),
    chk(q.vert, function (v) { q.vert = v; qcChanged(); }, 'Vertical continuity (AP, ground and sea clutter on the lowest tilts)'),
    chk(q.trip2, function (v) { q.trip2 = v; qcChanged(); }, 'Second-trip / range-folded echo'),
    note('Second trip is flagged two ways: echo in a short-PRT Doppler cut that the long-range surveillance cut at the same elevation does not see, and echo whose velocity is incoherent (noise-like) gate to gate. The dashed purple ring on the map is the unambiguous range of the displayed sweep.'),
    field('Minimum reflectivity kept (dBZ, −99 = all)', num(q.minz, function (v) { q.minz = v; qcChanged(); }, { step: 1 }))]));
  b.appendChild(sec('Attenuation (C-band)', [chk(q.att, function (v) { q.att = v; qcChanged(); }, 'Correct reflectivity with ΦDP (linear method)'), field('α (dB per degree ΦDP)', num(q.attAlpha, function (v) { q.attAlpha = v; qcChanged(); }, { step: 0.01, min: 0, max: 0.3 }), '≈0.08 at C-band, ≈0.02 at S-band. View the “Est. attenuation (PIA)” product to see where the beam is attenuated; VAHIRR is not valid there.')]));
  b.appendChild(sec('Gridding', [field('Beam width (deg)', num(S.grid.bw, function (v) { S.grid.bw = v; qcChanged(); }, { step: 0.05, min: 0.3, max: 3 })), chk(S.grid.toGround, function (v) { S.grid.toGround = v; qcChanged(); }, 'Extend the lowest tilt down to the surface')]));
  if (st && st.total) { var parts = Object.keys(st.by).filter(function (k) { return st.by[k]; }).map(function (k) { return qcNames(RW.QC_BITS[k]) + ' ' + (100 * st.by[k] / st.total).toFixed(1) + '%'; }); b.appendChild(sec('This frame', [note((100 * st.removed / st.total).toFixed(1) + '% of ' + st.total.toLocaleString() + ' reflectivity gates removed' + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.')])); }
}
function tabTemp(b) {
  var P = S.prof, model = sel([['best_match', 'Best match'], ['gfs_seamless', 'GFS / HRRR'], ['ecmwf_ifs025', 'ECMWF IFS'], ['icon_seamless', 'ICON']], 'best_match', function () { });
  var tb = h('table', { class: 'tbl' }, [h('tr', {}, [h('th', { text: 'Level' }), h('th', { text: 'Height' })])]);
  [5, 0, -5, -10, -15, -20, -40].forEach(function (T) { tb.appendChild(h('tr', {}, [h('td', { text: (T > 0 ? '+' : '') + T + ' °C' }), h('td', { text: fmtH(RW.heightOf(P, T)) })])); });
  b.appendChild(sec('Temperature profile', [note((P.isDefault ? '<b>Placeholder profile in use.</b> Load a real one before judging anything temperature-dependent.<br>' : '') + 'Source: ' + P.source, P.isDefault ? 'warn' : ''), tb,
    h('div', { class: 'row' }, [model, btn('Fetch model profile', function () { profileFetch(model.value); }, 'pri')]), note('Pulled for the displayed radar time at the flight-path origin (or the radar site when no path is loaded), from Open-Meteo pressure-level data.')]));
  var ta = h('textarea', { rows: 7, placeholder: 'height, temperature (°C) per line\ne.g.\n0, 26\n15000, 0\n22000, -14\n(height in ft, m or km: detected automatically)' });
  b.appendChild(sec('Manual / sounding entry', [ta, btn('Use this profile', function () { try { S.prof = RW.parseProfileText(ta.value); S.profV++; invalidate(); drawXS(); scheduleLLCC(); renderTab(); } catch (e) { toast(e.message, 'err'); } })]));
  var tl = h('input', { type: 'text', value: S.tempLines.join(', '), onchange: function () { S.tempLines = tl.value.split(/[ ,]+/).map(Number).filter(isFinite); saveSettings(); drawXS(); } });
  b.appendChild(sec('Isotherms drawn on cross-sections and in 3-D', [field('Temperatures (°C)', tl)]));
}
function tabPath(b) {
  var fi = h('input', { type: 'file', accept: '.csv,.txt,.tsv,.traj', onchange: function () { ingestFiles(fi.files); } }), pad = sel(SITES.slice(0, 7).map(function (s, i) { return [i, s[0]]; }), 3, function () { }), az = h('input', { type: 'number', value: 90, min: 0, max: 360, style: 'width:70px' });
  b.appendChild(sec('Flight path', [field('Trajectory file', fi, 'Text/CSV with a header row naming time, latitude, longitude, altitude (and optionally speed). Units are read from the header (ft, kft, m, km). The file stays in this browser; nothing is uploaded.'),
    S.traj ? note('<b>' + (S.trajName || 'path') + '</b>: ' + S.traj.pts.length + ' points, to ' + fmtH(S.traj.pts[S.traj.pts.length - 1].z) + (S.traj.notes.length ? '<br>' + S.traj.notes.join('<br>') : '') + '<br>Evaluated up to ' + fmtH(S.llcc.zMax) + '.') : note('No flight path loaded.'),
    h('div', { class: 'row' }, [btn('Curtain along path', function () { S.xs.mode = 'traj'; $('xsmode').value = 'traj'; openXS(true); }), btn('Centre map', function () { if (S.trajP) { S.view.cx = S.trajP[0].x; S.view.cy = S.trajP[0].y; S.view.scale = 12; invalidate(); } }), btn('Clear', function () { S.traj = null; prepTraj(); invalidate(); drawXS(); renderTab(); })])]));
  b.appendChild(sec('Notional path (demo only)', [h('div', { class: 'row' }, [pad, h('span', { text: 'azimuth' }), az, btn('Generate', function () { var s = SITES[+pad.value]; S.traj = RW.notionalTrajectory(s[1], s[2], +az.value, 70); S.trajName = 'NOTIONAL ' + s[0] + ' az ' + az.value + '°'; prepTraj(); invalidate(); drawXS(); scheduleLLCC(); renderTab(); })]), note('A generic ascent shape for trying the tool. It does not represent any vehicle.')]));
  var so = h('input', { type: 'text', value: S.llcc.standoffs.join(', '), onchange: function () { S.llcc.standoffs = so.value.split(/[ ,]+/).map(Number).filter(function (v) { return v > 0; }); saveSettings(); invalidate(); drawXS(); scheduleLLCC(); } });
  b.appendChild(sec('Standoff rings', [field('Distances (nmi)', so, 'Drawn around the ground track on the map, as tubes in 3-D and as shading on the along-path curtain. Evaluation uses true slant distance.')]));
}
function tabLLCC(b) {
  var E = S.llccRes, L = S.llcc;
  b.appendChild(sec('Radar evidence along the flight path', [note('Radar evidence for the NASA-STD-4010 lightning rules that depend on cloud geometry. It is an aid for the Launch Weather Officer, <b>not a GO / NO-GO</b>: radar echo is not the visible cloud edge, cloud type must be judged by a person, and field-mill, lightning and time-since-lightning conditions are not evaluated here. Check every threshold against the current revision of the standard.', 'warn')]));
  if (!S.trajP) { b.appendChild(note('Load a flight path (Flight path tab) to evaluate.')); }
  else if (!E) b.appendChild(note('No radar frame for panel 1 at this time.'));
  else {
    var tb = h('table', { class: 'tbl llcc' }); llccRows(E).forEach(function (r) { tb.appendChild(h('tr', {}, [h('td', {}, [chip(r.st, r.st === 'ok' ? 'clear' : r.st === 'bad' ? 'inside' : 'check')]), h('td', {}, [h('b', { text: r.rule }), h('br'), r.item, h('div', { class: 'val', text: r.val })])])); });
    b.appendChild(tb);
    b.appendChild(note('Source: ' + S.sources[E.src].label + ' ' + fmtT(E.frame.time, true) + ' · grid ' + E.res + ' km (distances are to grid-cell centres, ±' + (E.res / 2 / NMI).toFixed(2) + ' nmi) · QC ' + S.qc.preset + ' · 0 °C at ' + fmtH(E.z0) + ' · ' + S.prof.source + (S.prof.isDefault ? ' <b>(placeholder!)</b>' : '') + ' · ' + E.ms.toFixed(0) + ' ms'));
    b.appendChild(h('div', { class: 'row' }, [btn('Export path table (CSV)', exportPathCSV), btn('Curtain along path', function () { S.xs.mode = 'traj'; $('xsmode').value = 'traj'; openXS(true); })]));
  }
  function n(label, key, attrs) { return field(label, num(L[key], function (v) { L[key] = v; saveSettings(); if (key === 'zMax') prepTraj(); scheduleLLCC(); }, attrs || { step: 'any' })); }
  b.appendChild(sec('Thresholds (editable)', [n('Radar cloud edge (dBZ)', 'cloudThr'), n('VAHIRR limit (dBZ-km)', 'vahirrLimit'), n('VAHIRR checked within (nmi of path)', 'vahirrWithin'), n('Moderate precipitation (dBZ)', 'modPrecip'), n('Thick layer depth (ft)', 'thickFt'), n('Tribo temperature (°C)', 'triboT'), n('Tribo speed limit (ft/s)', 'triboFps'), n('Evaluate path up to (km MSL)', 'zMax'),
    field('Cumulus classes (top °C : standoff nmi)', h('input', { type: 'text', value: L.cumulus.map(function (c) { return c.T + ':' + c.nmi; }).join(', '), onchange: function (e) { var a = e.target.value.split(/[ ,]+/).map(function (s) { var p = s.split(':').map(Number); return { T: p[0], nmi: p[1] }; }).filter(function (c) { return isFinite(c.T) && isFinite(c.nmi); }); if (a.length) { L.cumulus = a; saveSettings(); scheduleLLCC(); } } })),
    btn('Reset to defaults', function () { S.llcc = RW.defaultLLCC(); saveSettings(); prepTraj(); scheduleLLCC(); renderTab(); })]));
}
function tabSet(b) {
  var base = h('input', { type: 'text', value: RWIO.cfg.wsrBase, onchange: function () { RWIO.cfg.wsrBase = base.value.replace(/\/+$/, ''); saveSettings(); } }), prox = h('input', { type: 'text', value: RWIO.cfg.proxy, placeholder: 'https://your-relay.workers.dev/?url=', onchange: function () { RWIO.cfg.proxy = normRelay(prox.value) || RWIO.cfg.siteProxy; prox.value = RWIO.cfg.proxy; saveSettings(); } });
  b.appendChild(sec('Connections', [field('WSR API base address', base), field('Relay', prox, RWIO.cfg.siteProxy ? 'This site supplies a relay automatically (' + RWIO.cfg.siteProxy.replace(/\/\?url=$/, '') + '). Leave as is unless you want to use a different one.' : 'Needed when the browser is refused a direct connection to the WSR API. To set it once for everyone, put the address in docs/config.json in the repo.'), btn('Test WSR connection', async function () { try { var r = await RWIO.wsrLatest(); toast('WSR API reachable. Latest file: ' + (r ? fmtT(r.time, true) + ', ' + Math.round(r.size / 1024) + ' kB' : 'none listed')); } catch (e) { toast('WSR API: ' + corsHelp(e), 'err'); } })]));
  function regrid() { saveSettings(); S.qc.version++; invalidate(); drawXS(); scheduleLLCC(); }
  b.appendChild(sec('Analysis grid', [field('Preset', sel([['150|1|radar', 'Regional: 1 km, ±150 km about the radar'], ['75|0.5|path', 'Launch area: 0.5 km, ±75 km about the flight-path origin'], ['250|2|radar', 'Wide: 2 km, ±250 km about the radar']], [S.grid.half, S.grid.dx, S.grid.center].join('|'), function (v) { var p = v.split('|'); S.grid.half = +p[0]; S.grid.dx = +p[1]; S.grid.center = p[2]; regrid(); })), note('Vertical spacing is 250 m to 20 km. Each grid cell takes the highest gate that falls inside it, so the grid errs toward more echo. MRMS mosaics keep the grid they were fetched on.')]));
  b.appendChild(sec('Display', [field('Heights', sel([['kft', 'kft'], ['km', 'km']], S.units.h, function (v) { S.units.h = v; saveSettings(); invalidate(); drawXS(); renderTab(); })), field('Distances', sel([['nmi', 'nautical miles'], ['km', 'km']], S.units.d, function (v) { S.units.d = v; saveSettings(); invalidate(); drawXS(); })),
    chk(S.rings, function (v) { S.rings = v; saveSettings(); invalidate(); }, 'Range rings'), chk(S.showSites, function (v) { S.showSites = v; saveSettings(); invalidate(); }, 'Pads and airfields'), chk(S.showCounty, function (v) { S.showCounty = v; saveSettings(); invalidate(); }, 'County lines')]));
  b.appendChild(sec('Data handling', [field('Volume assembly window (min)', num(S.wsrWindow, function (v) { S.wsrWindow = v; saveSettings(); afterData(); }, { min: 1, max: 30 }), 'When a file holds only one or two tilts, a frame is built from the newest sweep at each elevation inside this window.'), field('Memory budget for radar files (MB)', num(S.memMB || 900, function (v) { S.memMB = v; saveSettings(); }, { min: 200, max: 6000, step: 100 }))]));
  b.appendChild(sec('About', [note('LLCC Radar Workbench · experimental. Keys: ←/→ step time, ↑/↓ change tilt, space play/pause, Shift-drag draws a cross-section. All processing happens in this browser.')]));
}

/* ---------- guidance: setup strip, welcome card, connection help, help dialog ---------- */
function connFail(e) { S.connErr = e.cors ? 'cors' : e.message; updateWelcome(); if (curTab === 'data') renderTab(); else toast('Could not load WSR data. See the Radar tab.', 'err'); }
function connBox() {
  var cors = S.connErr === 'cors', prox = h('input', { type: 'text', value: RWIO.cfg.proxy, placeholder: 'https://wsr-relay.YOURNAME.workers.dev/?url=' });
  return h('div', { class: 'connbox' }, [h('b', { text: cors ? 'The browser was not allowed to reach the WSR API.' : 'The WSR API returned an error.' }), h('p', { text: cors ? 'This is expected the first time on a new computer. Either paste your relay address below (one-time setup), or download a file and drop it on the page.' : S.connErr }),
    cors ? field('Relay address', prox) : null,
    h('div', { class: 'row' }, [cors ? btn('Save and retry', function () { var v = prox.value.trim(); if (v && !/[?&]url=$/.test(v)) v = v.replace(/\/+$/, '') + '/?url='; RWIO.cfg.proxy = v; saveSettings(); wsrLoadLatest(); }, 'pri') : btn('Retry', wsrLoadLatest, 'pri'), h('a', { class: 'btnlink', href: RWIO.cfg.wsrBase + '/wsr/latest/download', target: '_blank', rel: 'noopener', text: 'Download latest file' })]),
    cors ? h('small', { text: 'No relay yet? The repo has relay/worker.js and the README has the five-minute Cloudflare steps.' }) : null]);
}
function renderSetup() {
  var el = $('setup'); if (!el) return; el.innerHTML = '';
  function pill(kind, label, text, on) { el.appendChild(h('button', { class: 'pill ' + kind, onclick: on, title: 'Click to open' }, [h('i'), h('b', { text: label }), h('span', { text: text })])); }
  var pf = primarySrc().frames.length ? (curFrame(primarySrc().id) || primarySrc().frames[0]) : null;
  pill(pf ? 'ok' : S.connErr ? 'bad' : 'todo', 'Radar', pf ? (pf.site || 'loaded') + ' ' + fmtT(pf.time).slice(11) : S.connErr ? 'connection problem' : 'not loaded', function () { goTab('data'); });
  pill(S.prof.isDefault ? 'warn' : 'ok', 'Temps', S.prof.isDefault ? 'placeholder: click to fetch' : '0 °C at ' + fmtH(RW.heightOf(S.prof, 0)), function () { if (S.prof.isDefault) profileFetch('best_match'); goTab('temp'); });
  pill(S.traj ? 'ok' : 'todo', 'Flight path', S.traj ? (S.trajName || 'loaded') : 'none: click to add', function () { goTab('path'); });
  var E = S.llccRes, n = { bad: 0, warn: 0 }; if (E) llccRows(E).forEach(function (r) { if (n[r.st] != null) n[r.st]++; });
  pill(!E ? 'todo' : n.bad ? 'bad' : n.warn ? 'warn' : 'ok', 'LLCC', !E ? 'needs radar + flight path' : n.bad || n.warn ? (n.bad ? n.bad + ' inside' : '') + (n.bad && n.warn ? ', ' : '') + (n.warn ? n.warn + ' to check' : '') : 'clear by radar', function () { goTab('llcc'); });
}
function updateWelcome() {
  var w = $('welcome'), any = Object.keys(S.sources).some(function (k) { return S.sources[k].frames.length; }); w.classList.toggle('hidden', any); if (any) return; w.innerHTML = '';
  var fi = h('input', { type: 'file', multiple: '', style: 'display:none', onchange: function () { ingestFiles(fi.files); } });
  w.appendChild(h('div', { class: 'card' }, [h('h2', { text: 'Load radar to begin' }), h('p', { text: 'Pull the newest WSR volume, a recent loop, or open files you already have.' }),
    h('div', { class: 'row big' }, [btn('Load latest volume', wsrLoadLatest, 'pri'), btn('Load last 30 minutes', function () { wsrLoadRange(Date.now() - 30 * 60000, Date.now() + 60000); }), btn('Open files…', function () { fi.click(); }), fi]),
    h('p', { class: 'mut', text: 'You can also drop Level II files, a range .zip, a flight-path CSV or a .pal colour table anywhere on the page.' }),
    S.connErr ? connBox() : null,
    h('p', { class: 'mut' }, ['New here? ', h('a', { href: '#', text: 'Open the quick guide', onclick: function (e) { e.preventDefault(); showHelp(true); } }), '.'])]));
}
function showHelp(on) {
  var el = $('help'); el.classList.toggle('hidden', !on); if (!on || el.firstChild) return;
  var steps = [['1 · Radar', 'Load the latest WSR volume or a loop. Step through time with the slider or the arrow keys; change tilt with the up and down keys.'], ['2 · Temps', 'A model temperature profile is fetched automatically. Check the 0, −10 and −20 °C heights, or paste a sounding.'], ['3 · Flight path', 'Load a trajectory file (time, lat, lon, altitude) or generate a notional one. Standoff rings appear on the map.'], ['4 · LLCC', 'Read the radar evidence table. The first row tells you how high the scan actually reaches over the pad.']];
  var tools = [['Cross-sections', 'Click “Draw cross-section” and drag a line on the map, or hold Shift and drag at any time. Choose “Along flight path” in the section panel for a curtain.'], ['3-D', 'Isosurfaces, isotherm planes and standoff tubes around the current map centre. Drag to orbit, Shift-drag to pan, wheel to zoom.'], ['Compare', 'Choose 2 or 4 panels, then fetch KMLB or MRMS on the Radar tab and pick the source in each panel’s first dropdown.'], ['Products, Colours, QC', 'Build echo tops and CAPPIs at any threshold, edit or import colour tables, and adjust the filters. The setup strip at the top left always shows what is loaded.']];
  function dl(a) { return h('dl', {}, [].concat.apply([], a.map(function (x) { return [h('dt', { text: x[0] }), h('dd', { text: x[1] })]; }))); }
  el.appendChild(h('div', { class: 'card wide' }, [h('h2', { text: 'Quick guide' }), h('h3', { text: 'The four steps' }), dl(steps), h('h3', { text: 'Tools' }), dl(tools), h('p', { class: 'mut', text: 'Keys: ← → time · ↑ ↓ tilt · space play/pause · Esc close. This tool is experimental and shows radar evidence only; it does not make a GO / NO-GO call.' }), h('div', { class: 'row' }, [btn('Close', function () { showHelp(false); }, 'pri')])]));
  el.addEventListener('click', function (e) { if (e.target === el) showHelp(false); });
}
