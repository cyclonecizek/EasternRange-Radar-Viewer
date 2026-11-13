/* ===== app2.js : map panels, overlays, interaction, cross-section drawer ===== */
var panelsUI = [], baseXY = null, dirty = { full: true }, dragging = false, rafPending = false;
function buildBase() { function conv(lines) { return lines.map(function (l) { var a = new Float32Array(l.length); for (var i = 0; i < l.length; i += 2) { var xy = RW.ll2xy(l[i + 1], l[i], S.origin); a[i] = xy[0]; a[i + 1] = xy[1]; } return a; }); } baseXY = { key: S.origin.lat + ',' + S.origin.lon, coast: conv(RWMAP.coast), county: conv(RWMAP.county), sites: SITES.map(function (s) { var xy = RW.ll2xy(s[1], s[2], S.origin); return { n: s[0], x: xy[0], y: xy[1] }; }) }; }
function invalidate(fast) { if (!fast) dirty.full = true; if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; drawAll(dragging && !dirty.full ? 3 : 1); dirty.full = false; }); }
function opt(v, t, sel) { var o = h('option', { value: v, text: t }); if (sel) o.selected = true; return o; }

function buildPanels() {
  var host = $('maps'); host.innerHTML = ''; host.className = 'maps n' + S.npanels; panelsUI = [];
  while (S.panels.length < S.npanels) { var i = S.panels.length; S.panels.push({ src: i === 1 ? 'nex' : i === 2 ? 'mrms' : 'wsr', prod: i === 3 ? 'et0' : (i === 2 ? 'cref' : 'REF'), tilt: 0 }); }
  for (var p = 0; p < S.npanels; p++) (function (pi) {
    var P = S.panels[pi], ui = { pi: pi };
    ui.src = h('select', { title: 'Data source', onchange: function () { P.src = ui.src.value; fillProd(ui, P); invalidate(); drawXS(); scheduleLLCC(); } });
    ui.prod = h('select', { title: 'Product', onchange: function () { P.prod = ui.prod.value; fillTilt(ui, P); invalidate(); drawXS(); } });
    ui.tilt = h('select', { title: 'Elevation tilt (↑/↓ keys)', onchange: function () { P.tilt = +ui.tilt.value; invalidate(); } });
    ui.info = h('span', { class: 'pinfo' });
    ui.c1 = h('canvas', { class: 'raster' }); ui.c2 = h('canvas', { class: 'over' });
    ui.leg = h('div', { class: 'legend' }); ui.read = h('div', { class: 'readout' });
    ui.body = h('div', { class: 'pbody' }, [ui.c1, ui.c2, ui.read]);
    ui.el = h('div', { class: 'panel' }, [h('div', { class: 'phead' }, [ui.src, ui.prod, ui.tilt, ui.info]), ui.body, ui.leg]);
    host.appendChild(ui.el); panelsUI.push(ui); fillSrc(ui, P); bindMap(ui);
  })(p);
  invalidate();
}
function fillSrc(ui, P) { ui.src.innerHTML = ''; Object.keys(S.sources).forEach(function (k) { var s = S.sources[k]; ui.src.appendChild(opt(k, s.label + (s.frames.length ? '' : ' (no data)'), P.src === k)); }); fillProd(ui, P); }
function fillProd(ui, P) {
  ui.prod.innerHTML = ''; var radar = S.sources[P.src].kind === 'radar', g1 = h('optgroup', { label: 'Base moments (per tilt)' }), g2 = h('optgroup', { label: 'Derived / LLCC products' });
  if (radar) Object.keys(POLAR).forEach(function (k) { g1.appendChild(opt(k, POLAR[k].label, P.prod === k)); });
  S.prods.forEach(function (d) { g2.appendChild(opt(d.id, d.name, P.prod === d.id)); });
  if (radar) ui.prod.appendChild(g1); ui.prod.appendChild(g2);
  if (!prodDef(P.prod) || (!radar && POLAR[P.prod])) P.prod = radar ? 'REF' : 'cref'; ui.prod.value = P.prod; fillTilt(ui, P);
}
function fillTilt(ui, P) {
  var def = prodDef(P.prod), fr = curFrame(P.src); ui.tilt.innerHTML = '';
  if (!def || !def.polar || !fr || S.sources[P.src].kind !== 'radar') { ui.tilt.style.display = 'none'; return; }
  var tl = tiltsFor(fr, def); ui.tilt.style.display = ''; if (P.tilt >= tl.length) P.tilt = Math.max(0, tl.length - 1);
  tl.forEach(function (s, i) { ui.tilt.appendChild(opt(i, s.el.toFixed(1) + '°', i === P.tilt)); });
}
function refreshSelectors() { panelsUI.forEach(function (ui) { fillSrc(ui, S.panels[ui.pi]); }); }

