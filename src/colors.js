/* ===== colors.js : colour tables (gradient/step), GR-style .pal import/export, LUT builders ===== */
var RWC = (function () {
  'use strict';
  var C = {};
  function hex(c) { c = c.replace('#', ''); if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  C.hex = hex;
  C.toHex = function (r, g, b) { return '#' + [r, g, b].map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))).toString(16); return v.length < 2 ? '0' + v : v; }).join(''); };
  function T(id, name, units, mode, stops) { return { id: id, name: name, units: units, mode: mode, stops: stops.map(function (s) { return { v: s[0], c: s[1], c2: s[2] || null }; }), builtin: true }; }
  C.BUILTIN = [
    T('ref_nws', 'Reflectivity (NWS steps)', 'dBZ', 'step', [[-30, '#3b3b46'], [-10, '#5a5a6e'], [0, '#7d8fa6'], [5, '#04e9e7'], [10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'], [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'], [40, '#e5bc00'], [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'], [65, '#f800fd'], [70, '#9854c6'], [75, '#fdfdfd']]),
    T('ref_llcc', 'Reflectivity (LLCC: 0 / 18 / 30 dBZ breaks)', 'dBZ', 'grad', [[-25, '#1c2530'], [-10, '#33485c', '#4a6680'], [0, '#8fb8d8', '#b9dcf2'], [10, '#3fb8c8', '#1f7fb0'], [18, '#27c93f', '#0c7a25'], [30, '#f5e12a', '#f08a1a'], [40, '#f0461a', '#b00d0d'], [50, '#e23bd8', '#8a2bd0'], [60, '#ffffff', '#ffffff'], [75, '#ffffff']]),
    T('ref_smooth', 'Reflectivity (smooth)', 'dBZ', 'grad', [[-20, '#20242c'], [0, '#5d7896'], [10, '#27a4d8'], [20, '#1fbf4a'], [30, '#f2e52c'], [40, '#f28a1c'], [50, '#e01e1e'], [60, '#c22bd0'], [70, '#ffffff']]),
    T('vel', 'Velocity', 'm/s', 'grad', [[-40, '#ff7ad9'], [-30, '#7af0ff'], [-20, '#18c8ff', '#0a5bd8'], [-10, '#16d916', '#0a6e0a'], [-0.5, '#274f27', '#606060'], [0.5, '#4f2727', '#6e0a0a'], [10, '#d91616', '#ff8a2a'], [20, '#ffd22a', '#fff27a'], [30, '#ffffff'], [40, '#ffffff']]),
    T('sw', 'Spectrum width', 'm/s', 'grad', [[0, '#222831'], [2, '#3a6ea5'], [4, '#35b56a'], [7, '#f2d43a'], [10, '#f0722a'], [15, '#e01e5a'], [20, '#ffffff']]),
    T('zdr', 'Differential reflectivity', 'dB', 'grad', [[-4, '#101018'], [-1, '#5a5a8a'], [0, '#b8b8c8'], [0.5, '#4fc3f7'], [1.5, '#27c93f'], [2.5, '#f5e12a'], [4, '#f0722a'], [6, '#e01e1e'], [8, '#ff80ff']]),
    T('rho', 'Correlation coefficient', '', 'grad', [[0.2, '#101018'], [0.45, '#5a5a6a'], [0.65, '#2a3fb0'], [0.8, '#27a4d8'], [0.9, '#27c93f'], [0.95, '#f5e12a'], [0.97, '#f0722a'], [0.99, '#d01e1e'], [1.05, '#8a1050']]),
    T('phi', 'Differential phase', 'deg', 'grad', [[0, '#1a1a2e'], [60, '#2a6fd0'], [120, '#27c9a0'], [180, '#f5e12a'], [240, '#f0722a'], [300, '#e01e5a'], [360, '#ffffff']]),
    T('pia', 'Path-integrated attenuation', 'dB', 'grad', [[0.5, '#24384a'], [2, '#27a4d8'], [5, '#f5e12a'], [10, '#f0722a'], [20, '#e01e1e'], [30, '#ffffff']]),
    T('height', 'Height (kft)', 'kft', 'grad', [[0, '#1f2f3f'], [10, '#2f6fb0'], [20, '#27b8c0'], [30, '#35c95a'], [40, '#f5e12a'], [50, '#f0722a'], [60, '#e01e1e'], [70, '#ffffff']]),
    T('thick', 'Thickness (kft)', 'kft', 'grad', [[0.1, '#1f2f3f'], [4.5, '#2f6fb0', '#f5e12a'], [10, '#f0a22a'], [20, '#f0522a'], [35, '#d01e5a'], [50, '#ffffff']]),
    T('temp', 'Temperature (degC)', 'degC', 'grad', [[-80, '#ffffff'], [-60, '#c08cff'], [-40, '#5a5ad8'], [-20, '#27a4d8', '#35c9c9'], [-10, '#35c95a', '#b8e03a'], [-5, '#f5e12a'], [0, '#f0722a', '#e01e1e'], [5, '#a03030'], [25, '#402020']]),
    T('vil', 'VIL', 'kg/m2', 'grad', [[0.5, '#24384a'], [5, '#27a4d8'], [15, '#27c93f'], [30, '#f5e12a'], [45, '#f0722a'], [60, '#e01e1e'], [80, '#ffffff']]),
    T('vahirr', 'VAHIRR (dBZ-km, break at +10)', 'dBZ-km', 'grad', [[0.1, '#1f3f33'], [5, '#2f9f5f', '#9fdf6f'], [10, '#f5e12a', '#f0922a'], [33, '#f0522a'], [100, '#d01e5a'], [300, '#ffffff']]),
    T('qcf', 'QC flags', '', 'step', [[1, '#4fc3f7'], [2, '#f5e12a'], [4, '#9e9e9e'], [8, '#ff5fd0'], [16, '#f0722a'], [32, '#b060ff'], [64, '#607080'], [65, '#607080']])
  ];
  C.RF = [120, 0, 150];
  /** piecewise colour at value v -> [r,g,b] or null (below the first stop) */
  C.colorAt = function (ct, v) {
    var s = ct.stops, n = s.length; if (!(v >= s[0].v)) return null; if (v >= s[n - 1].v) return hex(s[n - 1].c2 || s[n - 1].c);
    var i = 0; while (i < n - 2 && v >= s[i + 1].v) i++;
    var a = hex(s[i].c); if (ct.mode === 'step') return a;
    var b = hex(s[i].c2 || s[i + 1].c), f = (v - s[i].v) / (s[i + 1].v - s[i].v);
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
  };
  function pack(c, alpha) { return c ? ((alpha << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0 : 0; }
  C.pack = pack;
  /** LUT over float values: {min, k, lut(Uint32 ABGR), n} ; index = (v-min)*k */
  C.valueLUT = function (ct, alpha) {
    var s = ct.stops, min = s[0].v, max = s[s.length - 1].v, n = 1024, lut = new Uint32Array(n + 1), a = alpha == null ? 255 : alpha;
    for (var i = 0; i <= n; i++) lut[i] = pack(C.colorAt(ct, min + (max - min) * i / n), a);
    return { min: min, k: n / (max - min), lut: lut, n: n };
  };
  C.lookup = function (L, v) { if (!(v >= L.min)) return 0; var i = ((v - L.min) * L.k) | 0; return L.lut[i > L.n ? L.n : i]; };
  /** LUT indexed by raw gate code for a moment (scale/offset) */
  C.rawLUT = function (ct, scale, offset, size, alpha) {
    var lut = new Uint32Array(size), a = alpha == null ? 255 : alpha; lut[1] = pack(C.RF, a);
    for (var r = 2; r < size; r++) lut[r] = pack(C.colorAt(ct, (r - offset) / scale), a);
    return lut;
  };
  /* GR .pal */
  C.parsePal = function (txt, name) {
    var stops = [], units = '', solid = true;
    txt.split(/\r?\n/).forEach(function (l) {
      var m = /^\s*(color4|color|solidcolor4|solidcolor|units|step|scale|nd|rf|product)\s*:\s*(.*)$/i.exec(l); if (!m) return;
      var key = m[1].toLowerCase(), v = m[2].trim();
      if (key === 'units') units = v;
      else if (/color/.test(key)) { var n = v.split(/[\s,]+/).map(Number), four = /4/.test(key), st = four ? 5 : 4; if (n.length < 4 || n.some(isNaN)) return; var s = { v: n[0], c: C.toHex(n[1], n[2], n[3]), c2: null }; if (/solid/.test(key)) s.c2 = s.c; else { solid = false; if (n.length >= st + 3) s.c2 = C.toHex(n[st], n[st + 1], n[st + 2]); } stops.push(s); }
    });
    if (stops.length < 2) throw new Error('No Color: lines found in the palette file');
    stops.sort(function (a, b) { return a.v - b.v; });
    return { id: 'u' + Date.now().toString(36), name: name || 'Imported palette', units: units, mode: solid ? 'step' : 'grad', stops: stops.map(function (s) { return solid ? { v: s.v, c: s.c, c2: null } : s; }) };
  };
  C.toPal = function (ct) {
    var o = ['; exported from LLCC Radar Workbench', 'Product: ' + ct.name, 'Units: ' + (ct.units || ''), ''];
    ct.stops.forEach(function (s) { var a = hex(s.c); if (ct.mode === 'step') o.push('SolidColor: ' + s.v + ' ' + a.join(' ')); else o.push('Color: ' + s.v + ' ' + a.join(' ') + (s.c2 ? ' ' + hex(s.c2).join(' ') : '')); });
    return o.join('\n');
  };
  C.css = function (ct) { // CSS gradient for legends
    var s = ct.stops, min = s[0].v, max = s[s.length - 1].v, parts = [];
    s.forEach(function (st, i) { var p = (st.v - min) / (max - min) * 100; parts.push(st.c + ' ' + p.toFixed(2) + '%'); if (i < s.length - 1) { var pn = (s[i + 1].v - min) / (max - min) * 100; if (ct.mode === 'step') parts.push(st.c + ' ' + pn.toFixed(2) + '%'); else if (st.c2) parts.push(st.c2 + ' ' + pn.toFixed(2) + '%'); } });
    return 'linear-gradient(90deg,' + parts.join(',') + ')';
  };
  return C;
})();
if (typeof module !== 'undefined') module.exports = RWC;
