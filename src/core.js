/* ===== core.js : geometry, volume assembly, QC, gridding, derived products, temperature profile, trajectory, LLCC evidence ===== */
var RW = (function () {
  'use strict';
  var NMI = 1.852, KFT = 0.3048, RE = 6371.0, RE43 = RE * 4 / 3, D2R = Math.PI / 180;
  var R = { NMI: NMI, KFT: KFT, RE43: RE43 };

  /* ---------- geometry (local tangent plane about an origin; km east / km north) ---------- */
  R.ll2xy = function (lat, lon, o) { return [(lon - o.lon) * D2R * RE * Math.cos((lat + o.lat) * 0.5 * D2R), (lat - o.lat) * D2R * RE]; };
  R.xy2ll = function (x, y, o) { var lat = o.lat + y / RE / D2R; return [lat, o.lon + x / (RE * Math.cos((lat + o.lat) * 0.5 * D2R)) / D2R]; };
  /** beam centre height (km MSL) and slant range for ground range s (km) at elevation el (deg), antenna height h0 (km) */
  R.beamAt = function (s, elDeg, h0) { var a = s / RE43, e = elDeg * D2R, c = Math.cos(e + a); return { r: RE43 * Math.sin(a) / c, h: RE43 * (Math.cos(e) / c - 1) + h0 }; };
  R.beamHeight = function (r, elDeg, h0) { var e = elDeg * D2R; return Math.sqrt(r * r + RE43 * RE43 + 2 * r * RE43 * Math.sin(e)) - RE43 + h0; };

  /* ---------- sweeps ---------- */
  R.prepSweep = function (sw) {
    if (sw.lut) return sw;
    var n = sw.nrad, lut = new Int16Array(3600).fill(-1), best = new Float32Array(3600).fill(9);
    var sp = 360 / n; sw.azsp = sp; var half = Math.max(0.75, sp * 0.75);
    for (var i = 0; i < n; i++) {
      var a = ((sw.az[i] % 360) + 360) % 360, lo = Math.floor((a - half) * 10), hi = Math.ceil((a + half) * 10);
      for (var b = lo; b <= hi; b++) { var bb = ((b % 3600) + 3600) % 3600, d = Math.abs((b + 0.5) / 10 - a); if (d < best[bb]) { best[bb] = d; lut[bb] = i; } }
    }
    sw.lut = lut; sw.qcv = -1; sw.qc = null; sw.pia = null;
    return sw;
  };
  R.radialAt = function (sw, azDeg) { var b = (azDeg * 10) | 0; if (b >= 3600) b -= 3600; if (b < 0) b += 3600; return sw.lut[b]; };
  R.val = function (m, raw) { return raw > 1 ? (raw - m.offset) / m.scale : NaN; };
  /** decoded value at (radial index, slant range); honours QC mask (set on REF geometry) when useQC */
  R.sample = function (sw, name, ri, r, useQC) {
    var m = sw.mom[name]; if (!m || ri < 0) return NaN;
    var g = Math.round((r - m.r0) / m.dr); if (g < 0 || g >= m.ng) return NaN;
    var raw = m.raw[ri * m.ng + g]; if (raw < 2) return raw === 1 ? -Infinity : NaN;
    if (useQC && sw.qc && R.qcAt(sw, ri, r)) return NaN;
    var v = (raw - m.offset) / m.scale;
    if (name === 'REF' && sw.pia && sw.useAtt) v += R.piaAt(sw, ri, r);
    return v;
  };
  R.qcAt = function (sw, ri, r) { var q = sw.qcGeom, g = Math.round((r - q.r0) / q.dr); return (g >= 0 && g < q.ng) ? sw.qc[ri * q.ng + g] : 0; };
  R.piaAt = function (sw, ri, r) { var q = sw.piaGeom, g = Math.round((r - q.r0) / q.dr); if (g < 0) return 0; if (g >= q.ng) g = q.ng - 1; return sw.pia[ri * q.ng + g] * 0.25; };

  /** unique-elevation list of sweeps that carry a moment (latest sweep wins for repeated elevations) */
  R.tilts = function (frame, name) {
    var by = {}, out = [];
    frame.sweeps.forEach(function (s) { if (!s.mom[name]) return; var k = Math.round(s.el * 10); if (!by[k] || s.t0 >= by[k].t0 || (name !== 'REF' && false)) by[k] = s; });
    for (var k in by) out.push(by[k]);
    return out.sort(function (a, b) { return a.el - b.el; });
  };
  /** best REF sweep per elevation: prefer the surveillance cut (longest range) when split cuts exist */
  R.refTilts = function (frame) {
    var by = {};
    frame.sweeps.forEach(function (s) { var m = s.mom.REF; if (!m) return; var k = Math.round(s.el * 10), c = by[k], rng = m.r0 + m.ng * m.dr; if (!c || rng > c.rng + 1 || (Math.abs(rng - c.rng) <= 1 && s.t0 >= c.s.t0)) by[k] = { s: s, rng: rng }; });
    var out = []; for (var k in by) out.push(by[k].s);
    return out.sort(function (a, b) { return a.el - b.el; });
  };

  /* ---------- volume assembly: files may hold a whole volume or just a tilt or two ---------- */
  R.assembleFrames = function (files, windowMin) {
    files.sort(function (a, b) { return a.time - b.time; });
    var frames = [], win = (windowMin || 8) * 60000;
    files.forEach(function (f, idx) {
      var nEl = {}; f.sweeps.forEach(function (s) { nEl[Math.round(s.el * 10)] = 1; });
      var fr = { time: f.time, site: f.site, lat: f.lat, lon: f.lon, alt: f.alt, vcp: f.vcp, partial: false, sweeps: f.sweeps, key: f.key };
      if (Object.keys(nEl).length < 3) { // partial file: pool the most recent sweep at every elevation inside the window
        var pool = {}, tEnd = f.sweeps[f.sweeps.length - 1].t1 || f.time;
        for (var j = idx; j >= 0 && files[j].time >= f.time - win; j--) files[j].sweeps.forEach(function (s) {
          var k = Math.round(s.el * 10) + '|' + Object.keys(s.mom).sort().join(''); if (!pool[k] && s.t0 <= tEnd) pool[k] = s;
        });
        fr.sweeps = Object.keys(pool).map(function (k) { return pool[k]; }).sort(function (a, b) { return a.el - b.el || a.t0 - b.t0; });
        fr.partial = true;
      }
      fr.sweeps.forEach(R.prepSweep);
      frames.push(fr);
    });
    return frames;
  };

  /* ---------- quality control ---------- */
  R.QC_BITS = { rho: 1, texture: 2, speckle: 4, spike: 8, vert: 16, trip2: 32, minz: 64 };
  R.QC_PRESETS = {
    off:      { speckle: 0, spike: false, rho: 0, texture: 0, vert: false, trip2: false, minz: -99, att: false },
    light:    { speckle: 2, spike: true, rho: 0, texture: 0, vert: false, trip2: false, minz: -99, att: false },
    standard: { speckle: 3, spike: true, rho: 0.70, texture: 9, vert: true, trip2: true, minz: -99, att: false },
    aggressive: { speckle: 4, spike: true, rho: 0.85, texture: 6, vert: true, trip2: true, minz: -5, att: false }
  };
  R.defaultQC = function () { var q = JSON.parse(JSON.stringify(R.QC_PRESETS.light)); q.preset = 'light'; q.rhoProtectZ = 45; q.vertMaxEl = 1.2; q.vertMaxRange = 150; q.spikeFrac = 0.45; q.attAlpha = 0.08; q.attMax = 25; q.version = 1; return q; };

  function findPartner(frame, sw, name) { // sweep at same elevation that carries `name`
    var best = null; frame.sweeps.forEach(function (s) { if (s !== sw && s.mom[name] && Math.abs(s.el - sw.el) < 0.25 && (!best || Math.abs(s.t0 - sw.t0) < Math.abs(best.t0 - sw.t0))) best = s; });
    return best;
  }
  /** build QC mask (Uint8 flags on the REF gate geometry) for every REF sweep of a frame */
  R.runQC = function (frame, qc) {
    var tl = frame.sweeps.filter(function (s) { return s.mom.REF; }).sort(function (a, b) { return a.el - b.el; });
    var B = R.QC_BITS, stats = { total: 0, removed: 0, by: { rho: 0, texture: 0, speckle: 0, spike: 0, vert: 0, trip2: 0, minz: 0 } };
    tl.forEach(function (sw, si) {
      if (sw.qcv === qc.version) return;
      var m = sw.mom.REF, n = sw.nrad, ng = m.ng, raw = m.raw, mask = new Uint8Array(n * ng), i, g, ri, p;
      sw.qcGeom = { r0: m.r0, dr: m.dr, ng: ng }; sw.qc = mask; sw.qcv = qc.version; sw.pia = null; sw.useAtt = false;
      var order = Array.from({ length: n }, function (_, k) { return k; }).sort(function (a, b) { return sw.az[a] - sw.az[b]; });
      var Z = function (ri, g) { var v = raw[ri * ng + g]; return v > 1 ? (v - m.offset) / m.scale : NaN; };
      if (qc.minz > -90) for (p = 0; p < raw.length; p++) if (raw[p] > 1 && (raw[p] - m.offset) / m.scale < qc.minz) mask[p] |= B.minz;
      /* dual-pol based */
      var dp = sw.mom.RHO ? sw : findPartner(frame, sw, 'RHO');
      if (dp && (qc.rho > 0 || qc.texture > 0)) {
        var rh = dp.mom.RHO, zd = dp.mom.ZDR;
        for (ri = 0; ri < n; ri++) {
          var rj = dp === sw ? ri : R.radialAt(dp, sw.az[ri]); if (rj < 0) continue;
          for (g = 0; g < ng; g++) {
            p = ri * ng + g; if (raw[p] < 2) continue;
            var rr = m.r0 + g * m.dr, z = (raw[p] - m.offset) / m.scale;
            if (qc.rho > 0 && z < qc.rhoProtectZ) {
              var gr = Math.round((rr - rh.r0) / rh.dr);
              if (gr >= 0 && gr < rh.ng) { var rv = rh.raw[rj * rh.ng + gr]; if (rv > 1 && (rv - rh.offset) / rh.scale < qc.rho) mask[p] |= B.rho; }
            }
            if (qc.texture > 0 && zd && z < qc.rhoProtectZ) { // ZDR + Z texture along the radial (5 gates)
              var gz = Math.round((rr - zd.r0) / zd.dr), s1 = 0, s2 = 0, c = 0, t1 = 0, t2 = 0, c2 = 0;
              for (var k = -2; k <= 2; k++) {
                var q = gz + k; if (q >= 0 && q < zd.ng) { var zv = zd.raw[rj * zd.ng + q]; if (zv > 1) { zv = (zv - zd.offset) / zd.scale; s1 += zv; s2 += zv * zv; c++; } }
                var q2 = g + k; if (q2 >= 0 && q2 < ng) { var z2 = raw[ri * ng + q2]; if (z2 > 1) { z2 = (z2 - m.offset) / m.scale; t1 += z2; t2 += z2 * z2; c2++; } }
              }
              if (c >= 4 && c2 >= 4) { var sdZdr = Math.sqrt(Math.max(0, s2 / c - s1 * s1 / c / c)), sdZ = Math.sqrt(Math.max(0, t2 / c2 - t1 * t1 / c2 / c2)); if (sdZdr > qc.texture * 0.3 && sdZ > qc.texture * 0.5) mask[p] |= B.texture; }
            }
          }
        }
      }
      /* interference / sun spikes: radials far more filled than their neighbours */
      if (qc.spike) {
        var g0 = Math.max(0, Math.round((20 - m.r0) / m.dr)), frac = new Float32Array(n), span = Math.max(1, ng - g0);
        for (i = 0; i < n; i++) { ri = order[i]; var cnt = 0; for (g = g0; g < ng; g++) if (raw[ri * ng + g] > 1) cnt++; frac[i] = cnt / span; }
        for (i = 0; i < n; i++) {
          if (frac[i] < qc.spikeFrac) continue;
          var w = 0; while (w < 3 && frac[(i + w + 1) % n] >= qc.spikeFrac * 0.8) w++;
          var left = frac[(i - 2 + n) % n], right = frac[(i + w + 2) % n];
          if (left < frac[i] * 0.4 && right < frac[i] * 0.4) for (k = 0; k <= w; k++) { ri = order[(i + k) % n]; for (g = 0; g < ng; g++) if (raw[ri * ng + g] > 1) mask[ri * ng + g] |= B.spike; }
          i += w;
        }
      }
      /* second trip: (a) Doppler cut echo that the long-range surveillance cut does not see; (b) incoherent (noisy) velocity */
      if (qc.trip2) {
        var mx = m.r0 + ng * m.dr, sv = null;
        frame.sweeps.forEach(function (s) { if (s !== sw && s.mom.REF && Math.abs(s.el - sw.el) < 0.25) { var r2 = s.mom.REF.r0 + s.mom.REF.ng * s.mom.REF.dr; if (r2 > mx + 20) sv = s; } });
        if (sv) for (ri = 0; ri < n; ri++) { rj = R.radialAt(sv, sw.az[ri]); if (rj < 0) continue; for (g = 0; g < ng; g++) { p = ri * ng + g; if (raw[p] > 1 && isNaN(R.sample(sv, 'REF', rj, m.r0 + g * m.dr, false)) && isNaN(R.sample(sv, 'REF', rj, m.r0 + (g + 2) * m.dr, false)) && isNaN(R.sample(sv, 'REF', rj, m.r0 + (g - 2) * m.dr, false))) mask[p] |= B.trip2; } }
        var vs = sw.mom.VEL ? sw : null, vm = vs && vs.mom.VEL, nyq = sw.nyq || 0;
        if (vm && nyq > 0) for (ri = 0; ri < n; ri++) for (g = 3; g < ng - 3; g++) {
          p = ri * ng + g; if (raw[p] < 2) continue;
          var gv = Math.round((m.r0 + g * m.dr - vm.r0) / vm.dr); if (gv < 3 || gv >= vm.ng - 3) continue;
          var a1 = 0, cn = 0, pv = NaN;
          for (k = -3; k <= 3; k++) { var vv = vm.raw[ri * vm.ng + gv + k]; if (vv < 2) { pv = NaN; continue; } vv = (vv - vm.offset) / vm.scale; if (!isNaN(pv)) { var dd = Math.abs(vv - pv); if (dd > nyq) dd = 2 * nyq - dd; a1 += dd; cn++; } pv = vv; }
          if (cn >= 5 && a1 / cn > 0.45 * nyq) { var zz = (raw[p] - m.offset) / m.scale; if (zz < 35) mask[p] |= B.trip2; }
        }
      }
      /* vertical continuity: low-tilt echo with nothing above it (AP, ground / sea clutter) */
      if (qc.vert && sw.el <= qc.vertMaxEl) {
        var up = null; for (k = si + 1; k < tl.length; k++) if (tl[k].el > sw.el + 0.3) { up = tl[k]; break; }
        if (up) {
          var gmax = Math.min(ng, Math.round((qc.vertMaxRange - m.r0) / m.dr)), cosr = Math.cos(sw.el * D2R) / Math.cos(up.el * D2R);
          for (ri = 0; ri < n; ri++) { rj = R.radialAt(up, sw.az[ri]); if (rj < 0) continue; for (g = 0; g < gmax; g++) { p = ri * ng + g; if (raw[p] < 2) continue; var ru = (m.r0 + g * m.dr) * cosr, hit = false; for (k = -2; k <= 2 && !hit; k++) if (!isNaN(R.sample(up, 'REF', rj, ru + k * m.dr * 2, false))) hit = true; if (!hit) mask[p] |= B.vert; } }
        }
      }
      /* speckle: too few valid neighbours in the 3x3 (azimuth x range) window; two passes */
      if (qc.speckle > 0) for (var pass = 0; pass < 2; pass++) {
        var kill = [];
        for (i = 0; i < n; i++) { ri = order[i]; var ra = order[(i + n - 1) % n], rb = order[(i + 1) % n]; for (g = 1; g < ng - 1; g++) { p = ri * ng + g; if (raw[p] < 2 || mask[p]) continue; var nb = 0, o; for (k = -1; k <= 1; k++) { o = ra * ng + g + k; if (raw[o] > 1 && !mask[o]) nb++; o = rb * ng + g + k; if (raw[o] > 1 && !mask[o]) nb++; if (k) { o = p + k; if (raw[o] > 1 && !mask[o]) nb++; } } if (nb < qc.speckle) kill.push(p); } }
        for (k = 0; k < kill.length; k++) mask[kill[k]] |= B.speckle;
      }
      /* attenuation (path-integrated, linear PhiDP method) */
      if (qc.att) R.buildPIA(frame, sw, qc);
    });
    tl.forEach(function (sw) { var raw = sw.mom.REF.raw, mask = sw.qc; if (!mask) return; for (var p = 0; p < raw.length; p++) if (raw[p] > 1) { stats.total++; var f = mask[p]; if (f) { stats.removed++; for (var nm in B) if (f & B[nm]) stats.by[nm]++; } } });
    frame.qcStats = stats; frame.qcv = qc.version;
    return stats;
  };
  R.buildPIA = function (frame, sw, qc) {
    var dp = sw.mom.PHI ? sw : findPartner(frame, sw, 'PHI'); if (!dp || !dp.mom.RHO) return;
    var ph = dp.mom.PHI, rh = dp.mom.RHO, m = sw.mom.REF, n = sw.nrad, ng = ph.ng, pia = new Uint8Array(n * ng), buf = new Float32Array(ng), win = [];
    for (var ri = 0; ri < n; ri++) {
      var rj = dp === sw ? ri : R.radialAt(dp, sw.az[ri]); if (rj < 0) continue;
      var g, last = NaN, base = NaN, run = 0;
      for (g = 0; g < ng; g++) { // median-of-9 smoothed PhiDP where RhoHV is high
        win.length = 0;
        for (var k = -4; k <= 4; k++) { var q = g + k; if (q < 0 || q >= ng) continue; var pr = ph.raw[rj * ng + q], gr = Math.round((ph.r0 + q * ph.dr - rh.r0) / rh.dr), rr = gr >= 0 && gr < rh.ng ? rh.raw[rj * rh.ng + gr] : 0; if (pr > 1 && rr > 1 && (rr - rh.offset) / rh.scale > 0.9) win.push((pr - ph.offset) / ph.scale); }
        buf[g] = win.length >= 5 ? win.sort(function (a, b) { return a - b; })[win.length >> 1] : NaN;
      }
      for (g = 0; g < ng; g++) {
        var v = buf[g];
        if (!isNaN(v)) { if (isNaN(base)) { if (++run >= 8) base = v; } else { var d = v - base; if (d < -180) d += 360; if (d > 300) d -= 360; if (isNaN(last) || d > last) last = Math.max(0, d); } }
        else if (isNaN(base)) run = 0;
        pia[ri * ng + g] = isNaN(last) ? 0 : Math.min(255, Math.round(Math.min(qc.attMax, last * qc.attAlpha) * 4));
      }
    }
    sw.pia = pia; sw.piaGeom = { r0: ph.r0, dr: ph.dr, ng: ng }; sw.useAtt = true; void m;
  };

  /* ---------- temperature profile ---------- */
  R.defaultProfile = function () { var lv = []; for (var z = 0; z <= 20; z += 0.5) lv.push({ z: z, T: z < 16 ? 26 - 6.2 * z : -73.2 }); return { levels: lv, source: 'Default tropical profile (placeholder, not real data)', isDefault: true }; };
  R.tempAt = function (prof, z) { var L = prof.levels, n = L.length; if (z <= L[0].z) return L[0].T; for (var i = 1; i < n; i++) if (z <= L[i].z) { var f = (z - L[i - 1].z) / (L[i].z - L[i - 1].z); return L[i - 1].T + f * (L[i].T - L[i - 1].T); } return L[n - 1].T; };
  /** lowest altitude (km) at which the temperature first falls to T */
  R.heightOf = function (prof, T) { var L = prof.levels; if (L[0].T <= T) return L[0].z; for (var i = 1; i < L.length; i++) if (L[i].T <= T) { var f = (L[i - 1].T - T) / (L[i - 1].T - L[i].T); return L[i - 1].z + f * (L[i].z - L[i - 1].z); } return NaN; };
  R.parseProfileText = function (txt) { // rows: height , temperature   (height ft/m/km auto, or pressure-less "T,z")
    var rows = []; txt.split(/\r?\n/).forEach(function (l) { var n = l.split(/[,;\t ]+/).filter(Boolean).map(Number); if (n.length >= 2 && isFinite(n[0]) && isFinite(n[1])) rows.push(n); });
    if (rows.length < 2) throw new Error('Need at least two "height, temperature" rows');
    var maxH = Math.max.apply(null, rows.map(function (r) { return r[0]; })), k = maxH > 2000 ? (maxH > 30000 ? KFT / 1000 : 0.001) : (maxH > 100 ? KFT : 1);
    var lv = rows.map(function (r) { return { z: r[0] * k, T: r[1] }; }).sort(function (a, b) { return a.z - b.z; });
    return { levels: lv, source: 'Manual entry' };
  };

  /* ---------- gridding ---------- */
  R.gridSpec = function (o) { o = o || {}; var half = o.half || 150, dx = o.dx || 1, dz = o.dz || 0.25, top = o.top || 20, cx = o.cx || 0, cy = o.cy || 0; var n = Math.round(2 * half / dx) + 1; return { nx: n, ny: n, nz: Math.round(top / dz) + 1, dx: dx, dz: dz, x0: cx - half, y0: cy - half, half: half, top: top }; };
  R.enc = function (dbz) { var v = Math.round((dbz + 32) * 2) + 1; return v < 1 ? 1 : v > 255 ? 255 : v; };
  R.dec = function (raw) { return raw ? (raw - 1) * 0.5 - 32 : NaN; };
  /** radar frame -> Cartesian reflectivity grid. rxy = radar position [x,y] in grid coordinates (km), opts {bw, useQC, toGround} */
  R.gridRadar = function (frame, spec, rxy, opts) {
    opts = opts || {}; var bw = (opts.bw || 1.0) * D2R, tl = R.refTilts(frame), nt = tl.length, nx = spec.nx, ny = spec.ny, nz = spec.nz;
    var data = new Uint8Array(nx * ny * nz), h0 = (frame.alt || 0) / 1000, hk = new Float32Array(nt), vk = new Float32Array(nt), halfw = spec.dx * 0.5;
    var cosE = tl.map(function (s) { return Math.cos(s.el * D2R); }), eR = tl.map(function (s) { return s.el * D2R; });
    var maxR = tl.map(function (s) { return s.mom.REF.r0 + s.mom.REF.ng * s.mom.REF.dr; });
    for (var iy = 0; iy < ny; iy++) {
      var y = spec.y0 + iy * spec.dx - rxy[1];
      for (var ix = 0; ix < nx; ix++) {
        var x = spec.x0 + ix * spec.dx - rxy[0], s = Math.sqrt(x * x + y * y); if (s < 0.3) continue;
        var az = Math.atan2(x, y) / D2R; if (az < 0) az += 360;
        var a = s / RE43, any = false, k;
        for (k = 0; k < nt; k++) {
          var c = Math.cos(eR[k] + a), r = RE43 * Math.sin(a) / c; hk[k] = RE43 * (cosE[k] / c - 1) + h0; vk[k] = NaN;
          if (r > maxR[k]) continue;
          var sw = tl[k], ri = R.radialAt(sw, az); if (ri < 0) continue;
          var m = sw.mom.REF, g0 = Math.round((r - halfw - m.r0) / m.dr), g1 = Math.round((r + halfw - m.r0) / m.dr), best = NaN;
          if (g0 < 0) g0 = 0; if (g1 >= m.ng) g1 = m.ng - 1;
          for (var g = g0; g <= g1; g++) { var raw = m.raw[ri * m.ng + g]; if (raw < 2) continue; if (opts.useQC !== false && sw.qc && R.qcAt(sw, ri, m.r0 + g * m.dr)) continue; var v = (raw - m.offset) / m.scale; if (sw.pia && sw.useAtt) v += R.piaAt(sw, ri, m.r0 + g * m.dr); if (!(v <= best)) best = v; }
          vk[k] = best; if (!isNaN(best)) any = true;
        }
        if (!any) continue;
        var base = (iy * nx + ix) * nz, hb = s * bw * 0.5, kk = 0;
        for (var iz = 0; iz < nz; iz++) {
          var z = iz * spec.dz, val = NaN;
          if (z < hk[0]) { if (opts.toGround || z >= hk[0] - hb) val = vk[0]; }
          else if (z >= hk[nt - 1]) { if (z <= hk[nt - 1] + hb) val = vk[nt - 1]; else break; }
          else {
            while (kk < nt - 2 && z >= hk[kk + 1]) kk++;
            var va = vk[kk], vb = vk[kk + 1], f = (z - hk[kk]) / (hk[kk + 1] - hk[kk]);
            if (!isNaN(va) && !isNaN(vb)) val = va + f * (vb - va);
            else if (!isNaN(va)) { if (f <= 0.5 || z <= hk[kk] + hb) val = va; }
            else if (!isNaN(vb)) { if (f > 0.5 || z >= hk[kk + 1] - hb) val = vb; }
          }
          if (!isNaN(val)) data[base + iz] = R.enc(val);
        }
      }
    }
    return { spec: spec, data: data };
  };
  R.gridVal = function (G, x, y, z) { var sp = G.spec, ix = Math.round((x - sp.x0) / sp.dx), iy = Math.round((y - sp.y0) / sp.dx), iz = Math.round(z / sp.dz); if (ix < 0 || iy < 0 || iz < 0 || ix >= sp.nx || iy >= sp.ny || iz >= sp.nz) return NaN; return R.dec(G.data[(iy * sp.nx + ix) * sp.nz + iz]); };

  /* ---------- derived (column) products ---------- */
  function lvl(p, prof, spec) { // {z:km} or {T:degC} -> km
    if (p == null) return null; if (p.T != null) return R.heightOf(prof, p.T); return p.z;
  }
  R.PRODUCT_TYPES = {
    cref: { label: 'Composite reflectivity', units: 'dBZ', params: [] },
    etop: { label: 'Echo top', units: 'ht', params: ['thr'] },
    ebase: { label: 'Echo base', units: 'ht', params: ['thr'] },
    cappi: { label: 'CAPPI (constant height or temperature)', units: 'dBZ', params: ['lev'] },
    lmax: { label: 'Layer maximum', units: 'dBZ', params: ['lev', 'lev2'] },
    thick: { label: 'Echo thickness', units: 'ht', params: ['thr', 'lev', 'lev2'] },
    ettemp: { label: 'Echo-top temperature', units: 'degC', params: ['thr'] },
    vil: { label: 'VIL', units: 'kg/m2', params: [] },
    vahirr: { label: 'VAHIRR', units: 'dBZ-km', params: [] },
    hmax: { label: 'Height of max reflectivity', units: 'ht', params: [] }
  };
  /** compute a 2-D field (Float32, NaN = none) from a reflectivity grid. def = {type, thr, lev, lev2} */
  R.product = function (G, def, prof) {
    var sp = G.spec, nx = sp.nx, ny = sp.ny, nz = sp.nz, dz = sp.dz, d = G.data, out = new Float32Array(nx * ny).fill(NaN), n = nx * ny, i, k, b, v;
    var thrRaw = def.thr != null ? R.enc(def.thr) : 0;
    var z1 = lvl(def.lev, prof), z2 = lvl(def.lev2, prof);
    var k1 = z1 == null || isNaN(z1) ? 0 : Math.max(0, Math.ceil(z1 / dz - 1e-6)), k2 = z2 == null || isNaN(z2) ? nz - 1 : Math.min(nz - 1, Math.floor(z2 / dz + 1e-6));
    switch (def.type) {
      case 'cref': for (i = 0; i < n; i++) { b = i * nz; v = 0; for (k = 0; k < nz; k++) if (d[b + k] > v) v = d[b + k]; if (v) out[i] = R.dec(v); } break;
      case 'hmax': for (i = 0; i < n; i++) { b = i * nz; v = 0; var kz = 0; for (k = 0; k < nz; k++) if (d[b + k] > v) { v = d[b + k]; kz = k; } if (v) out[i] = kz * dz; } break;
      case 'lmax': for (i = 0; i < n; i++) { b = i * nz; v = 0; for (k = k1; k <= k2; k++) if (d[b + k] > v) v = d[b + k]; if (v) out[i] = R.dec(v); } break;
      case 'cappi': if (z1 != null && !isNaN(z1)) { var kf = z1 / dz, ka = Math.floor(kf), fr = kf - ka; if (ka >= 0 && ka < nz) for (i = 0; i < n; i++) { b = i * nz; var a0 = d[b + ka], a1 = ka + 1 < nz ? d[b + ka + 1] : 0; if (a0 && a1) out[i] = R.dec(a0) * (1 - fr) + R.dec(a1) * fr; else if (a0 && fr <= 0.5) out[i] = R.dec(a0); else if (a1 && fr > 0.5) out[i] = R.dec(a1); } } break;
      case 'etop': case 'ettemp': for (i = 0; i < n; i++) { b = i * nz; for (k = nz - 1; k >= 0; k--) if (d[b + k] >= thrRaw) { var zt = k * dz, up = k + 1 < nz ? d[b + k + 1] : 0; if (up) { var vv = R.dec(d[b + k]), vu = R.dec(up); zt += dz * Math.min(1, (vv - def.thr) / Math.max(0.5, vv - vu)); } else zt += dz * 0.5; out[i] = def.type === 'etop' ? zt : R.tempAt(prof, zt); break; } } break;
      case 'ebase': for (i = 0; i < n; i++) { b = i * nz; for (k = 0; k < nz; k++) if (d[b + k] >= thrRaw) { out[i] = Math.max(0, k * dz - dz * 0.5); break; } } break;
      case 'thick': for (i = 0; i < n; i++) { b = i * nz; var c = 0; for (k = k1; k <= k2; k++) if (d[b + k] >= thrRaw) c++; if (c) out[i] = c * dz; } break;
      case 'vil': for (i = 0; i < n; i++) { b = i * nz; var sum = 0, pz = NaN; for (k = 0; k < nz; k++) { var zz = d[b + k] ? Math.pow(10, Math.min(56, R.dec(d[b + k])) / 10) : 0; if (k && (zz || pz)) sum += 3.44e-6 * Math.pow((zz + pz) / 2, 4 / 7) * dz * 1000; pz = zz; } if (sum > 0.01) out[i] = sum; } break;
      case 'vahirr': return R.vahirr(G, prof).field;
    }
    return out;
  };
  /** VAHIRR per the LLCC definition: (mean dBZ of grid points >= 0 dBZ) x (average cloud thickness) in the Specified Volume
      (+/-5.5 km N/E/S/W of the point, 0 degC level to cloud top). Returns field (dBZ-km) plus the two factors. */
  R.vahirr = function (G, prof, halfKm) {
    var sp = G.spec, nx = sp.nx, ny = sp.ny, nz = sp.nz, dz = sp.dz, d = G.data, n = nx * ny, z0 = R.heightOf(prof, 0), zr = R.enc(0);
    var kb = Math.max(0, Math.ceil(z0 / dz - 1e-6)), W = nx + 1;
    var iS = new Float64Array(W * (ny + 1)), iC = new Float64Array(W * (ny + 1)), iT = new Float64Array(W * (ny + 1)), iB = new Float64Array(W * (ny + 1)), iN = new Float64Array(W * (ny + 1));
    for (var iy = 0; iy < ny; iy++) for (var ix = 0; ix < nx; ix++) {
      var b = (iy * nx + ix) * nz, s = 0, c = 0, top = -1, bot = -1;
      for (var k = kb; k < nz; k++) { var r = d[b + k]; if (r >= zr) { s += R.dec(r); c++; top = k; if (bot < 0) bot = k; } }
      var p = (iy + 1) * W + ix + 1, hasC = top >= 0 ? 1 : 0, tz = hasC ? top * dz + dz / 2 : 0, bz = hasC ? Math.max(z0, bot * dz - dz / 2) : 0;
      iS[p] = s + iS[p - 1] + iS[p - W] - iS[p - W - 1]; iC[p] = c + iC[p - 1] + iC[p - W] - iC[p - W - 1];
      iT[p] = tz + iT[p - 1] + iT[p - W] - iT[p - W - 1]; iB[p] = bz + iB[p - 1] + iB[p - W] - iB[p - W - 1]; iN[p] = hasC + iN[p - 1] + iN[p - W] - iN[p - W - 1];
    }
    var hw = Math.round((halfKm || 5.5) / sp.dx), field = new Float32Array(n).fill(NaN), avgZ = new Float32Array(n).fill(NaN), thick = new Float32Array(n).fill(NaN);
    function box(I, x0, y0, x1, y1) { return I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0]; }
    for (iy = 0; iy < ny; iy++) for (ix = 0; ix < nx; ix++) {
      var x0 = Math.max(0, ix - hw), x1 = Math.min(nx - 1, ix + hw), y0 = Math.max(0, iy - hw), y1 = Math.min(ny - 1, iy + hw);
      var cc = box(iC, x0, y0, x1, y1); if (!cc) continue;
      var nn = box(iN, x0, y0, x1, y1), az = box(iS, x0, y0, x1, y1) / cc, th = (box(iT, x0, y0, x1, y1) - box(iB, x0, y0, x1, y1)) / nn, q = iy * nx + ix;
      avgZ[q] = az; thick[q] = th; field[q] = az * th;
    }
    return { field: field, avgZ: avgZ, thick: thick, z0: z0 };
  };

  /* ---------- trajectory ---------- */
  /** flexible text parser: header names decide columns/units; returns [{t,lat,lon,z(km),spd(m/s)}] */
  R.parseTrajectory = function (txt) {
    var lines = txt.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== '#' && l[0] !== '!'; });
    if (!lines.length) throw new Error('Empty trajectory file');
    var delim = /[,;\t]/.test(lines[0]) ? /[,;\t]/ : /\s+/, split = function (l) { return l.split(delim).map(function (s) { return s.trim(); }).filter(function (s, i, a) { return s !== '' || delim.source !== '\\s+'; }); };
    var first = split(lines[0]), hasHdr = first.some(function (s) { return isNaN(parseFloat(s)); });
    var col = { t: -1, lat: -1, lon: -1, alt: -1, spd: -1 }, altK = null, spdK = 1, notes = [];
    if (hasHdr) {
      first.forEach(function (hd, i) {
        var s = hd.toLowerCase();
        if (col.lat < 0 && /lat/.test(s)) col.lat = i;
        else if (col.lon < 0 && /lon|lng/.test(s)) col.lon = i;
        else if (col.alt < 0 && /alt|height|hgt|^z|elev/.test(s)) { col.alt = i; altK = /kft/.test(s) ? KFT : /km/.test(s) ? 1 : /ft|feet/.test(s) ? KFT / 1000 : /nmi|nm\b/.test(s) ? NMI : /\bm\b|meter|metre|\(m\)|_m$/.test(s) ? 0.001 : null; }
        else if (col.spd < 0 && /vel|speed|spd/.test(s)) { col.spd = i; spdK = /ft/.test(s) ? 0.3048 : /km\/?s|kps/.test(s) ? 1000 : /kt|knot/.test(s) ? 0.514444 : 1; }
        else if (col.t < 0 && /time|^t$|^t[_ (]|sec|met/.test(s)) col.t = i;
      });
      lines.shift();
    } else { var nc = first.length; if (nc >= 4) col = { t: 0, lat: 1, lon: 2, alt: 3, spd: nc >= 5 ? 4 : -1 }; else if (nc === 3) col = { t: -1, lat: 0, lon: 1, alt: 2, spd: -1 }; notes.push('No header row: assumed columns ' + (nc >= 4 ? 'time, lat, lon, alt' : 'lat, lon, alt')); }
    if (col.lat < 0 || col.lon < 0 || col.alt < 0) throw new Error('Could not find latitude, longitude and altitude columns');
    var rows = lines.map(split).map(function (c) { return { t: col.t >= 0 ? parseFloat(c[col.t]) : NaN, lat: parseFloat(c[col.lat]), lon: parseFloat(c[col.lon]), a: parseFloat(c[col.alt]), spd: col.spd >= 0 ? parseFloat(c[col.spd]) * spdK : NaN }; }).filter(function (r) { return isFinite(r.lat) && isFinite(r.lon) && isFinite(r.a); });
    if (rows.length < 2) throw new Error('Fewer than two usable rows');
    if (altK == null) { var mx = Math.max.apply(null, rows.map(function (r) { return r.a; })); altK = mx > 100000 ? KFT / 1000 : mx > 2500 ? 0.001 : 1; notes.push('Altitude units guessed as ' + (altK === 1 ? 'km' : altK === 0.001 ? 'm' : 'ft') + ' from the values'); }
    rows.forEach(function (r) { if (r.lon > 180) r.lon -= 360; r.z = r.a * altK; delete r.a; });
    if (rows.every(function (r) { return r.lon > 0; }) && rows[0].lat > 20 && rows[0].lat < 50) { rows.forEach(function (r) { r.lon = -r.lon; }); notes.push('Longitudes were positive; treated as degrees west'); }
    return { pts: rows, notes: notes };
  };
  /** notional gravity-turn-like ascent for demonstration only */
  R.notionalTrajectory = function (lat, lon, azDeg, maxAltKm) {
    var pts = [], o = { lat: lat, lon: lon }, az = azDeg * D2R;
    for (var t = 0; t <= 200; t += 2) { var z = 0.5 * 0.0042 * t * t * (1 + t / 260), dr = t < 12 ? 0 : 0.5 * 0.0017 * Math.pow(t - 12, 2) * (1 + (t - 12) / 55); if (z > (maxAltKm || 60)) break; var ll = R.xy2ll(dr * Math.sin(az), dr * Math.cos(az), o); pts.push({ t: t, lat: ll[0], lon: ll[1], z: z, spd: NaN }); }
    return { pts: pts, notes: ['NOTIONAL demonstration trajectory (not a real vehicle)'] };
  };
  /** project to grid xy, derive speed, resample every `step` km of 3-D path up to zMax */
  R.prepTrajectory = function (traj, origin, step, zMax) {
    var P = traj.pts.map(function (p) { var xy = R.ll2xy(p.lat, p.lon, origin); return { x: xy[0], y: xy[1], z: p.z, t: p.t, spd: p.spd }; });
    for (var i = 0; i < P.length; i++) if (!isFinite(P[i].spd)) { var a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)]; var dt = b.t - a.t; P[i].spd = isFinite(dt) && dt > 0 ? Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2) + Math.pow(b.z - a.z, 2)) * 1000 / dt : NaN; }
    var out = [], dist = 0, ground = 0; step = step || 0.25;
    for (i = 0; i < P.length - 1; i++) {
      var p = P[i], q = P[i + 1], L = Math.sqrt(Math.pow(q.x - p.x, 2) + Math.pow(q.y - p.y, 2) + Math.pow(q.z - p.z, 2)), Lg = Math.hypot(q.x - p.x, q.y - p.y), n = Math.max(1, Math.ceil(L / step));
      for (var k = (i ? 1 : 0); k <= n; k++) { var f = k / n, z = p.z + f * (q.z - p.z); if (zMax && z > zMax) return out; out.push({ x: p.x + f * (q.x - p.x), y: p.y + f * (q.y - p.y), z: z, t: p.t + f * (q.t - p.t), spd: p.spd + f * (q.spd - p.spd), d: dist + f * L, g: ground + f * Lg }); }
      dist += L; ground += Lg;
    }
    return out;
  };

  /* ---------- LLCC radar evidence ---------- */
  R.defaultLLCC = function () { return { cloudThr: 0, cumulus: [{ T: -20, nmi: 10 }, { T: -10, nmi: 5 }, { T: -5, nmi: 0 }], standoffs: [3, 5, 10], vahirrLimit: 10, vahirrWithin: 1, modPrecip: 30, distWxNmi: 5, thickFt: 4500, thickTop: 0, thickBot: -20, thickNmi: 5, triboT: -10, triboFps: 3000, zMax: 20 }; };
  R.evalLLCC = function (G, prof, tp, cfg) {
    var sp = G.spec, nx = sp.nx, ny = sp.ny, nz = sp.nz, dz = sp.dz, dx = sp.dx, d = G.data, thr = R.enc(cfg.cloudThr), i, k;
    if (!tp || tp.length < 2) return null;
    // per-column cloud top + temperature class
    var topT = new Float32Array(nx * ny).fill(NaN), topK = new Int16Array(nx * ny).fill(-1);
    for (i = 0; i < nx * ny; i++) { var b = i * nz; for (k = nz - 1; k >= 0; k--) if (d[b + k] >= thr) { topK[i] = k; topT[i] = R.tempAt(prof, k * dz + dz / 2); break; } }
    var classes = cfg.cumulus.map(function (c) { return { T: c.T, nmi: c.nmi, d: Infinity, at: null }; });
    var any = { d: Infinity, at: null }, mod = { d: Infinity, at: null }, modRaw = R.enc(cfg.modPrecip);
    var Rmax = Math.max(10, Math.max.apply(null, cfg.standoffs.concat(classes.map(function (c) { return c.nmi; })))) * NMI + 2 * dx, rc = Math.ceil(Rmax / dx);
    var rows = [], tribo = [], through = { maxZ: NaN, at: null };
    var zT = R.heightOf(prof, cfg.triboT);
    for (var pi = 0; pi < tp.length; pi++) {
      var P = tp[pi], cx = Math.round((P.x - sp.x0) / dx), cy = Math.round((P.y - sp.y0) / dx), near = Infinity;
      for (var iy = Math.max(0, cy - rc); iy <= Math.min(ny - 1, cy + rc); iy++) {
        var ddy = sp.y0 + iy * dx - P.y;
        for (var ix = Math.max(0, cx - rc); ix <= Math.min(nx - 1, cx + rc); ix++) {
          var col = iy * nx + ix, tk = topK[col]; if (tk < 0) continue;
          var ddx = sp.x0 + ix * dx - P.x, h2 = ddx * ddx + ddy * ddy; if (h2 > Rmax * Rmax) continue;
          var tT = topT[col]; b = col * nz;
          for (k = 0; k <= tk; k++) {
            var r = d[b + k]; if (r < thr) continue;
            var dzk = k * dz - P.z, dist = Math.sqrt(h2 + dzk * dzk);
            if (dist < near) near = dist;
            if (dist < any.d) { any.d = dist; any.at = { x: P.x + ddx, y: P.y + ddy, z: k * dz, pt: pi }; }
            if (r >= modRaw && dist < mod.d) { mod.d = dist; mod.at = { x: P.x + ddx, y: P.y + ddy, z: k * dz, pt: pi }; }
            for (var c = 0; c < classes.length; c++) if (tT <= classes[c].T && dist < classes[c].d) { classes[c].d = dist; classes[c].at = { x: P.x + ddx, y: P.y + ddy, z: k * dz, pt: pi, topT: tT, topZ: tk * dz + dz / 2 }; }
          }
        }
      }
      var zHere = R.gridVal(G, P.x, P.y, P.z), TH = R.tempAt(prof, P.z);
      if (zHere >= cfg.cloudThr && !(zHere <= through.maxZ)) { through.maxZ = zHere; through.at = { z: P.z, T: TH, pt: pi }; }
      if (zHere >= cfg.cloudThr && TH <= cfg.triboT && !(P.spd >= cfg.triboFps * 0.3048)) tribo.push({ z: P.z, T: TH, dbz: zHere, spd: P.spd });
      rows.push({ t: P.t, z: P.z, T: TH, dbz: zHere, near: near, spd: P.spd, g: P.g });
    }
    // column tests near the ground track (VAHIRR, thick layers)
    var V = R.vahirr(G, prof), vmax = { v: NaN, at: null }, thick = { v: 0, at: null }, z0 = R.heightOf(prof, cfg.thickTop), z20 = R.heightOf(prof, cfg.thickBot);
    var rV = cfg.vahirrWithin * NMI, rT = cfg.thickNmi * NMI, rr = Math.ceil(Math.max(rV, rT) / dx) + 1, seen = new Uint8Array(nx * ny);
    for (pi = 0; pi < tp.length; pi++) {
      P = tp[pi]; cx = Math.round((P.x - sp.x0) / dx); cy = Math.round((P.y - sp.y0) / dx);
      for (iy = Math.max(0, cy - rr); iy <= Math.min(ny - 1, cy + rr); iy++) for (ix = Math.max(0, cx - rr); ix <= Math.min(nx - 1, cx + rr); ix++) {
        col = iy * nx + ix; var hd = Math.hypot(sp.x0 + ix * dx - P.x, sp.y0 + iy * dx - P.y);
        if (hd <= rV && !(seen[col] & 1)) { seen[col] |= 1; var vv = V.field[col]; if (!isNaN(vv) && !(vv <= vmax.v)) { vmax.v = vv; vmax.at = { x: sp.x0 + ix * dx, y: sp.y0 + iy * dx, avgZ: V.avgZ[col], thick: V.thick[col] }; } }
        if (hd <= rT && !(seen[col] & 2)) { seen[col] |= 2; b = col * nz; var run = 0, lo = 0; for (k = 0; k <= nz; k++) { if (k < nz && d[b + k] >= thr) { if (!run) lo = k; run++; } else if (run) { var zl = lo * dz - dz / 2, zh = (lo + run - 1) * dz + dz / 2, th = zh - zl; if (zh >= z0 && zl <= z20 && th > thick.v) { thick.v = th; thick.at = { x: sp.x0 + ix * dx, y: sp.y0 + iy * dx, base: Math.max(0, zl), top: zh }; } run = 0; } } }
      }
    }
    return { any: any, classes: classes, mod: mod, through: through, tribo: tribo, vahirr: vmax, thick: thick, rows: rows, z0: V.z0, zTribo: zT, res: dx };
  };
  return R;
})();
if (typeof module !== 'undefined') module.exports = RW;
