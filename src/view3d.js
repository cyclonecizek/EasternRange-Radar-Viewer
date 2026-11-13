/* ===== view3d.js : 3-D volume view (isosurfaces, isotherm planes, flight path + standoff tubes, cross-section curtain) ===== */
var View3D = (function () {
  'use strict';
  var open = false, renderer, scene, camera, root, labels, cam = { az: -0.6, pol: 1.1, dist: 190, t: [0, 0, 8] }, o = { levels: [0, 18, 30, 45], ve: 2, radius: 60, alpha: 0.5, planes: true, tubes: true, ground: true, curtain: true, src: null }, need = false, C = [0, 0];
  /** marching cubes on a Uint8 grid sub-box; returns {pos, nor} Float32Arrays in km (x east, y north, z up) */
  function isosurface(G, iso, bx, st) {
    st = st || 1; var sp = G.spec, nx = sp.nx, nz = sp.nz, d = G.data, cap = 900000 * 9, pos = new Float32Array(1 << 18), nor = new Float32Array(1 << 18), np = 0, vx = new Float32Array(36), nrm = new Float32Array(36), cv = new Float32Array(8);
    var CX = [0, 1, 1, 0, 0, 1, 1, 0], CY = [0, 0, 1, 1, 0, 0, 1, 1], CZ = [0, 0, 0, 0, 1, 1, 1, 1], EA = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3], EB = [1, 2, 3, 0, 5, 6, 7, 4, 4, 5, 6, 7];
    function V(x, y, z) { return (x < 0 || y < 0 || z < 0 || x >= nx || y >= sp.ny || z >= nz) ? 0 : d[(y * nx + x) * nz + z]; }
    for (var iy = bx.y0; iy + st <= bx.y1 && np < cap; iy += st) for (var ix = bx.x0; ix + st <= bx.x1; ix += st) {
      var b00 = (iy * nx + ix) * nz, b10 = b00 + st * nz, b01 = b00 + st * nx * nz, b11 = b01 + st * nz;
      for (var iz = 0; iz < nz - 1; iz++) {
        cv[0] = d[b00 + iz]; cv[1] = d[b10 + iz]; cv[2] = d[b11 + iz]; cv[3] = d[b01 + iz]; cv[4] = d[b00 + iz + 1]; cv[5] = d[b10 + iz + 1]; cv[6] = d[b11 + iz + 1]; cv[7] = d[b01 + iz + 1];
        var ci = 0; for (var k = 0; k < 8; k++) if (cv[k] < iso) ci |= 1 << k;
        var bits = MC_EDGE[ci]; if (!bits) continue;
        for (var e = 0; e < 12; e++) if (bits & (1 << e)) {
          var a = EA[e], b = EB[e], va = cv[a], vb = cv[b], t = (iso - va) / (vb - va || 1), ax = ix + CX[a] * st, ay = iy + CY[a] * st, az = iz + CZ[a], bxx = ix + CX[b] * st, byy = iy + CY[b] * st, bz = iz + CZ[b];
          vx[e * 3] = sp.x0 + (ax + t * (bxx - ax)) * sp.dx; vx[e * 3 + 1] = sp.y0 + (ay + t * (byy - ay)) * sp.dx; vx[e * 3 + 2] = (az + t * (bz - az)) * sp.dz;
          var gx = (V(ax - st, ay, az) - V(ax + st, ay, az)) * (1 - t) + (V(bxx - st, byy, bz) - V(bxx + st, byy, bz)) * t, gy = (V(ax, ay - st, az) - V(ax, ay + st, az)) * (1 - t) + (V(bxx, byy - st, bz) - V(bxx, byy + st, bz)) * t, gz = ((V(ax, ay, az - 1) - V(ax, ay, az + 1)) * (1 - t) + (V(bxx, byy, bz - 1) - V(bxx, byy, bz + 1)) * t) * (sp.dx * st / sp.dz) / o.ve, gl = Math.hypot(gx, gy, gz) || 1;
          nrm[e * 3] = gx / gl; nrm[e * 3 + 1] = gy / gl; nrm[e * 3 + 2] = gz / gl;
        }
        for (var q = ci * 16; MC_TRI[q] !== -1; q++) {
          if (np + 3 > pos.length) { var p2 = new Float32Array(pos.length * 2), n2 = new Float32Array(pos.length * 2); p2.set(pos); n2.set(nor); pos = p2; nor = n2; }
          var ee = MC_TRI[q] * 3; pos[np] = vx[ee]; pos[np + 1] = vx[ee + 1]; pos[np + 2] = vx[ee + 2]; nor[np] = nrm[ee]; nor[np + 1] = nrm[ee + 1]; nor[np + 2] = nrm[ee + 2]; np += 3;
        }
      }
    }
    return { pos: pos.slice(0, np), nor: nor.slice(0, np), capped: np >= cap };
  }
  function label(text, color) { var c = document.createElement('canvas'); c.width = 256; c.height = 64; var x = c.getContext('2d'); x.font = 'bold 30px system-ui,sans-serif'; x.fillStyle = color || '#fff'; x.textBaseline = 'middle'; x.shadowColor = '#000'; x.shadowBlur = 6; x.fillText(text, 6, 32); var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false })); s.center.set(0, 0.5); return s; }
  function addLabel(text, x, y, z, color) { var s = label(text, color); s.position.set(x - C[0], y - C[1], z * o.ve); s.userData.k = 1; labels.add(s); }
  function clear(g) { while (g.children.length) { var m = g.children.pop(); if (m.geometry) m.geometry.dispose(); if (m.material) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); } } }
  function init() {
    var cv = $('v3dcanvas'); renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true }); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setClearColor(0x070a0e);
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4000); camera.up.set(0, 0, 1);
    scene.add(new THREE.AmbientLight(0xffffff, 0.62)); var dl = new THREE.DirectionalLight(0xffffff, 0.75); dl.position.set(-0.5, -0.8, 1.2); scene.add(dl);
    root = new THREE.Group(); labels = new THREE.Group(); scene.add(root); scene.add(labels);
    var down = null; cv.addEventListener('mousedown', function (e) { down = { x: e.clientX, y: e.clientY, az: cam.az, pol: cam.pol, t: cam.t.slice(), pan: e.button !== 0 || e.shiftKey }; e.preventDefault(); }); cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (!down || !open) return; var dx = e.clientX - down.x, dy = e.clientY - down.y; if (down.pan) { var k = cam.dist / 700, ca = Math.cos(cam.az), sa = Math.sin(cam.az); cam.t[0] = down.t[0] - (dx * ca + dy * sa * Math.cos(cam.pol)) * k; cam.t[1] = down.t[1] - (dx * sa - dy * ca * Math.cos(cam.pol)) * k; cam.t[2] = Math.max(0, down.t[2] + dy * Math.sin(cam.pol) * k * 0.6); } else { cam.az = down.az - dx * 0.006; cam.pol = Math.max(0.05, Math.min(1.55, down.pol - dy * 0.005)); } render(); });
    window.addEventListener('mouseup', function () { down = null; });
    cv.addEventListener('wheel', function (e) { e.preventDefault(); cam.dist = Math.max(8, Math.min(1500, cam.dist * Math.exp(e.deltaY * 0.0012))); render(); }, { passive: false });
    window.addEventListener('resize', function () { if (open) render(); });
  }
  function render() {
    if (!open || need) return; need = true; requestAnimationFrame(function () {
      need = false; var cv = $('v3dcanvas'), w = cv.clientWidth, hh = cv.clientHeight; if (cv.width !== w * renderer.getPixelRatio() || cv.height !== hh * renderer.getPixelRatio()) renderer.setSize(w, hh, false);
      camera.aspect = w / hh; camera.updateProjectionMatrix(); var sp = Math.sin(cam.pol);
      camera.position.set(cam.t[0] + cam.dist * sp * Math.sin(cam.az), cam.t[1] - cam.dist * sp * Math.cos(cam.az), cam.t[2] + cam.dist * Math.cos(cam.pol)); camera.lookAt(cam.t[0], cam.t[1], cam.t[2]);
      labels.children.forEach(function (s) { var d = camera.position.distanceTo(s.position) * 0.085; s.scale.set(d, d / 4, 1); }); renderer.render(scene, camera);
    });
  }
  function rebuild() {
    if (!open) return; clear(root); clear(labels); root.scale.set(1, 1, o.ve);
    var srcId = o.src || S.panels[0].src, frame = curFrame(srcId), G = gridOf(srcId, frame), R = o.radius, info = $('v3dinfo'); C = [S.view.cx, S.view.cy]; root.position.set(-C[0], -C[1], 0);
    /* ground: current product of panel 1 + basemap */
    if (o.ground) {
      var N = 1024, gc = document.createElement('canvas'); gc.width = gc.height = N; var g = gc.getContext('2d'), img = g.createImageData(N, N), view = { cx: C[0], cy: C[1], scale: N / (2 * R) };
      var save = S.opacity; renderRaster(new Uint32Array(img.data.buffer), N, N, view, Object.assign({}, S.panels[0], { src: srcId }), 1); S.opacity = save; g.fillStyle = '#0d1218'; g.fillRect(0, 0, N, N); var tmp = document.createElement('canvas'); tmp.width = tmp.height = N; tmp.getContext('2d').putImageData(img, 0, 0); g.globalAlpha = 0.85; g.drawImage(tmp, 0, 0); g.globalAlpha = 1;
      var P = function (x, y) { return [N / 2 + (x - C[0]) * view.scale, N / 2 - (y - C[1]) * view.scale]; }, line = function (a) { g.beginPath(); for (var k = 0; k < a.length; k += 2) { var p = P(a[k], a[k + 1]); if (k) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); } g.stroke(); };
      if (baseXY) { g.strokeStyle = 'rgba(150,165,185,.35)'; g.lineWidth = 1; baseXY.county.forEach(line); g.strokeStyle = 'rgba(235,242,250,.9)'; g.lineWidth = 1.6; baseXY.coast.forEach(line); g.fillStyle = '#fff'; g.font = '13px system-ui'; baseXY.sites.forEach(function (s) { var p = P(s.x, s.y); g.fillRect(p[0] - 2, p[1] - 2, 4, 4); if (R <= 80) g.fillText(s.n, p[0] + 5, p[1] + 4); }); }
      if (S.trajP) { g.strokeStyle = 'rgba(61,240,255,.6)'; g.setLineDash([6, 5]); g.lineWidth = 2; g.beginPath(); S.trajP.forEach(function (q, j) { var p = P(q.x, q.y); if (j) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.stroke(); g.setLineDash([]); }
      var gm = new THREE.Mesh(new THREE.PlaneGeometry(2 * R, 2 * R), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc) })); gm.position.set(C[0], C[1], 0); root.add(gm);
    }
    var ntri = 0;
    if (G) {
      var sp = G.spec, bx = { x0: Math.max(0, Math.floor((C[0] - R - sp.x0) / sp.dx)), x1: Math.min(sp.nx - 1, Math.ceil((C[0] + R - sp.x0) / sp.dx)), y0: Math.max(0, Math.floor((C[1] - R - sp.y0) / sp.dx)), y1: Math.min(sp.ny - 1, Math.ceil((C[1] + R - sp.y0) / sp.dx)) }, ct = ctFor(prodDef('REF'));
      o.levels.forEach(function (lv, i) {
        var st = Math.max(1, Math.ceil((bx.x1 - bx.x0) / 130)), m = isosurface(G, RW.enc(lv) - 0.5, bx, st); if (!m.pos.length) return; ntri += m.pos.length / 9;
        var geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
        var c = RWC.colorAt(ct, lv + 0.01) || [200, 200, 200], last = i === o.levels.length - 1, mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255), transparent: true, opacity: last ? Math.min(1, o.alpha + 0.35) : o.alpha * (0.55 + 0.45 * i / o.levels.length), side: THREE.DoubleSide, depthWrite: last });
        var mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 10 + i; root.add(mesh);
      });
    }
    if (o.planes) S.tempLines.forEach(function (T) { var z = RW.heightOf(S.prof, T); if (!(z > 0 && z < 20)) return; var col = T === 0 ? 0xff6a6a : 0x6ac0ff, pm = new THREE.Mesh(new THREE.PlaneGeometry(2 * R, 2 * R), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })); pm.position.set(C[0], C[1], z); pm.renderOrder = 5; root.add(pm); var e = new THREE.LineSegments(new THREE.EdgesGeometry(pm.geometry), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 })); e.position.copy(pm.position); root.add(e); addLabel((T > 0 ? '+' : '') + T + ' °C  ' + fmtH(z), C[0] + R, C[1] - R, z, T === 0 ? '#ff9a9a' : '#9ad4ff'); });
    for (var kz = 0; kz <= 60; kz += 10) { var zz = kz * KFT; if (zz <= 20) addLabel(kz + ' kft', C[0] - R - 4, C[1] - R, zz, '#9db0c4'); }
    var ax = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(C[0] - R, C[1] - R, 0), new THREE.Vector3(C[0] - R, C[1] - R, 20)]), new THREE.LineBasicMaterial({ color: 0x7c8ea3 })); root.add(ax);
    if (S.trajP && S.trajP.length > 2) {
      var pts = S.trajP.filter(function (_, i) { return i % 2 === 0; }).map(function (q) { return new THREE.Vector3(q.x, q.y, q.z); }), curve = new THREE.CatmullRomCurve3(pts);
      root.add(new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, Math.max(0.12, R / 400), 8), new THREE.MeshBasicMaterial({ color: 0x3df0ff })));
      if (o.tubes) { var cols = [0xfff07a, 0xffbe46, 0xff5a5a]; S.llcc.standoffs.slice().sort(function (a, b) { return a - b; }).forEach(function (nm, i) { var tm = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length, nm * NMI, 28), new THREE.MeshBasicMaterial({ color: cols[i % 3], transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })); tm.renderOrder = 30 + i; root.add(tm); var wf = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, pts.length >> 3), nm * NMI, 14), new THREE.MeshBasicMaterial({ color: cols[i % 3], wireframe: true, transparent: true, opacity: 0.16, depthWrite: false })); root.add(wf); var p0 = S.trajP[0]; addLabel(nm + ' nmi', p0.x + nm * NMI, p0.y, 0.3, '#' + cols[i % 3].toString(16)); }); }
      var E = S.llccRes; if (E && E.any.at && isFinite(E.any.d)) { var tp = S.trajP[E.any.at.pt]; root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(tp.x, tp.y, tp.z), new THREE.Vector3(E.any.at.x, E.any.at.y, E.any.at.z)]), new THREE.LineBasicMaterial({ color: 0xff5fd0 }))); addLabel('nearest ' + fmtD(E.any.d), E.any.at.x, E.any.at.y, E.any.at.z, '#ff8fe0'); }
    }
    if (o.curtain && S.xs.open) { var path = xsPath(); if (path) { var W = 512, H = 256, cc = document.createElement('canvas'); cc.width = W; cc.height = H; var cx2 = cc.getContext('2d'), im = cx2.createImageData(W, H); renderXS(new Uint32Array(im.data.buffer), W, H, Object.assign({}, S.panels[0], { src: srcId }), path); cx2.putImageData(im, 0, 0); var n = path.length, pa = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = []; for (var i = 0; i < n; i++) { pa.set([path[i].x, path[i].y, 0, path[i].x, path[i].y, S.xs.top], i * 6); uv.set([i / (n - 1), 0, i / (n - 1), 1], i * 4); if (i < n - 1) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3); } var cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.BufferAttribute(pa, 3)); cg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); cg.setIndex(idx); var cm = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.02 })); cm.renderOrder = 8; root.add(cm); } }
    var ct2 = ctFor(prodDef('REF')); info.innerHTML = ''; info.appendChild(h('div', { text: frame ? (frame.site || S.sources[srcId].label) + ' · ' + fmtT(frame.time, true) + ' · ' + Math.round(ntri).toLocaleString() + ' triangles' : 'No data for this source at the displayed time' }));
    o.levels.forEach(function (lv) { var c = RWC.colorAt(ct2, lv + 0.01) || [200, 200, 200]; info.appendChild(h('span', { class: 'lv' }, [h('i', { style: 'background:rgb(' + c.map(Math.round).join(',') + ')' }), '≥ ' + lv + ' dBZ'])); });
    render();
  }
  function show() {
    if (typeof THREE === 'undefined') return toast('3-D library failed to load', 'err');
    $('v3d').classList.remove('hidden'); open = true;
    try { if (!renderer) init(); } catch (e) { open = false; $('v3d').classList.add('hidden'); return toast('This browser could not start WebGL: ' + e.message, 'err'); }
    cam.t = [0, 0, 6 * o.ve]; cam.dist = o.radius * 3.1; buildControls(); rebuild();
  }
  function hide() { open = false; $('v3d').classList.add('hidden'); }
  function buildControls() {
    var b = $('v3dctl'); b.innerHTML = '';
    var lv = h('input', { type: 'text', value: o.levels.join(', '), onchange: function () { var a = lv.value.split(/[ ,]+/).map(Number).filter(isFinite).sort(function (x, y) { return x - y; }); if (a.length) { o.levels = a.slice(0, 6); rebuild(); } } });
    b.appendChild(field('Source', sel(Object.keys(S.sources).map(function (k) { return [k, S.sources[k].label]; }), o.src || S.panels[0].src, function (v) { o.src = v; rebuild(); })));
    b.appendChild(field('Isosurfaces (dBZ)', lv));
    b.appendChild(field('Opacity', h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: o.alpha, oninput: function (e) { o.alpha = +e.target.value; rebuild(); } })));
    b.appendChild(field('Vertical exaggeration ×' + o.ve, h('input', { type: 'range', min: 1, max: 6, step: 0.5, value: o.ve, onchange: function (e) { o.ve = +e.target.value; buildControls(); rebuild(); } })));
    b.appendChild(field('Domain (around the 2-D map centre)', sel([[30, '±30 km'], [60, '±60 km'], [100, '±100 km'], [150, '±150 km']], o.radius, function (v) { o.radius = +v; cam.dist = o.radius * 3.1; rebuild(); })));
    [['planes', 'Isotherm planes'], ['tubes', 'Standoff tubes'], ['ground', 'Ground map + panel-1 product'], ['curtain', 'Cross-section curtain (when open)']].forEach(function (c) { b.appendChild(chk(o[c[0]], function (v) { o[c[0]] = v; rebuild(); }, c[1])); });
    b.appendChild(h('div', { class: 'row' }, [btn('Save image', function () { render(); setTimeout(function () { var a = h('a', { href: $('v3dcanvas').toDataURL('image/png'), download: 'radar3d.png' }); a.click(); }, 80); }), btn('Close', hide, 'pri')]));
    b.appendChild(note('Drag to orbit, Shift-drag or right-drag to pan, wheel to zoom. Heights are stretched by the exaggeration factor; standoff tubes are true-distance surfaces drawn in the same stretched space.'));
  }
  return { show: show, hide: hide, rebuild: rebuild, isOpen: function () { return open; }, _iso: isosurface, opts: o };
})();
