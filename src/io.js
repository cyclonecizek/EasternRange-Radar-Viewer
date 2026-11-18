/* ===== io.js : fetch helpers, gzip/zip, WSR API, NEXRAD + MRMS on AWS, GRIB2 (PNG/simple packing), Open-Meteo profiles ===== */
var RWIO = (function () {
  'use strict';
  var IO = { cfg: { wsrBase: 'https://codiapi-wsr.rad.spaceforce.mil', proxy: '', siteProxy: '', nexradHosts: ['https://unidata-nexrad-level2.s3.amazonaws.com', 'https://noaa-nexrad-level2.s3.amazonaws.com'], mrmsHost: 'https://noaa-mrms-pds.s3.amazonaws.com' } };
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  IO.iso = function (ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()); };
  IO.parseTime = function (s) { s = String(s); if (!/Z$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; return Date.parse(s); };
  IO.url = function (u, viaProxy) { return viaProxy && IO.cfg.proxy ? IO.cfg.proxy + encodeURIComponent(u) : u; };
  async function get(u, type, viaProxy) {
    var r; try { r = await fetch(IO.url(u, viaProxy), { cache: 'no-store' }); } catch (e) { var er = new Error('Network/CORS failure reaching ' + u.split('?')[0]); er.cors = true; throw er; }
    if (!r.ok) { var t = ''; try { t = (await r.text()).slice(0, 200); } catch (e2) { } var e3 = new Error('HTTP ' + r.status + ' from ' + u.split('?')[0] + (t ? ': ' + t : '')); e3.status = r.status; throw e3; }
    return type === 'json' ? r.json() : type === 'text' ? r.text() : new Uint8Array(await r.arrayBuffer());
  }
  IO.get = get;
  async function inflate(u8, fmt) { var ds = new DecompressionStream(fmt), w = ds.writable.getWriter(); w.write(u8).catch(function () { }); w.close().catch(function () { }); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
  IO.inflate = inflate;
  IO.maybeGunzip = async function (u8) { return (u8[0] === 0x1f && u8[1] === 0x8b) ? inflate(u8, 'gzip') : u8; };
  /** minimal ZIP reader -> [{name, data}] */
  IO.unzip = async function (u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a zip file');
    var n = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true), out = [];
    for (var i = 0; i < n && dv.getUint32(p, true) === 0x02014b50; i++) {
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      var ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(ds, ds + csize);
      if (csize && !/\/$/.test(name)) out.push({ name: name, data: method === 8 ? await inflate(raw, 'deflate-raw') : raw.slice() });
      p += 46 + nl + xl + cl;
    }
    return out;
  };

  /* ---------- WSR API ---------- */
  function rowsOf(j) { var a = Array.isArray(j) ? j : (j && (j.files || j.data || j.results || j.items)) || (j && j.file_date ? [j] : []); return a.map(function (r) { return { time: IO.parseTime(r.file_date || r.date || r.timestamp), stamp: String(r.file_date || r.date || r.timestamp).replace(/Z$/, '').replace(/\.\d+$/, '').slice(0, 19), size: +(r.file_size || r.size || 0), name: r.filename || r.file_name || r.name || '' }; }).filter(function (r) { return isFinite(r.time); }); }
  IO.wsrLatest = async function () { return rowsOf(await get(IO.cfg.wsrBase + '/wsr/latest', 'json', true))[0]; };
  IO.wsrRange = async function (t0, t1) { return rowsOf(await get(IO.cfg.wsrBase + '/wsr/range?date%3E=' + IO.iso(t0) + '&date%3C=' + IO.iso(t1) + '&sort=asc', 'json', true)).sort(function (a, b) { return a.time - b.time; }); };
  IO.wsrFile = async function (row) { return get(IO.cfg.wsrBase + '/wsr/latest/download' + (row ? '?date=' + row.stamp : ''), 'bin', true); };
  IO.wsrZip = async function (t0, t1) { return IO.unzip(await get(IO.cfg.wsrBase + '/wsr/latest/download?date%3E=' + IO.iso(t0) + '&date%3C=' + IO.iso(t1), 'bin', true)); };

  /* ---------- S3 listings ---------- */
  async function s3list(host, prefix) { var x = await get(host + '/?list-type=2&prefix=' + encodeURIComponent(prefix), 'text'), keys = [], re = /<Key>([^<]+)<\/Key>/g, m; while ((m = re.exec(x))) keys.push(m[1]); return keys; }
  IO.nexradList = async function (site, t) {
    var out = [], err = null;
    for (var h = 0; h < IO.cfg.nexradHosts.length && !out.length; h++) {
      try {
        for (var dd = -1; dd <= 0; dd++) { // previous day too, when near 00Z
          var d = new Date(t + dd * 86400000); if (dd === -1 && new Date(t).getUTCHours() > 0) continue;
          var keys = await s3list(IO.cfg.nexradHosts[h], d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + '/' + site + '/');
          keys.forEach(function (k) { var m = /(\d{8})_(\d{6})(_V\d\d)?(\.gz)?$/.exec(k); if (m) out.push({ key: k, host: IO.cfg.nexradHosts[h], time: Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)) }); });
        }
      } catch (e) { err = e; }
    }
    if (!out.length && err) throw err;
    return out.sort(function (a, b) { return a.time - b.time; });
  };
  IO.nexradFile = async function (row) { return IO.maybeGunzip(await get(row.host + '/' + row.key, 'bin')); };

  /* ---------- GRIB2 (single message; lat/lon grid; simple or PNG packing) ---------- */
  function pngDecode(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), p = 8, parts = [], W = 0, H = 0, depth = 0, ctype = 0;
    while (p + 8 <= u8.length) { var len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]); if (type === 'IHDR') { W = dv.getUint32(p + 8); H = dv.getUint32(p + 12); depth = u8[p + 16]; ctype = u8[p + 17]; } else if (type === 'IDAT') parts.push(u8.subarray(p + 8, p + 8 + len)); else if (type === 'IEND') break; p += 12 + len; }
    var tot = parts.reduce(function (s, a) { return s + a.length; }, 0), z = new Uint8Array(tot), o = 0; parts.forEach(function (a) { z.set(a, o); o += a.length; });
    var ch = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 6 ? 4 : 1, bpp = Math.max(1, ch * depth >> 3), stride = W * bpp;
    return inflate(z, 'deflate').then(function (raw) {
      var px = new Uint8Array(H * stride), prev = new Uint8Array(stride);
      for (var y = 0, q = 0; y < H; y++) {
        var f = raw[q++], line = px.subarray(y * stride, (y + 1) * stride), i, a, b, c;
        for (i = 0; i < stride; i++) {
          var x = raw[q++]; a = i >= bpp ? line[i - bpp] : 0; b = prev[i];
          if (f === 1) x += a; else if (f === 2) x += b; else if (f === 3) x += (a + b) >> 1; else if (f === 4) { c = i >= bpp ? prev[i - bpp] : 0; var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); x += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
          line[i] = x;
        }
        prev = line;
      }
      return { px: px, bpp: bpp, W: W, H: H };
    });
  }
  IO.grib2 = async function (u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'GRIB' || u8[7] !== 2) throw new Error('Not a GRIB2 message');
    var p = 16, g = {}, vals = null;
    function sm16(o) { var v = dv.getUint16(o); return v & 0x8000 ? -(v & 0x7fff) : v; }
    function sm32(o) { var v = dv.getUint32(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; }
    while (p + 5 <= u8.length && String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]) !== '7777') {
      var len = dv.getUint32(p), sec = u8[p + 4];
      if (sec === 1) g.time = Date.UTC(dv.getUint16(p + 12), u8[p + 14] - 1, u8[p + 15], u8[p + 16], u8[p + 17], u8[p + 18]);
      else if (sec === 3) { if (dv.getUint16(p + 12) !== 0) throw new Error('GRIB2 grid template ' + dv.getUint16(p + 12) + ' unsupported'); g.ni = dv.getUint32(p + 30); g.nj = dv.getUint32(p + 34); g.la1 = sm32(p + 46) / 1e6; g.lo1 = sm32(p + 50) / 1e6; g.la2 = sm32(p + 55) / 1e6; g.lo2 = sm32(p + 59) / 1e6; g.di = dv.getUint32(p + 63) / 1e6; g.dj = dv.getUint32(p + 67) / 1e6; g.scan = u8[p + 71]; if (g.lo1 > 180) g.lo1 -= 360; if (g.lo2 > 180) g.lo2 -= 360; }
      else if (sec === 5) { g.tmpl = dv.getUint16(p + 9); g.R = dv.getFloat32(p + 11); g.E = sm16(p + 15); g.D = sm16(p + 17); g.nbits = u8[p + 19]; }
      else if (sec === 6) { if (u8[p + 5] !== 255) throw new Error('GRIB2 bitmap not supported'); }
      else if (sec === 7) {
        var n = g.ni * g.nj, body = u8.subarray(p + 5, p + len), k2 = Math.pow(2, g.E), k10 = Math.pow(10, -g.D), i; vals = new Float32Array(n);
        if (g.nbits === 0) vals.fill(g.R * k10);
        else if (g.tmpl === 41) { var im = await pngDecode(body), px = im.px, bp = im.bpp; for (i = 0; i < n; i++) { var x = 0, q = i * bp; for (var b = 0; b < bp; b++) x = x * 256 + px[q + b]; vals[i] = (g.R + x * k2) * k10; } }
        else if (g.tmpl === 0) { var bit = 0, nb = g.nbits; for (i = 0; i < n; i++) { var v = 0; for (var c = 0; c < nb; c++, bit++) v = v * 2 + ((body[bit >> 3] >> (7 - (bit & 7))) & 1); vals[i] = (g.R + v * k2) * k10; } }
        else throw new Error('GRIB2 packing template 5.' + g.tmpl + ' unsupported');
      }
      p += len;
    }
    if (!vals) throw new Error('GRIB2: no data section');
    g.values = vals; return g;
  };
  /** value lookup closure on a decoded lat/lon grid (nearest point) */
  IO.gribSampler = function (g) {
    var north = !(g.scan & 0x40), ni = g.ni, nj = g.nj, v = g.values;
    return function (lat, lon) { var i = Math.round((lon - g.lo1) / g.di), j = Math.round(north ? (g.la1 - lat) / g.dj : (lat - g.la1) / g.dj); return (i < 0 || j < 0 || i >= ni || j >= nj) ? NaN : v[j * ni + i]; };
  };

  /* ---------- MRMS 3-D reflectivity mosaic ---------- */
  IO.MRMS_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  function lvStr(z) { return pad(Math.floor(z), 2) + '.' + pad(Math.round((z % 1) * 100), 2); }
  IO.mrmsFind = async function (t, product) {
    product = product || 'MergedReflectivityQC_00.50'; var best = null;
    for (var dh = 0; dh >= -1; dh--) {
      var d = new Date(t + dh * 3600000), day = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
      var keys = await s3list(IO.cfg.mrmsHost, 'CONUS/' + product + '/' + day + '/MRMS_' + product + '_' + day + '-' + pad(d.getUTCHours()));
      keys.forEach(function (k) { var m = /_(\d{8})-(\d{6})\.grib2/.exec(k); if (!m) return; var tt = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)); if (!best || Math.abs(tt - t) < Math.abs(best.time - t)) best = { time: tt, stamp: m[1] + '-' + m[2], key: k }; });
      if (best && Math.abs(best.time - t) < 150000) break;
    }
    if (!best) throw new Error('No MRMS files found near ' + IO.iso(t) + 'Z'); return best;
  };
  /** fetch all 33 levels and resample onto the Cartesian grid `spec` about `origin` -> {spec,data,time} */
  IO.mrmsVolume = async function (t, spec, origin, xy2ll, enc, onProgress) {
    var hit = await IO.mrmsFind(t), L = IO.MRMS_LEVELS, nx = spec.nx, ny = spec.ny, nz = spec.nz, cols = nx * ny, lv = new Array(L.length), done = 0, next = 0, fails = 0;
    var lat = new Float32Array(cols), lon = new Float32Array(cols);
    for (var iy = 0; iy < ny; iy++) for (var ix = 0; ix < nx; ix++) { var ll = xy2ll(spec.x0 + ix * spec.dx, spec.y0 + iy * spec.dx, origin); lat[iy * nx + ix] = ll[0]; lon[iy * nx + ix] = ll[1]; }
    async function one(li) {
      var s = lvStr(L[li]), key = 'CONUS/MergedReflectivityQC_' + s + '/' + hit.stamp.slice(0, 8) + '/MRMS_MergedReflectivityQC_' + s + '_' + hit.stamp + '.grib2.gz';
      try { var g = await IO.grib2(await IO.maybeGunzip(await get(IO.cfg.mrmsHost + '/' + key, 'bin'))), f = IO.gribSampler(g), a = new Float32Array(cols); for (var i = 0; i < cols; i++) { var v = f(lat[i], lon[i]); a[i] = v > -60 ? v : NaN; } lv[li] = a; g.values = null; }
      catch (e) { fails++; lv[li] = null; if (fails > 8) throw e; }
      if (onProgress) onProgress(++done, L.length);
    }
    async function runner() { while (next < L.length) await one(next++); }
    await Promise.all([runner(), runner(), runner(), runner()]);
    var data = new Uint8Array(cols * nz);
    for (var c = 0; c < cols; c++) for (var iz = 0, k = 0; iz < nz; iz++) {
      var z = iz * spec.dz; if (z < L[0] - 0.25 || z > L[L.length - 1] + 0.5) continue;
      while (k < L.length - 2 && z >= L[k + 1]) k++;
      var a0 = lv[k] ? lv[k][c] : NaN, a1 = lv[k + 1] ? lv[k + 1][c] : NaN, f2 = Math.min(1, Math.max(0, (z - L[k]) / (L[k + 1] - L[k]))), val = NaN;
      if (!isNaN(a0) && !isNaN(a1)) val = a0 + f2 * (a1 - a0); else if (!isNaN(a0) && f2 <= 0.5) val = a0; else if (!isNaN(a1) && f2 > 0.5) val = a1;
      if (!isNaN(val)) data[c * nz + iz] = enc(val);
    }
    return { spec: spec, data: data, time: hit.time, missingLevels: fails };
  };

  /* ---------- temperature profile from Open-Meteo pressure levels ---------- */
  IO.PLEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
  IO.fetchProfile = async function (lat, lon, t, model) {
    var d = new Date(t), day = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), old = Date.now() - t > 80 * 86400000;
    var vars = IO.PLEVELS.map(function (p) { return 'temperature_' + p + 'hPa,geopotential_height_' + p + 'hPa'; }).join(',');
    var u = (old ? 'https://historical-forecast-api.open-meteo.com' : 'https://api.open-meteo.com') + '/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) + '&hourly=temperature_2m,' + vars + '&start_date=' + day + '&end_date=' + day + '&timezone=GMT' + (model && model !== 'best_match' ? '&models=' + model : '');
    var j = await get(u, 'json'), H = j.hourly, hi = 0, bd = 1e18;
    H.time.forEach(function (s, i) { var dt = Math.abs(IO.parseTime(s + ':00') - t); if (dt < bd) { bd = dt; hi = i; } });
    var lv = [];
    IO.PLEVELS.forEach(function (p) { var T = H['temperature_' + p + 'hPa'], Z = H['geopotential_height_' + p + 'hPa']; if (T && Z && T[hi] != null && Z[hi] != null) lv.push({ z: Z[hi] / 1000, T: T[hi], p: p }); });
    if (lv.length < 5) throw new Error('Model returned no pressure-level data for that time');
    lv.sort(function (a, b) { return a.z - b.z; });
    var sfcZ = (j.elevation || 0) / 1000, t2 = H.temperature_2m && H.temperature_2m[hi];
    lv = lv.filter(function (l) { return l.z > sfcZ + 0.02; }); if (t2 != null) lv.unshift({ z: sfcZ, T: t2 });
    return { levels: lv, source: (model || 'best_match') + ' via Open-Meteo, valid ' + H.time[hi] + 'Z', time: IO.parseTime(H.time[hi] + ':00') };
  };
  return IO;
})();
if (typeof module !== 'undefined') module.exports = RWIO;
