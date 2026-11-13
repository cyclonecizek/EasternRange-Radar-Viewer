/* ===== decoder.js : bzip2 + NEXRAD Level II (AR2V / message 31) decoder. Runs in a Worker and on the main thread. ===== */
var RWDecoder = (function () {
  'use strict';
  /* ---------- bzip2 ---------- */
  function bunzip(src, pos, end) {
    var bitBuf = 0, bitCnt = 0;
    function bits(n) {
      var r = 0;
      while (n > 0) {
        if (bitCnt === 0) { if (pos >= end) throw new Error('bzip2: unexpected end'); bitBuf = src[pos++]; bitCnt = 8; }
        var take = n < bitCnt ? n : bitCnt;
        r = (r * (1 << take)) + ((bitBuf >>> (bitCnt - take)) & ((1 << take) - 1));
        bitCnt -= take; n -= take;
      }
      return r;
    }
    if (src[pos] !== 0x42 || src[pos + 1] !== 0x5a || src[pos + 2] !== 0x68) throw new Error('bzip2: bad magic');
    var level = src[pos + 3] - 0x30; pos += 4;
    var dbufSize = level * 100000;
    var dbuf = new Uint32Array(dbufSize);
    var out = new Uint8Array(Math.max(65536, (end - pos) * 6)), op = 0;
    function grow(n) { if (op + n > out.length) { var o2 = new Uint8Array(Math.max(out.length * 2, op + n)); o2.set(out.subarray(0, op)); out = o2; } }
    var symToByte = new Uint8Array(256), mtf = new Uint8Array(256), selectors = new Uint8Array(32768);
    var byteCount = new Int32Array(256);
    for (;;) {
      var m1 = bits(24), m2 = bits(24);
      if (m1 === 0x177245 && m2 === 0x385090) break;
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
      bits(32);
      if (bits(1)) throw new Error('bzip2: randomised blocks unsupported');
      var origPtr = bits(24);
      var used = bits(16), symTotal = 0, i, j, k;
      for (i = 0; i < 16; i++) if (used & (1 << (15 - i))) { var u = bits(16); for (j = 0; j < 16; j++) if (u & (1 << (15 - j))) symToByte[symTotal++] = 16 * i + j; }
      var groupCount = bits(3), nSel = bits(15);
      for (i = 0; i < groupCount; i++) mtf[i] = i;
      for (i = 0; i < nSel; i++) {
        for (j = 0; bits(1); j++) if (j >= groupCount) throw new Error('bzip2: bad selector');
        var uc = mtf[j]; for (; j > 0; j--) mtf[j] = mtf[j - 1]; mtf[0] = uc; selectors[i] = uc;
      }
      var symCount = symTotal + 2, groups = [];
      for (j = 0; j < groupCount; j++) {
        var length = new Uint8Array(258), t = bits(5);
        for (i = 0; i < symCount; i++) {
          for (;;) { if (t < 1 || t > 20) throw new Error('bzip2: bad code length'); if (!bits(1)) break; if (bits(1)) t--; else t++; }
          length[i] = t;
        }
        var minLen = 32, maxLen = 0;
        for (i = 0; i < symCount; i++) { if (length[i] > maxLen) maxLen = length[i]; if (length[i] < minLen) minLen = length[i]; }
        var g = { permute: new Int32Array(258), limit: new Int32Array(22), base: new Int32Array(22), minLen: minLen, maxLen: maxLen };
        var pp = 0, temp = new Int32Array(22);
        for (i = minLen; i <= maxLen; i++) for (t = 0; t < symCount; t++) if (length[t] === i) g.permute[pp++] = t;
        for (i = 0; i < symCount; i++) temp[length[i]]++;
        pp = t = 0;
        for (i = minLen; i < maxLen; i++) { pp += temp[i]; g.limit[i] = pp - 1; pp <<= 1; g.base[i + 1] = pp - (t += temp[i]); }
        g.limit[maxLen] = pp + temp[maxLen] - 1; g.limit[maxLen + 1] = 0x7fffffff; g.base[minLen] = 0;
        groups.push(g);
      }
      for (i = 0; i < 256; i++) { byteCount[i] = 0; mtf[i] = i; }
      var runPos = 0, count = 0, symCnt = 0, selector = 0, hg = null, runLen = 0;
      for (;;) {
        if (!(symCnt--)) { symCnt = 49; if (selector >= nSel) throw new Error('bzip2: selector overrun'); hg = groups[selectors[selector++]]; }
        i = hg.minLen; j = bits(i);
        for (;;) { if (i > hg.maxLen) throw new Error('bzip2: bad huffman'); if (j <= hg.limit[i]) break; i++; j = (j << 1) | bits(1); }
        j -= hg.base[i]; if (j < 0 || j >= 258) throw new Error('bzip2: bad symbol');
        var nextSym = hg.permute[j];
        if (nextSym < 2) { if (!runPos) { runPos = 1; runLen = 0; } runLen += runPos << nextSym; runPos <<= 1; continue; }
        if (runPos) {
          runPos = 0; if (count + runLen > dbufSize) throw new Error('bzip2: overflow');
          uc = symToByte[mtf[0]]; byteCount[uc] += runLen; while (runLen--) dbuf[count++] = uc;
        }
        if (nextSym > symTotal) break;
        if (count >= dbufSize) throw new Error('bzip2: overflow');
        i = nextSym - 1; uc = mtf[i]; for (; i > 0; i--) mtf[i] = mtf[i - 1]; mtf[0] = uc;
        uc = symToByte[uc]; byteCount[uc]++; dbuf[count++] = uc;
      }
      if (origPtr >= count) throw new Error('bzip2: bad origPtr');
      j = 0; for (i = 0; i < 256; i++) { k = j + byteCount[i]; byteCount[i] = j; j = k; }
      for (i = 0; i < count; i++) { uc = dbuf[i] & 0xff; dbuf[byteCount[uc]] |= (i << 8); byteCount[uc]++; }
      var p = 0, cur = 0, run = 0, prev = -1;
      if (count) { p = dbuf[origPtr] >>> 8; }
      var n = count; grow(n + 1024);
      while (n > 0) {
        n--;
        p = dbuf[p]; var b = p & 0xff; p >>>= 8;
        if (run === 4) { grow(b + 8); for (k = 0; k < b; k++) out[op++] = prev; run = 0; prev = -1; continue; }
        if (b === prev) run++; else { run = 1; prev = b; }
        if (op >= out.length) grow(65536);
        out[op++] = b;
      }
    }
    return { data: out.subarray(0, op), end: pos };
  }

  /* ---------- Level II ---------- */
  var MOMENTS = ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'CFP'];
  function str(u8, o, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(u8[o + i]); return s; }

  function parseMessages(u8, state) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), pos = 0, L = u8.length;
    while (pos + 28 <= L) {
      var h = pos + 12, size = dv.getUint16(h), type = u8[h + 3];
      if (type === 31) {
        var nseg = dv.getUint16(h + 12), segn = dv.getUint16(h + 14);
        var bytes = size === 65535 ? ((nseg << 16) | segn) * 2 : size * 2;
        if (bytes < 60 || h + bytes > L + 4) { pos += 2432; continue; }
        try { parse31(dv, u8, h + 16, Math.min(L, h + bytes), state, dv.getUint16(h + 6), dv.getUint32(h + 8)); } catch (e) { state.warn = String(e.message || e); }
        pos = h + bytes;
      } else {
        if (type === 1) state.legacy = true;
        pos += 2432;
      }
    }
  }
  function parse31(dv, u8, o, lim, st, jd, ms) {
    var az = dv.getFloat32(o + 12), status = u8[o + 21], elNum = u8[o + 22], el = dv.getFloat32(o + 24), nblk = dv.getUint16(o + 30);
    var t = (dv.getUint16(o + 8) - 1) * 86400000 + dv.getUint32(o + 4);
    if (!st.site) st.site = str(u8, o, 4).replace(/\0| /g, '');
    var sw = st.cur;
    if (!sw || sw.elNum !== elNum || status === 0 || status === 3 || status === 5) {
      sw = st.cur = { elNum: elNum, az: [], el: [], t0: t, t1: t, mom: {}, nyq: 0, urange: 0 };
      st.sweeps.push(sw);
    }
    var ri = sw.az.length; sw.az.push(az); sw.el.push(el); sw.t1 = t;
    for (var b = 0; b < nblk && b < 12; b++) {
      var p = o + dv.getUint32(o + 32 + 4 * b);
      if (p + 4 > lim) continue;
      var bt = String.fromCharCode(u8[p]), name = str(u8, p + 1, 3).replace(/ /g, '');
      if (bt === 'R') {
        if (name === 'VOL' && !st.vol) {
          st.vol = { lat: dv.getFloat32(p + 8), lon: dv.getFloat32(p + 12), siteAlt: dv.getInt16(p + 16), feed: dv.getUint16(p + 18), vcp: dv.getUint16(p + 40) };
        } else if (name === 'RAD') { sw.urange = dv.getInt16(p + 6) * 0.1; sw.nyq = dv.getInt16(p + 16) * 0.01; }
      } else if (bt === 'D' && MOMENTS.indexOf(name) >= 0) {
        var ng = dv.getUint16(p + 8), r0 = dv.getUint16(p + 10) / 1000, dr = dv.getUint16(p + 12) / 1000, ws = u8[p + 19], scale = dv.getFloat32(p + 20), offset = dv.getFloat32(p + 24);
        var m = sw.mom[name];
        if (!m) m = sw.mom[name] = { ng: ng, r0: r0, dr: dr, ws: ws, scale: scale, offset: offset, rows: [] };
        var row;
        if (ws === 16) { row = new Uint16Array(ng); for (var i = 0, q = p + 28; i < ng && q + 1 < lim; i++, q += 2) row[i] = dv.getUint16(q); }
        else { var n8 = Math.min(ng, lim - (p + 28)); row = new Uint8Array(ng); row.set(u8.subarray(p + 28, p + 28 + n8)); }
        m.rows[ri] = row; if (ng > m.ng) m.ng = ng;
      }
    }
  }
  function finishSweeps(st) {
    var out = [];
    st.sweeps.forEach(function (sw) {
      var n = sw.az.length; if (n < 20) return;
      var els = sw.el.slice().sort(function (a, b) { return a - b; });
      var s = { el: els[n >> 1], elNum: sw.elNum, nrad: n, az: new Float32Array(sw.az), t0: sw.t0, t1: sw.t1, nyq: sw.nyq, urange: sw.urange, mom: {} };
      for (var k in sw.mom) {
        var m = sw.mom[k], ng = m.ng, arr = m.ws === 16 ? new Uint16Array(n * ng) : new Uint8Array(n * ng);
        for (var r = 0; r < n; r++) if (m.rows[r]) arr.set(m.rows[r].subarray(0, Math.min(ng, m.rows[r].length)), r * ng);
        s.mom[k] = { ng: ng, r0: m.r0, dr: m.dr, scale: m.scale, offset: m.offset, raw: arr };
      }
      out.push(s);
    });
    return out;
  }
  /** Decode one Level II file (Uint8Array, already gunzipped if it was .gz). Returns {site,lat,lon,alt,vcp,time,sweeps[]} */
  function decodeLevel2(u8) {
    var magic = str(u8, 0, 4);
    if (magic !== 'AR2V' && magic !== 'ARCH') throw new Error('Not a Level II file (no AR2V header)');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var st = { sweeps: [], cur: null, vol: null, site: str(u8, 20, 4).replace(/\0| /g, '') };
    var htime = (dv.getUint32(12) - 1) * 86400000 + dv.getUint32(16);
    var pos = 24;
    if (u8.length > 30 && u8[28] === 0x42 && u8[29] === 0x5a) {
      while (pos + 4 < u8.length) {
        var size = Math.abs(dv.getInt32(pos)); pos += 4;
        if (!size || u8[pos] !== 0x42 || u8[pos + 1] !== 0x5a) break;
        var res;
        try { res = bunzip(u8, pos, Math.min(u8.length, pos + size)); } catch (e) { st.warn = 'record skipped: ' + e.message; pos += size; continue; }
        parseMessages(res.data, st); pos += size;
      }
    } else parseMessages(u8.subarray(24), st);
    var sweeps = finishSweeps(st), v = st.vol || {};
    if (!sweeps.length) throw new Error(st.legacy ? 'Legacy (message 1) Level II files are not supported' : 'No radials found in file' + (st.warn ? ' (' + st.warn + ')' : ''));
    return { site: st.site || '????', lat: v.lat, lon: v.lon, alt: (v.siteAlt || 0) + (v.feed || 0), vcp: v.vcp || 0, time: sweeps[0].t0 || htime, headerTime: htime, sweeps: sweeps, warn: st.warn || null };
  }
  function transferList(vol) { var t = []; vol.sweeps.forEach(function (s) { t.push(s.az.buffer); for (var k in s.mom) t.push(s.mom[k].raw.buffer); }); return t; }
  return { bunzip: bunzip, decodeLevel2: decodeLevel2, transferList: transferList };
})();
if (typeof module !== 'undefined') module.exports = RWDecoder;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = function (ev) {
    try { var v = RWDecoder.decodeLevel2(new Uint8Array(ev.data.buf)); self.postMessage({ id: ev.data.id, vol: v }, RWDecoder.transferList(v)); }
    catch (e) { self.postMessage({ id: ev.data.id, error: String(e.message || e) }); }
  };
}
