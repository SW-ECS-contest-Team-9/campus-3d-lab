// 시험 (c): WebGL2 를 막아 Cesium 이 WebGL1 로 내려가게 하고(MSAA 도 꺼짐), 기본 antialias 끔.
window.__c3dEvents = [];
(function () {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (type === 'webgl2') return null;
    if (type === 'webgl' || type === 'experimental-webgl') opts = Object.assign({}, opts, { antialias: false });
    return orig.call(this, type, opts);
  };
})();
