// 불러오기 단계 시간: fetch 끝난 시각과 크기를 콘솔로(LAB CONSOLE 로 남음).
window.__c3dEvents = [];
(function () {
  const t0 = performance.now(), f = window.fetch;
  window.fetch = function (u) { return f.apply(this, arguments).then((r) => { const url = String(u.url || u); r.clone().arrayBuffer().then((b) => console.log('FETCH ' + Math.round(performance.now() - t0) + 'ms ' + url.replace(location.origin, '') + ' ' + b.byteLength)); return r; }); };
  let n = 0, last = performance.now();
  (function f2(t) { if (t - last > 400) console.log('LONGFRAME ' + Math.round(last - t0) + '..' + Math.round(t - t0) + 'ms'); last = t; if (++n < 4000) requestAnimationFrame(f2); })(last);
})();
