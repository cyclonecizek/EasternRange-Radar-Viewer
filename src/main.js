/* ===== main.js : wiring ===== */
(function () {
  loadSettings(); buildBase(); buildTabs(); renderTab(); buildPanels(); updateTimebar(); updateWelcome();
  $('helpbtn').addEventListener('click', function () { showHelp(true); });
  $('npanels').value = S.npanels; $('npanels').addEventListener('change', function () { S.npanels = +this.value; buildPanels(); drawXS(); });
  $('toolxs').addEventListener('click', function () { setTool(S.tool === 'xs' ? 'pan' : 'xs'); if (S.tool === 'xs') toast('Now drag a line across the map'); });
  $('xsbtn').addEventListener('click', function () { openXS(!S.xs.open); }); $('xsclose').addEventListener('click', function () { openXS(false); });
  $('xsmode').addEventListener('change', function () { S.xs.mode = this.value; invalidate(); drawXS(); });
  $('xsinterp').addEventListener('change', function () { S.xs.interp = this.value === '1'; drawXS(); });
  $('xstop').addEventListener('change', function () { var v = parseFloat(this.value); if (v > 2) { S.xs.top = v * KFT; drawXS(); } });
  $('btn3d').addEventListener('click', function () { View3D.show(); });
  $('tslider').addEventListener('input', function () { setTimeIdx(+this.value); });
  $('prev').addEventListener('click', function () { stepTime(-1); }); $('next').addEventListener('click', function () { stepTime(1); }); $('play').addEventListener('click', togglePlay);
  $('live').addEventListener('change', function () { setLive(this.checked); });
  window.addEventListener('resize', function () { invalidate(); drawXS(); });
  window.addEventListener('keydown', function (e) {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') stepTime(-1); else if (e.key === 'ArrowRight') stepTime(1); else if (e.key === ' ') { togglePlay(); e.preventDefault(); } else if (e.key === 'Escape') { View3D.hide(); setTool('pan'); showHelp(false); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { var P = S.panels[0], ui = panelsUI[0], n = ui.tilt.options.length; if (n) { P.tilt = Math.max(0, Math.min(n - 1, P.tilt + (e.key === 'ArrowUp' ? 1 : -1))); S.panels.forEach(function (q, i) { if (i && q.src === P.src) q.tilt = P.tilt; }); panelsUI.forEach(function (u) { fillTilt(u, S.panels[u.pi]); }); invalidate(); e.preventDefault(); } }
  });
  ['dragover', 'dragenter'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add('dragging'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.remove('dragging'); }); });
  window.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files); });
  window.RWApp = { S: S, ingestFiles: ingestFiles, afterData: afterData, invalidate: invalidate };
})();
