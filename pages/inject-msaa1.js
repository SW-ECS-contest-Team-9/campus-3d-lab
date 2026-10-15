// 고침 확인용: client3d 가 window.Cesium 을 넣는 순간 Scene 에 msaaSamples=1 을 걸어 둠(페이지 코드 변경과 같은 효과).
window.__c3dEvents = [];
(function () {
  let C;
  Object.defineProperty(window, 'Cesium', {
    configurable: true,
    get() { return C; },
    set(v) {
      C = v;
      const orig = v.Scene.prototype.initializeFrame;
      v.Scene.prototype.initializeFrame = function () { if (!this.__msaaFixed) { this.__msaaFixed = true; this.msaaSamples = 1; console.log('MSAA_FIX applied'); } return orig.apply(this, arguments); };
    },
  });
})();