function toPx(ui, x, y) { return [ui.W / 2 + (x - S.view.cx) * S.view.scale, ui.H / 2 - (y - S.view.cy) * S.view.scale]; }
function toKm(ui, px, py) { return [S.view.cx + (px - ui.W / 2) / S.view.scale, S.view.cy - (py - ui.H / 2) / S.view.scale]; }

function drawAll(step) {
  if (!baseXY || baseXY.key !== S.origin.lat + ',' + S.origin.lon) buildBase();
  panelsUI.forEach(function (ui) {
    var W = ui.body.clientWidth | 0, H = ui.body.clientHeight | 0; if (W < 10 || H < 10) return;
    if (ui.W !== W || ui.H !== H) { ui.W = W; ui.H = H; ui.c1.width = ui.c2.width = W; ui.c1.height = ui.c2.height = H; ui.img = ui.c1.getContext('2d').createImageData(W, H); ui.px = new Uint32Array(ui.img.data.buffer); }
    var t0 = performance.now(); ui.meta = renderRaster(ui.px, W, H, S.view, S.panels[ui.pi], step);
    ui.c1.getContext('2d').putImageData(ui.img, 0, 0); ui.ms = performance.now() - t0;
    drawOverlay(ui); drawLegend(ui);
  });
}
function drawOverlay(ui) {
  var c = ui.c2.getContext('2d'), W = ui.W, H = ui.H, sc = S.view.scale, i, p; c.clearRect(0, 0, W, H);
  function poly(a) { c.beginPath(); for (var k = 0; k < a.length; k += 2) { var x = W / 2 + (a[k] - S.view.cx) * sc, y = H / 2 - (a[k + 1] - S.view.cy) * sc; if (k) c.lineTo(x, y); else c.moveTo(x, y); } c.stroke(); }
  c.lineWidth = 1; if (S.showCounty) { c.strokeStyle = 'rgba(150,165,185,.28)'; baseXY.county.forEach(poly); }
  c.strokeStyle = 'rgba(225,235,245,.75)'; c.lineWidth = 1.2; baseXY.coast.forEach(poly);
  c.font = '11px system-ui,sans-serif'; c.textBaseline = 'middle';
  var pf = primarySrc().frames.length ? (curFrame(primarySrc().id) || primarySrc().frames[0]) : null;
  if (S.rings && pf && isFinite(pf.lat)) { var r = rxy(pf), o = toPx(ui, r[0], r[1]), unit = S.units.d === 'nmi' ? NMI : 1, stepR = S.units.d === 'nmi' ? 25 : 50; c.strokeStyle = 'rgba(160,180,200,.22)'; c.fillStyle = 'rgba(170,190,210,.6)'; for (i = 1; i <= 6; i++) { c.beginPath(); c.arc(o[0], o[1], i * stepR * unit * sc, 0, 7); c.stroke(); c.fillText(i * stepR + (S.units.d === 'nmi' ? ' nmi' : ' km'), o[0] + 4, o[1] - i * stepR * unit * sc + 8); } }
  Object.keys(S.sources).forEach(function (k) { var f = S.sources[k].kind === 'radar' && curFrame(k); if (!f) return; var q = toPx(ui, rxy(f)[0], rxy(f)[1]); c.fillStyle = '#ffd24a'; c.beginPath(); c.moveTo(q[0], q[1] - 6); c.lineTo(q[0] + 5, q[1] + 4); c.lineTo(q[0] - 5, q[1] + 4); c.fill(); c.fillText(f.site, q[0] + 8, q[1]); });
  if (ui.meta && ui.meta.sweep && ui.meta.sweep.urange > 0) { var rr = rxy(ui.meta.frame), oo = toPx(ui, rr[0], rr[1]); c.setLineDash([6, 6]); c.strokeStyle = 'rgba(190,120,255,.55)'; c.beginPath(); c.arc(oo[0], oo[1], ui.meta.sweep.urange * sc, 0, 7); c.stroke(); c.setLineDash([]); }
  if (S.showSites) baseXY.sites.forEach(function (s) { p = toPx(ui, s.x, s.y); if (p[0] < -20 || p[1] < -20 || p[0] > W + 20 || p[1] > H + 20) return; c.fillStyle = '#fff'; c.fillRect(p[0] - 2, p[1] - 2, 4, 4); if (sc > 5) { c.fillStyle = 'rgba(235,240,248,.9)'; c.fillText(s.n, p[0] + 5, p[1]); } });
  /* flight path + standoff corridors */
  if (S.trajP && S.trajP.length > 1) {
    var cols = ['rgba(255,90,90,.9)', 'rgba(255,190,70,.9)', 'rgba(255,240,120,.85)'];
    S.llcc.standoffs.slice().sort(function (a, b) { return b - a; }).forEach(function (nm, k) { if (!(nm > 0)) return; c.save(); c.beginPath(); S.trajP.forEach(function (q, j) { var a = toPx(ui, q.x, q.y); if (j) c.lineTo(a[0], a[1]); else c.moveTo(a[0], a[1]); }); var w = 2 * nm * NMI * sc; c.lineCap = c.lineJoin = 'round'; c.globalAlpha = 0.07; c.strokeStyle = '#fff'; c.lineWidth = w; c.stroke(); c.restore(); outline(c, ui, nm * NMI * sc, cols[(S.llcc.standoffs.length - 1 - k) % 3], nm + ' nmi'); });
    c.strokeStyle = '#3df0ff'; c.lineWidth = 2; c.beginPath(); S.trajP.forEach(function (q, j) { var a = toPx(ui, q.x, q.y); if (j) c.lineTo(a[0], a[1]); else c.moveTo(a[0], a[1]); }); c.stroke();
    var nextTick = 10 * KFT; c.fillStyle = '#3df0ff'; S.trajP.forEach(function (q) { if (q.z >= nextTick) { var a = toPx(ui, q.x, q.y); c.beginPath(); c.arc(a[0], a[1], 2.5, 0, 7); c.fill(); if (sc > 6) c.fillText(Math.round(nextTick / KFT) + 'k', a[0] + 5, a[1] - 7); nextTick += 10 * KFT; } });
    var E = S.llccRes; if (E && E.any.at && isFinite(E.any.d)) { var tp = S.trajP[E.any.at.pt], a1 = toPx(ui, tp.x, tp.y), a2 = toPx(ui, E.any.at.x, E.any.at.y); c.strokeStyle = '#ff5fd0'; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(a1[0], a1[1]); c.lineTo(a2[0], a2[1]); c.stroke(); c.setLineDash([]); c.fillStyle = '#ff5fd0'; c.beginPath(); c.arc(a2[0], a2[1], 4, 0, 7); c.fill(); c.fillText('nearest radar cloud ' + fmtD(E.any.d), a2[0] + 7, a2[1] + 10); }
  }
  /* cross-section line */
  if (S.xs.mode === 'line' && S.xs.a && S.xs.b) { var A = toPx(ui, S.xs.a[0], S.xs.a[1]), B = toPx(ui, S.xs.b[0], S.xs.b[1]); c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(B[0], B[1]); c.stroke(); c.fillStyle = '#fff'; c.font = 'bold 12px system-ui'; c.fillText('A', A[0] - 12, A[1]); c.fillText('B', B[0] + 5, B[1]); [A, B].forEach(function (q) { c.beginPath(); c.arc(q[0], q[1], 4, 0, 7); c.fill(); }); }
  if (S.cursor) { p = toPx(ui, S.cursor.x, S.cursor.y); c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 1; c.beginPath(); c.moveTo(p[0] - 9, p[1]); c.lineTo(p[0] + 9, p[1]); c.moveTo(p[0], p[1] - 9); c.lineTo(p[0], p[1] + 9); c.stroke(); }
}
var olCan = null;
function outline(c, ui, rpx, color, label) { // outline of the buffer around the ground track
  if (!olCan) olCan = document.createElement('canvas'); if (olCan.width !== ui.W || olCan.height !== ui.H) { olCan.width = ui.W; olCan.height = ui.H; }
  var o = olCan.getContext('2d'); o.clearRect(0, 0, ui.W, ui.H); o.lineCap = o.lineJoin = 'round'; o.beginPath(); var first = null;
  S.trajP.forEach(function (q, j) { var a = toPx(ui, q.x, q.y); if (!j) first = a; if (j) o.lineTo(a[0], a[1]); else o.moveTo(a[0], a[1]); });
  o.globalCompositeOperation = 'source-over'; o.strokeStyle = color; o.lineWidth = 2 * rpx + 2.4; o.stroke(); o.globalCompositeOperation = 'destination-out'; o.lineWidth = Math.max(0.1, 2 * rpx - 0.6); o.strokeStyle = '#000'; o.stroke(); o.globalCompositeOperation = 'source-over';
  c.drawImage(olCan, 0, 0); c.fillStyle = color; c.fillText(label, first[0] + 4, first[1] + rpx + 9);
}
function drawLegend(ui) {
  var m = ui.meta, P = S.panels[ui.pi]; ui.leg.innerHTML = '';
  if (!m || !m.frame) { ui.info.textContent = 'no data near ' + (S.time ? fmtT(S.time) : 'the selected time'); return; }
  if (m.none) { ui.info.textContent = 'product not available in this frame'; return; }
  var f = m.frame, bits = [f.site || S.sources[P.src].label, fmtT(m.sweep ? m.sweep.t0 : f.time, true)];
  if (m.sweep) bits.push(m.sweep.el.toFixed(2) + '°'); if (f.vcp) bits.push('VCP ' + f.vcp); if (f.partial) bits.push('assembled from ' + f.sweeps.length + ' sweeps'); if (m.sub) bits.push(m.sub);
  var dt = Math.round((f.time - S.time) / 1000); if (Math.abs(dt) > 45) bits.push('Δt ' + (dt > 0 ? '+' : '') + Math.round(dt / 60) + ' min');
  ui.info.textContent = bits.join(' · ');
  var ct = m.ct, s = ct.stops, bar = h('div', { class: 'cbar', style: 'background:' + RWC.css(ct) }), ticks = h('div', { class: 'cticks' }), min = s[0].v, max = s[s.length - 1].v, n = s.length, every = Math.ceil(n / 9);
  s.forEach(function (st, i) { if (i % every && i !== n - 1) return; ticks.appendChild(h('span', { style: 'left:' + ((st.v - min) / (max - min) * 100) + '%', text: String(st.v) })); });
  ui.leg.appendChild(h('span', { class: 'cname', text: ct.units || '' })); ui.leg.appendChild(h('div', { class: 'cwrap' }, [bar, ticks]));
}
function updateReadout(ui, X, Y) {
  var txt = [], ll = RW.xy2ll(X, Y, S.origin); txt.push(ll[0].toFixed(4) + ', ' + ll[1].toFixed(4));
  panelsUI.forEach(function (u) { var pr = probe(S.panels[u.pi], X, Y), t; if (!pr) { u.read.textContent = ''; return; } t = fmtVal(pr.def, pr.v); if (pr.beamH != null) t += '  ·  beam ' + fmtH(pr.beamH) + ' (' + RW.tempAt(S.prof, pr.beamH).toFixed(0) + ' °C)  ·  ' + pr.az.toFixed(0) + '° / ' + fmtD(pr.range); u.read.textContent = t; });
  if (S.trajP && S.trajP.length) { var bd = 1e9; S.trajP.forEach(function (q) { var d = Math.hypot(q.x - X, q.y - Y); if (d < bd) bd = d; }); txt.push('ground track ' + fmtD(bd)); }
  status(txt.join('   ·   '));
}
function bindMap(ui) {
  var el = ui.c2, down = null, moved = false;
  function pos(e) { var r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  el.addEventListener('mousedown', function (e) { var p = pos(e); down = { p: p, cx: S.view.cx, cy: S.view.cy, xs: S.tool === 'xs' || e.shiftKey }; moved = false; if (down.xs) { S.xs.mode = 'line'; S.xs.a = toKm(ui, p[0], p[1]); S.xs.b = null; } e.preventDefault(); });
  window.addEventListener('mousemove', function (e) {
    var p = pos(e), inside = p[0] >= 0 && p[1] >= 0 && p[0] <= ui.W && p[1] <= ui.H;
    if (down) { moved = true; if (down.xs) { S.xs.b = toKm(ui, p[0], p[1]); invalidate(true); panelsUI.forEach(drawOverlay); } else { dragging = true; S.view.cx = down.cx - (p[0] - down.p[0]) / S.view.scale; S.view.cy = down.cy + (p[1] - down.p[1]) / S.view.scale; invalidate(true); } }
    else if (inside && e.target === el) { var k = toKm(ui, p[0], p[1]); S.cursor = { x: k[0], y: k[1] }; updateReadout(ui, k[0], k[1]); panelsUI.forEach(function (u) { if (u !== ui) drawOverlay(u); }); }
  });
  window.addEventListener('mouseup', function () { if (!down) return; var wasXs = down.xs; down = null; if (dragging) { dragging = false; invalidate(); } if (wasXs && S.xs.a && S.xs.b && moved) { openXS(true); if ($('xsmode')) $('xsmode').value = 'line'; drawXS(); setTool('pan'); } });
  el.addEventListener('wheel', function (e) { e.preventDefault(); var p = pos(e), k = toKm(ui, p[0], p[1]), f = Math.exp(-e.deltaY * 0.0015); S.view.scale = Math.max(0.6, Math.min(120, S.view.scale * f)); S.view.cx = k[0] - (p[0] - ui.W / 2) / S.view.scale; S.view.cy = k[1] + (p[1] - ui.H / 2) / S.view.scale; invalidate(); }, { passive: false });
  el.addEventListener('mouseleave', function () { S.cursor = null; panelsUI.forEach(drawOverlay); });
}
function setTool(t) { S.tool = t; $('toolxs').classList.toggle('on', t === 'xs'); document.body.classList.toggle('xs-tool', t === 'xs'); }

/* ---------- cross-section drawer ---------- */
var xsUI = [];
function openXS(o) { S.xs.open = o; $('xsec').classList.toggle('hidden', !o); invalidate(); if (o) drawXS(); setTimeout(invalidate, 30); }
function drawXS() {
  if (!S.xs.open) return; var host = $('xsbody'); var path = xsPath();
  var show = S.panels.slice(0, Math.min(2, S.npanels)), eff = function (P) { var d = prodDef(P.prod); return P.src + '|' + (S.sources[P.src].kind === 'radar' && d && d.polar && !d.special ? P.prod : 'REF'); }; if (show.length === 2 && eff(show[0]) === eff(show[1])) show = [show[0]];
  if (xsUI.length !== show.length) { host.innerHTML = ''; xsUI = show.map(function () { var c = h('canvas'), o = { c: c }; host.appendChild(c); bindXS(o); return o; }); }
  if (!path) { xsUI.forEach(function (o) { var c = o.c.getContext('2d'); o.c.width = o.c.clientWidth; o.c.height = o.c.clientHeight; c.fillStyle = '#8fa3b8'; c.font = '13px system-ui'; c.fillText(S.xs.mode === 'traj' ? 'Load a flight path to see the along-track curtain.' : 'Click “Cross-section”, then drag a line on the map (or Shift-drag at any time).', 16, 30); }); return; }
  xsUI.forEach(function (o, i) {
    var W = o.c.clientWidth | 0, H = o.c.clientHeight | 0; if (W < 50 || H < 40) return; o.c.width = W; o.c.height = H;
    var ml = 48, mr = 46, mb = 20, mt = 16, pw = W - ml - mr, ph = H - mt - mb, c = o.c.getContext('2d'), img = c.createImageData(pw, ph), px = new Uint32Array(img.data.buffer);
    var meta = renderXS(px, pw, ph, show[i], path); o.geom = { ml: ml, mt: mt, pw: pw, ph: ph, path: path, panel: show[i] };
    c.fillStyle = '#0a0e13'; c.fillRect(0, 0, W, H); c.putImageData(img, ml, mt);
    var top = S.xs.top, d0 = path[0].d, d1 = path[path.length - 1].d, X = function (d) { return ml + (d - d0) / (d1 - d0) * pw; }, Y = function (z) { return mt + ph - z / top * ph; };
    c.font = '11px system-ui'; c.textBaseline = 'middle'; c.lineWidth = 1;
    var hu = S.units.h === 'kft' ? KFT : 1, hs = S.units.h === 'kft' ? 10 : 2; c.strokeStyle = 'rgba(255,255,255,.08)'; c.fillStyle = '#9db0c4'; c.textAlign = 'right';
    for (var z = 0; z * hu <= top; z += hs) { c.beginPath(); c.moveTo(ml, Y(z * hu)); c.lineTo(ml + pw, Y(z * hu)); c.stroke(); c.fillText(z + (S.units.h === 'kft' ? 'k' : ''), ml - 5, Y(z * hu)); }
    var du = S.units.d === 'nmi' ? NMI : 1, span = (d1 - d0) / du, ds = span > 150 ? 25 : span > 60 ? 10 : span > 25 ? 5 : span > 10 ? 2 : 1; c.textAlign = 'center';
    for (var d = Math.ceil(d0 / du / ds) * ds; d * du <= d1; d += ds) { c.beginPath(); c.moveTo(X(d * du), mt); c.lineTo(X(d * du), mt + ph); c.stroke(); c.fillText(String(d), X(d * du), mt + ph + 10); }
    c.textAlign = 'left'; S.tempLines.forEach(function (T) { var zt = RW.heightOf(S.prof, T); if (!(zt < top)) return; c.strokeStyle = T === 0 ? 'rgba(255,120,120,.95)' : 'rgba(120,200,255,.85)'; c.setLineDash(T === 0 ? [] : [5, 4]); c.beginPath(); c.moveTo(ml, Y(zt)); c.lineTo(ml + pw, Y(zt)); c.stroke(); c.setLineDash([]); c.fillStyle = T === 0 ? '#ff8a8a' : '#8fd0ff'; c.fillText((T > 0 ? '+' : '') + T + '°C', ml + pw + 4, Y(zt)); });
    if (S.trajP && S.trajP.length > 1) {
      var pts = [];
      if (S.xs.mode === 'traj') S.trajP.forEach(function (q) { pts.push([q.g, q.z]); });
      else { var A = S.xs.a, B = S.xs.b, L = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L; S.trajP.forEach(function (q) { var al = (q.x - A[0]) * ux + (q.y - A[1]) * uy, lat = Math.abs((q.x - A[0]) * uy - (q.y - A[1]) * ux); pts.push(lat < 5 * NMI && al >= 0 && al <= L ? [al, q.z] : null); }); }
      c.save(); c.beginPath(); c.rect(ml, mt, pw, ph); c.clip();
      if (S.xs.mode === 'traj') { c.save(); c.translate(X(0), Y(0)); c.scale(pw / (d1 - d0), -ph / top); c.lineCap = c.lineJoin = 'round'; S.llcc.standoffs.slice().sort(function (a, b) { return b - a; }).forEach(function (nm) { c.beginPath(); pts.forEach(function (q, j) { if (j) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); }); c.lineWidth = 2 * nm * NMI; c.strokeStyle = 'rgba(255,255,255,.07)'; c.stroke(); }); c.restore(); }
      c.strokeStyle = '#3df0ff'; c.lineWidth = 2; c.beginPath(); var pen = false; pts.forEach(function (q) { if (!q) { pen = false; return; } if (pen) c.lineTo(X(q[0]), Y(q[1])); else c.moveTo(X(q[0]), Y(q[1])); pen = true; }); c.stroke(); c.restore();
    }
    c.fillStyle = '#dfe8f2'; c.textAlign = 'left'; var fr = meta && meta.frame;
    c.fillText((fr ? (fr.site || S.sources[show[i].src].label) + ' · ' + (meta.def.label || meta.def.name) + ' · ' + fmtT(fr.time, true) : S.sources[show[i].src].label + ': no data') + (S.xs.mode === 'traj' ? ' · along flight path (shaded = in-plane ' + S.llcc.standoffs.join('/') + ' nmi)' : ' · A → B') + ' · ' + (S.xs.interp ? 'interpolated' : 'beams only'), ml + 6, mt + 9);
    c.fillStyle = '#9db0c4'; c.textAlign = 'right'; c.fillText(S.units.d, W - 4, mt + ph + 10);
    if (o.hover) { c.strokeStyle = 'rgba(255,255,255,.6)'; c.beginPath(); c.moveTo(o.hover[0], mt); c.lineTo(o.hover[0], mt + ph); c.moveTo(ml, o.hover[1]); c.lineTo(ml + pw, o.hover[1]); c.stroke(); }
  });
}
function bindXS(o) {
  o.c.addEventListener('mousemove', function (e) {
    var g = o.geom; if (!g) return; var r = o.c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; if (x < g.ml || x > g.ml + g.pw || y < g.mt || y > g.mt + g.ph) return;
    var f = (x - g.ml) / g.pw * (g.path.length - 1), k = Math.min(g.path.length - 2, f | 0), t = f - k, X = g.path[k].x + t * (g.path[k + 1].x - g.path[k].x), Y = g.path[k].y + t * (g.path[k + 1].y - g.path[k].y), z = (1 - (y - g.mt) / g.ph) * S.xs.top, d = g.path[k].d + t * (g.path[k + 1].d - g.path[k].d);
    S.cursor = { x: X, y: Y }; panelsUI.forEach(drawOverlay); xsUI.forEach(function (u) { u.hover = [x, y]; });
    var src = g.panel.src, fr = curFrame(src), G = fr && (S.sources[src].kind === 'grid' ? fr.grid : fr._grid), gv = G ? RW.gridVal(G, X, Y, z) : NaN;
    status('distance ' + fmtD(d) + '   ·   height ' + fmtH(z) + '   ·   ' + RW.tempAt(S.prof, z).toFixed(1) + ' °C' + (isFinite(gv) ? '   ·   gridded Z ' + gv.toFixed(1) + ' dBZ' : '')); drawXS();
  });
  o.c.addEventListener('mouseleave', function () { xsUI.forEach(function (u) { u.hover = null; }); drawXS(); });
}
