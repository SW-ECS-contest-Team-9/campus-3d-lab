// 시험: WebGL2 그대로, 기본 antialias 만 끔(Cesium 의 MSAA 는 그대로 — 차이 비교용).
window.__c3dEvents = [];
(function () {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (type === 'webgl2' || type === 'webgl') opts = Object.assign({}, opts, { antialias: false });
    return orig.call(this, type, opts);
  };
  // MSAA 렌더버퍼 표본 수를 0 으로(드라이버 문제 확인용)
  if (window.WebGL2RenderingContext) {
    const rbm = WebGL2RenderingContext.prototype.renderbufferStorageMultisample;
    WebGL2RenderingContext.prototype.renderbufferStorageMultisample = function (t, s, f, w, h) { return this.renderbufferStorage(t, f, w, h); };
    const bl = WebGL2RenderingContext.prototype.blitFramebuffer;
  }
})();
