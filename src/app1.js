/* ===== app1.js : state, catalog, caches, raster + cross-section renderers ===== */
'use strict';
var NMI = RW.NMI, KFT = RW.KFT, D2R = Math.PI / 180;
var SITES = [['LC-39A', 28.6083, -80.6041], ['LC-39B', 28.6272, -80.6208], ['SLC-41', 28.5834, -80.5829], ['SLC-40', 28.5620, -80.5772], ['SLC-37', 28.5317, -80.5650], ['LC-36', 28.4716, -80.5378], ['SLC-46', 28.4585, -80.5284], ['LZ-1', 28.4858, -80.5444], ['SLF', 28.6150, -80.6945], ['XMR', 28.4676, -80.5666], ['COF', 28.2349, -80.6101]];
var POLAR = {
  REF: { label: 'Base reflectivity (QC applied)', mom: 'REF', ct: 'ref_llcc', units: 'dBZ' }, REFRAW: { label: 'Base reflectivity (raw, no QC)', mom: 'REF', ct: 'ref_llcc', units: 'dBZ', raw: true },
  VEL: { label: 'Radial velocity', mom: 'VEL', ct: 'vel', units: 'm/s' }, SW: { label: 'Spectrum width', mom: 'SW', ct: 'sw', units: 'm/s' },
  ZDR: { label: 'Differential reflectivity', mom: 'ZDR', ct: 'zdr', units: 'dB' }, RHO: { label: 'Correlation coefficient', mom: 'RHO', ct: 'rho', units: '' },
  PHI: { label: 'Differential phase', mom: 'PHI', ct: 'phi', units: 'deg' }, PIA: { label: 'Est. attenuation (PIA)', mom: 'REF', ct: 'pia', units: 'dB', special: 'pia' },
  QCF: { label: 'QC flags (what was removed)', mom: 'REF', ct: 'qcf', units: '', special: 'qcf' }
};
var DEFAULT_PRODUCTS = [
  { id: 'cref', name: 'Composite reflectivity', type: 'cref' }, { id: 'et0', name: 'Echo top 0 dBZ (radar cloud top)', type: 'etop', thr: 0 }, { id: 'et18', name: 'Echo top 18 dBZ', type: 'etop', thr: 18 }, { id: 'et30', name: 'Echo top 30 dBZ', type: 'etop', thr: 30 },
  { id: 'ettemp0', name: 'Cloud-top temperature (0 dBZ top)', type: 'ettemp', thr: 0 }, { id: 'c0', name: 'Reflectivity at 0 °C', type: 'cappi', lev: { T: 0 } }, { id: 'c10', name: 'Reflectivity at −10 °C', type: 'cappi', lev: { T: -10 } }, { id: 'c20', name: 'Reflectivity at −20 °C', type: 'cappi', lev: { T: -20 } },
  { id: 'mx0', name: 'Max reflectivity colder than 0 °C', type: 'lmax', lev: { T: 0 } }, { id: 'mx0_20', name: 'Max reflectivity 0 to −20 °C', type: 'lmax', lev: { T: 0 }, lev2: { T: -20 } },
  { id: 'thk0', name: 'Cloud thickness ≥0 dBZ colder than 0 °C', type: 'thick', thr: 0, lev: { T: 0 } }, { id: 'vahirr', name: 'VAHIRR', type: 'vahirr' }, { id: 'vil', name: 'VIL', type: 'vil' }
];
var S = {
  origin: { lat: 28.45, lon: -80.6 }, originSet: false, view: { cx: 0, cy: 10, scale: 4 },
  sources: { wsr: { id: 'wsr', label: 'WSR', kind: 'radar', files: [], frames: [] }, nex: { id: 'nex', label: 'KMLB', kind: 'radar', files: [], frames: [] }, mrms: { id: 'mrms', label: 'MRMS', kind: 'grid', files: [], frames: [] } },
  time: 0, panels: [{ src: 'wsr', prod: 'REF', tilt: 0 }], npanels: 1,
  xs: { a: null, b: null, mode: 'line', top: 18, interp: true, open: false },
  prof: RW.defaultProfile(), profV: 1, traj: null, trajName: '', trajP: null, trajV: 0,
  qc: RW.defaultQC(), llcc: RW.defaultLLCC(), llccRes: null,
  units: { h: 'kft', d: 'nmi' }, cts: {}, ctAssign: {}, prods: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
  grid: { half: 150, dx: 1, center: 'radar', bw: 1.0, toGround: false }, tempLines: [0, -5, -10, -20], rings: true, showSites: true, showCounty: true,
  nexSite: 'KMLB', maxFrames: 40, tool: 'pan', cursor: null, connErr: null, profTried: false, live: false, wsrWindow: 8, opacity: 255, memMB: 900
};
RWC.BUILTIN.forEach(function (c) { S.cts[c.id] = c; });

/* ---------- small helpers ---------- */
function $(id) { return document.getElementById(id); }
function h(tag, attrs, kids) { var e = document.createElement(tag); if (attrs) for (var k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] != null) e.setAttribute(k, attrs[k]); } (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
function fmtH(km, d) { return isFinite(km) ? (S.units.h === 'kft' ? (km / KFT).toFixed(d == null ? 1 : d) + ' kft' : km.toFixed(d == null ? 2 : d) + ' km') : '—'; }
function fmtD(km, d) { return isFinite(km) ? (S.units.d === 'nmi' ? (km / NMI).toFixed(d == null ? 1 : d) + ' nmi' : km.toFixed(d == null ? 1 : d) + ' km') : '—'; }
function fmtT(ms, secs) { if (!ms) return '—'; var s = new Date(ms).toISOString(); return s.slice(0, 10) + ' ' + s.slice(11, secs ? 19 : 16) + 'Z'; }
function toast(msg, kind) { var t = h('div', { class: 'toast ' + (kind || ''), text: msg }); $('toasts').appendChild(t); setTimeout(function () { t.remove(); }, kind === 'err' ? 12000 : 5000); }
function status(msg) { $('status').textContent = msg || ''; }
var SAVE_KEYS = ['units', 'qc', 'llcc', 'prods', 'ctAssign', 'grid', 'tempLines', 'nexSite', 'maxFrames', 'rings', 'showSites', 'showCounty', 'wsrWindow', 'memMB'];
function saveSettings() { try { var o = { io: { wsrBase: RWIO.cfg.wsrBase, proxy: RWIO.cfg.proxy === RWIO.cfg.siteProxy ? '' : RWIO.cfg.proxy }, userCts: Object.keys(S.cts).filter(function (k) { return !S.cts[k].builtin; }).map(function (k) { return S.cts[k]; }) }; SAVE_KEYS.forEach(function (k) { o[k] = S[k]; }); localStorage.setItem('rw.settings.v1', JSON.stringify(o)); } catch (e) { } }
function loadSettings() { try { var o = JSON.parse(localStorage.getItem('rw.settings.v1') || 'null'); if (!o) return; SAVE_KEYS.forEach(function (k) { if (o[k] != null) S[k] = (typeof S[k] === 'object' && !Array.isArray(S[k])) ? Object.assign(S[k], o[k]) : o[k]; }); if (o.io) { RWIO.cfg.wsrBase = o.io.wsrBase || RWIO.cfg.wsrBase; RWIO.cfg.proxy = o.io.proxy || ''; } (o.userCts || []).forEach(function (c) { S.cts[c.id] = c; }); S.qc.version = 1; } catch (e) { } }

/* ---------- catalog ---------- */
function prodDef(id) { if (POLAR[id]) return Object.assign({ id: id, polar: true }, POLAR[id]); for (var i = 0; i < S.prods.length; i++) if (S.prods[i].id === id) return S.prods[i]; return null; }
function prodUnits(def) { return def.polar ? def.units : RW.PRODUCT_TYPES[def.type].units; }
function ctFor(def) { var id = S.ctAssign[def.id]; if (!id || !S.cts[id]) { if (def.polar) id = def.ct; else { var u = prodUnits(def); id = def.type === 'vahirr' ? 'vahirr' : def.type === 'vil' ? 'vil' : def.type === 'thick' ? 'thick' : u === 'ht' ? 'height' : u === 'degC' ? 'temp' : 'ref_llcc'; } } return S.cts[id] || S.cts.ref_llcc; }
var ctVer = 1, lutCache = {};
function bumpCt() { ctVer++; lutCache = {}; }
function rawLUT(ct, m) { var size = m.raw instanceof Uint8Array ? 256 : 65536, k = ct.id + '|' + m.scale + '|' + m.offset + '|' + size + '|' + S.opacity; return lutCache[k] || (lutCache[k] = RWC.rawLUT(ct, m.scale, m.offset, size, S.opacity)); }
function valLUT(ct) { var k = 'v|' + ct.id + '|' + S.opacity; return lutCache[k] || (lutCache[k] = RWC.valueLUT(ct, S.opacity)); }
function dispVal(def, v) { var u = def.polar ? def.units : prodUnits(def); return u === 'ht' ? v / KFT : v; } // value used for colouring (heights coloured in kft)
function fmtVal(def, v) { if (v === -Infinity) return 'RF'; if (!isFinite(v)) return '—'; var u = def.polar ? def.units : prodUnits(def); if (u === 'ht') return fmtH(v); if (def.special === 'qcf') return qcNames(v); return v.toFixed(u === '' || u === 'dB' ? 2 : 1) + (u ? ' ' + u.replace('degC', '°C') : ''); }
function qcNames(f) { var o = []; for (var k in RW.QC_BITS) if (f & RW.QC_BITS[k]) o.push({ rho: 'low RhoHV', texture: 'texture', speckle: 'speckle', spike: 'spike', vert: 'no vertical continuity', trip2: 'second trip', minz: 'below min dBZ' }[k]); return o.join(' + ') || '—'; }

/* ---------- sources / frames ---------- */
function primarySrc() { return S.sources.wsr.frames.length ? S.sources.wsr : S.sources.nex.frames.length ? S.sources.nex : S.sources.mrms; }
function frameAt(src, t, tolMin) { var fr = S.sources[src].frames, best = null, bd = (tolMin || 12) * 60000; for (var i = 0; i < fr.length; i++) { var d = Math.abs(fr[i].time - t); if (d <= bd) { bd = d; best = fr[i]; } } return best; }
function curFrame(src) { return frameAt(src, S.time); }
function setOriginFrom(frame) { if (S.originSet || !isFinite(frame.lat)) return; S.origin = { lat: frame.lat, lon: frame.lon }; S.originSet = true; var pad = RW.ll2xy(SITES[3][1], SITES[3][2], S.origin); S.view.cx = pad[0] / 2; S.view.cy = pad[1] / 2; Object.keys(S.sources).forEach(function (k) { S.sources[k].frames.forEach(function (f) { f.rxy = null; f._grid = null; }); }); if (S.traj) prepTraj(); }
function rxy(frame) { return frame.rxy || (frame.rxy = RW.ll2xy(frame.lat, frame.lon, S.origin)); }
function rebuildFrames(srcId) {
  var src = S.sources[srcId]; if (src.kind !== 'radar') return;
  if (src.files.length > S.maxFrames) src.files = src.files.sort(function (a, b) { return a.time - b.time; }).slice(-S.maxFrames);
  var old = {}; src.frames.forEach(function (f) { old[f.key] = f; });
  src.frames = RW.assembleFrames(src.files, S.wsrWindow).map(function (f) { var o = old[f.key]; return (o && o.sweeps.length === f.sweeps.length) ? o : f; });
  if (src.frames.length) setOriginFrom(src.frames[src.frames.length - 1]);
}
function gridSpecNow() { var c = [0, 0]; if (S.grid.center === 'path' && S.trajP && S.trajP.length) c = [Math.round(S.trajP[0].x), Math.round(S.trajP[0].y)]; return RW.gridSpec({ half: S.grid.half, dx: S.grid.dx, cx: c[0], cy: c[1] }); }
function gridKey() { var g = S.grid, c = g.center === 'path' && S.trajP ? S.trajP[0].x.toFixed(0) + ',' + S.trajP[0].y.toFixed(0) : 'r'; return [g.half, g.dx, c, g.bw, g.toGround, S.qc.version].join('|'); }
var gridLRU = [];
function ensureQC(frame) { if (frame.qcv !== S.qc.version) RW.runQC(frame, S.qc); }
/** Cartesian reflectivity grid for a frame of any source (cached) */
function gridOf(srcId, frame) {
  if (!frame) return null;
  if (S.sources[srcId].kind === 'grid') return frame.grid;
  var key = gridKey(); if (frame._grid && frame._gridKey === key) return frame._grid;
  ensureQC(frame);
  frame._grid = RW.gridRadar(frame, gridSpecNow(), rxy(frame), { bw: S.grid.bw, toGround: S.grid.toGround }); frame._gridKey = key; frame._fields = {};
  gridLRU = gridLRU.filter(function (f) { return f !== frame; }); gridLRU.push(frame); while (gridLRU.length > 14) { var o = gridLRU.shift(); o._grid = null; o._fields = {}; }
  return frame._grid;
}
function fieldOf(srcId, frame, def) {
  var G = gridOf(srcId, frame); if (!G) return null;
  if (!frame._fields || frame._fieldsGrid !== G) { frame._fields = {}; frame._fieldsGrid = G; }
  var key = JSON.stringify([def.type, def.thr, def.lev, def.lev2, S.profV]);
  return frame._fields[key] || (frame._fields[key] = { G: G, data: RW.product(G, def, S.prof) });
}
function prepTraj() { S.trajP = S.traj ? RW.prepTrajectory(S.traj, S.origin, 0.25, S.llcc.zMax) : null; S.trajV++; S.llccRes = null; }
/** top (and bottom) of the scanned volume above a map point, km MSL, for a radar frame */
function covTop(frame, x, y) { var tl = RW.refTilts(frame); if (!tl.length) return null; var r = rxy(frame), s = Math.hypot(x - r[0], y - r[1]), hb = s * S.grid.bw * D2R / 2, h0 = (frame.alt || 0) / 1000; return { top: RW.beamAt(s, tl[tl.length - 1].el, h0).h + hb, bot: Math.max(0, RW.beamAt(s, tl[0].el, h0).h - hb), el: tl[tl.length - 1].el }; }
function tiltsFor(frame, def) { return def.mom === 'REF' ? RW.refTilts(frame) : RW.tilts(frame, def.mom); }
function slantLUT(sw, h0) { if (sw.slut) return sw.slut; var n = 2400, a = new Float32Array(n); for (var i = 0; i < n; i++) a[i] = RW.beamAt(i * 0.25, sw.el, h0).r; return (sw.slut = a); }

/* ---------- raster renderer (map panels and the 3-D ground texture) ---------- */
/** fill Uint32 pixel buffer for a W x H viewport centred (cx,cy) km at `scale` px/km */
function renderRaster(px, W, H, view, panel, step) {
  px.fill(0); step = step || 1;
  var src = S.sources[panel.src], frame = curFrame(panel.src), def = prodDef(panel.prod); if (!frame || !def) return null;
  var ct = ctFor(def), x0 = view.cx - W / 2 / view.scale, y0 = view.cy + H / 2 / view.scale, inv = 1 / view.scale, ix, iy, X, Y, c;
  if (def.polar && src.kind === 'radar') {
    ensureQC(frame);
    var tl = tiltsFor(frame, def); if (!tl.length) return { frame: frame, none: true };
    var sw = tl[Math.min(panel.tilt, tl.length - 1)], m = sw.mom[def.mom], r = rxy(frame), sl = slantLUT(sw, (frame.alt || 0) / 1000), lutA = sw.lut, raw = m.raw, ng = m.ng, r0 = m.r0, idr = 1 / m.dr;
    var useQC = !def.raw && !def.special && !!sw.qc, qc = sw.qc, qg = sw.qcGeom, sameG = useQC && qg.ng === ng && qg.r0 === r0, maxS = Math.min(599, (r0 + ng * m.dr));
    var special = def.special, att = def.mom === 'REF' && !special && !def.raw && sw.pia && sw.useAtt, L = (special || att) ? valLUT(ct) : null, lut = L ? null : rawLUT(ct, m), pg = sw.piaGeom;
    for (iy = 0; iy < H; iy += step) {
      Y = y0 - iy * inv - r[1];
      for (ix = 0; ix < W; ix += step) {
        X = x0 + ix * inv - r[0]; var s = Math.sqrt(X * X + Y * Y); if (s > maxS) continue;
        var az = Math.atan2(X, Y) * 57.29577951; if (az < 0) az += 360;
        var ri = lutA[(az * 10) | 0]; if (ri < 0) continue;
        var rr = sl[(s * 4 + 0.5) | 0], g = ((rr - r0) * idr + 0.5) | 0; if (g < 0 || g >= ng) continue;
        if (special === 'qcf') { c = qc ? RWC.lookup(L, RW.qcAt(sw, ri, rr)) : 0; }
        else if (special === 'pia') { c = sw.pia ? RWC.lookup(L, RW.piaAt(sw, ri, rr)) : 0; }
        else {
          var v = raw[ri * ng + g]; if (!v) continue;
          if (useQC && (sameG ? qc[ri * ng + g] : RW.qcAt(sw, ri, rr))) continue;
          c = att && v > 1 ? RWC.lookup(L, (v - m.offset) / m.scale + RW.piaAt(sw, ri, rr)) : lut[v];
        }
        if (!c) continue;
        if (step === 1) px[iy * W + ix] = c; else for (var b = 0; b < step && iy + b < H; b++) for (var a = 0; a < step && ix + a < W; a++) px[(iy + b) * W + ix + a] = c;
      }
    }
    return { frame: frame, sweep: sw, def: def, ct: ct };
  }
  var gdef = def.polar ? prodDef('cref') : def, F = fieldOf(panel.src, frame, gdef); if (!F) return { frame: frame, none: true };
  var sp = F.G.spec, d = F.data, VL = valLUT(ctFor(gdef)), ht = prodUnits(gdef) === 'ht', idx = 1 / sp.dx;
  for (iy = 0; iy < H; iy += step) {
    var gy = ((y0 - iy * inv - sp.y0) * idx + 0.5) | 0; if (gy < 0 || gy >= sp.ny) continue;
    for (ix = 0; ix < W; ix += step) {
      var gx = ((x0 + ix * inv - sp.x0) * idx + 0.5) | 0; if (gx < 0 || gx >= sp.nx) continue;
      var fv = d[gy * sp.nx + gx]; if (fv !== fv) continue;
      c = RWC.lookup(VL, ht ? fv / KFT : fv); if (!c) continue;
      if (step === 1) px[iy * W + ix] = c; else for (b = 0; b < step && iy + b < H; b++) for (a = 0; a < step && ix + a < W; a++) px[(iy + b) * W + ix + a] = c;
    }
  }
  return { frame: frame, def: gdef, ct: ctFor(gdef), grid: F.G, sub: def.polar ? 'Composite (this source has no tilts)' : null };
}
/** value under a map point for a panel -> {v, def, extra} */
function probe(panel, X, Y) {
  var src = S.sources[panel.src], frame = curFrame(panel.src), def = prodDef(panel.prod); if (!frame || !def) return null;
  if (def.polar && src.kind === 'radar') {
    var tl = tiltsFor(frame, def); if (!tl.length) return null; var sw = tl[Math.min(panel.tilt, tl.length - 1)], r = rxy(frame), dx = X - r[0], dy = Y - r[1], s = Math.hypot(dx, dy), az = (Math.atan2(dx, dy) / D2R + 360) % 360, b = RW.beamAt(s, sw.el, (frame.alt || 0) / 1000), ri = RW.radialAt(sw, az), v;
    if (def.special === 'qcf') v = sw.qc && ri >= 0 ? RW.qcAt(sw, ri, b.r) : NaN; else if (def.special === 'pia') v = sw.pia && ri >= 0 ? RW.piaAt(sw, ri, b.r) : NaN; else v = RW.sample(sw, def.mom, ri, b.r, !def.raw);
    return { v: v, def: def, beamH: b.h, range: s, az: az };
  }
  var gdef = def.polar ? prodDef('cref') : def, F = fieldOf(panel.src, frame, gdef); if (!F) return null; var sp = F.G.spec, gx = Math.round((X - sp.x0) / sp.dx), gy = Math.round((Y - sp.y0) / sp.dx);
  return { v: (gx < 0 || gy < 0 || gx >= sp.nx || gy >= sp.ny) ? NaN : F.data[gy * sp.nx + gx], def: gdef };
}

/* ---------- cross-section ---------- */
function xsPath() { // [{x,y,d}] sampled ground path
  if (S.xs.mode === 'traj' && S.trajP && S.trajP.length > 1) { var out = [], last = -1; S.trajP.forEach(function (p) { if (p.g - last >= 0.2) { out.push({ x: p.x, y: p.y, d: p.g }); last = p.g; } }); var n = out.length, a = out[n - 2], b = out[n - 1], L = Math.max(0.01, b.d - a.d), ux = (b.x - a.x) / L, uy = (b.y - a.y) / L; var a0 = out[0], a1 = out[1], l0 = Math.max(0.01, a1.d - a0.d), vx = (a1.x - a0.x) / l0, vy = (a1.y - a0.y) / l0, pre = []; for (var e = 20; e > 0; e -= 0.5) pre.push({ x: a0.x - vx * e, y: a0.y - vy * e, d: -e }); for (e = 0.5; e <= 20; e += 0.5) out.push({ x: b.x + ux * e, y: b.y + uy * e, d: b.d + e }); return pre.concat(out); }
  if (!S.xs.a || !S.xs.b) return null; var A = S.xs.a, B = S.xs.b, len = Math.hypot(B[0] - A[0], B[1] - A[1]), N = 400, o = []; if (len < 0.5) return null;
  for (var i = 0; i <= N; i++) o.push({ x: A[0] + (B[0] - A[0]) * i / N, y: A[1] + (B[1] - A[1]) * i / N, d: len * i / N }); return o;
}
/** render one cross-section into Uint32 buffer W x H ; returns metadata for overlays */
function renderXS(px, W, H, panel, path) {
  px.fill(0);
  var src = S.sources[panel.src], frame = curFrame(panel.src), def = prodDef(panel.prod); if (!frame || !path) return null;
  if (!def || !def.polar || def.special) def = prodDef('REF');
  var ct = ctFor(def), L = valLUT(ct), top = S.xs.top, d0 = path[0].d, d1 = path[path.length - 1].d, np = path.length, ix, iy;
  function pt(i) { var f = (i / (W - 1)) * (np - 1), k = Math.min(np - 2, f | 0), t = f - k; return [path[k].x + t * (path[k + 1].x - path[k].x), path[k].y + t * (path[k + 1].y - path[k].y)]; }
  if (src.kind === 'radar') {
    ensureQC(frame);
    var tl = tiltsFor(frame, def), nt = tl.length; if (!nt) return null;
    var r = rxy(frame), h0 = (frame.alt || 0) / 1000, hk = new Float32Array(nt), vk = new Float32Array(nt), lin = S.xs.interp && def.mom !== 'VEL' && def.mom !== 'PHI', bw = S.grid.bw * D2R, useQC = !def.raw;
    for (ix = 0; ix < W; ix++) {
      var p = pt(ix), dx = p[0] - r[0], dy = p[1] - r[1], s = Math.hypot(dx, dy), az = (Math.atan2(dx, dy) / D2R + 360) % 360, hb = Math.max(0.05, s * bw / 2);
      for (var k = 0; k < nt; k++) { var b = RW.beamAt(s, tl[k].el, h0); hk[k] = b.h; var v = RW.sample(tl[k], def.mom, RW.radialAt(tl[k], az), b.r, useQC); vk[k] = v === -Infinity ? NaN : v; }
      var kk = 0;
      for (iy = H - 1; iy >= 0; iy--) {
        var z = (H - 1 - iy) / (H - 1) * top, val = NaN;
        if (!S.xs.interp) { var bk = -1, bd = 1e9; for (k = 0; k < nt; k++) { var dd = Math.abs(z - hk[k]); if (dd < bd) { bd = dd; bk = k; } } if (bd <= hb) val = vk[bk]; }
        else if (z < hk[0]) { if (S.grid.toGround || z >= hk[0] - hb) val = vk[0]; }
        else if (z >= hk[nt - 1]) { if (z <= hk[nt - 1] + hb) val = vk[nt - 1]; }
        else { while (kk < nt - 2 && z >= hk[kk + 1]) kk++; var va = vk[kk], vb = vk[kk + 1], f = (z - hk[kk]) / (hk[kk + 1] - hk[kk]);
          if (lin && va === va && vb === vb) val = va + f * (vb - va);
          else if (f <= 0.5) { if (va === va) val = va; else if (vb === vb && z >= hk[kk + 1] - hb) val = vb; }
          else { if (vb === vb) val = vb; else if (va === va && z <= hk[kk] + hb) val = va; } }
        if (val === val) px[iy * W + ix] = RWC.lookup(L, val);
      }
    }
  } else {
    var G = frame.grid, sp = G.spec; def = prodDef('REF'); ct = ctFor(def); L = valLUT(ct);
    for (ix = 0; ix < W; ix++) { p = pt(ix); var gx = Math.round((p[0] - sp.x0) / sp.dx), gy = Math.round((p[1] - sp.y0) / sp.dx); if (gx < 0 || gy < 0 || gx >= sp.nx || gy >= sp.ny) continue; var base = (gy * sp.nx + gx) * sp.nz; for (iy = 0; iy < H; iy++) { var kz = Math.round((H - 1 - iy) / (H - 1) * top / sp.dz); if (kz < sp.nz) { var rv = G.data[base + kz]; if (rv) px[iy * W + ix] = RWC.lookup(L, RW.dec(rv)); } } }
  }
  return { def: def, ct: ct, frame: frame, d0: d0, d1: d1 };
}

/* ---------- site-wide settings: docs/config.json next to the page ({"relay": "https://...workers.dev"}) ---------- */
function normRelay(v) { v = String(v || '').trim(); if (!v || /YOURNAME|SOMETHING/.test(v)) return ''; return /[?&]url=$/.test(v) ? v : v.replace(/\/+$/, '') + '/?url='; }
function loadSiteConfig() {
  return fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
    if (!c) return; var rel = normRelay(c.relay); RWIO.cfg.siteProxy = rel; if (rel && !RWIO.cfg.proxy) RWIO.cfg.proxy = rel;
    if (c.wsrBase) RWIO.cfg.wsrBase = String(c.wsrBase).replace(/\/+$/, '');
  }).catch(function () { });
}
