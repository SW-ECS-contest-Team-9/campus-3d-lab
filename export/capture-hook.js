// 내보내기용 가로채기: client3d 가 window.Cesium 을 넣는 순간 PrimitiveCollection.add 와 바닥 그림을 가로채 둔다.
// 웹 모델링이 실제로 그리는 기하(건물·창·지붕, 구조물·캠퍼스 바닥, 길 면)를 그대로 받아 오기 위함(같은 코드, 같은 결과).
(function () {
  let C;
  const caught = [];
  window.__capture = { caught, ground: null };
  Object.defineProperty(window, 'Cesium', {
    configurable: true,
    get() { return C; },
    set(v) {
      C = v;
      const add = v.PrimitiveCollection.prototype.add;
      v.PrimitiveCollection.prototype.add = function (p, i) {
        if (p && p.geometryInstances) {
          caught.push({
            p,
            instances: [].concat(p.geometryInstances),
            translucent: !!(p.appearance && p.appearance.translucent),
            appearance: p.appearance && p.appearance.constructor && p.appearance.constructor.name,
            ground: p instanceof v.GroundPrimitive,
          });
        }
        return add.call(this, p, i);
      };
      const from = v.SingleTileImageryProvider.fromUrl;
      v.SingleTileImageryProvider.fromUrl = function (url, opts) {
        if (!window.__capture.ground) window.__capture.ground = { url: String(url), rect: opts && opts.rectangle ? [opts.rectangle.west, opts.rectangle.south, opts.rectangle.east, opts.rectangle.north] : null };
        return from.apply(this, arguments);
      };
    },
  });

  // 가로챈 것을 하나의 이진 덩어리로: 머리(JSON) + 자료. 좌표는 캠퍼스 가운데의 동·북·위(m) float32.
  window.__captureDump = function (lon, lat, h) {
    const enu = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(lon, lat, h));
    const inv = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
    const rot = C.Matrix4.getMatrix3(inv, new C.Matrix3());
    const groups = [];
    const chunks = [];
    let offset = 0;
    const push = (typed) => {
      const b = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      const pad = (4 - (b.byteLength % 4)) % 4;
      chunks.push(b);
      if (pad) chunks.push(new Uint8Array(pad));
      const o = offset;
      offset += b.byteLength + pad;
      return [o, b.byteLength];
    };
    const s = new C.Cartesian3();
    for (const c of caught) {
      if (c.p.isDestroyed() || c.p.show === false) continue;
      for (const inst of c.instances) {
        let g = inst.geometry;
        if (!g) continue;
        let mode = 'tri';
        if (!(g instanceof C.Geometry)) {
          const ctor = g.constructor;
          if (ctor === C.PolylineGeometry || ctor === C.SimplePolylineGeometry || ctor === C.GroundPolylineGeometry) {
            const pts = g._positions || [];
            g = { attributes: { position: { values: new Float64Array(pts.flatMap((q) => [q.x, q.y, q.z])) } }, indices: null };
            mode = 'strip';
          } else {
            try { g = ctor.createGeometry(g); } catch (e) { g = null; }
            if (!g) continue;
          }
        }
        const pv = g.attributes.position.values;
        const n = pv.length / 3;
        if (!n) continue;
        const mm = inst.modelMatrix && !C.Matrix4.equals(inst.modelMatrix, C.Matrix4.IDENTITY) ? inst.modelMatrix : null;
        const pos = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          s.x = pv[3 * k]; s.y = pv[3 * k + 1]; s.z = pv[3 * k + 2];
          if (mm) C.Matrix4.multiplyByPoint(mm, s, s);
          C.Matrix4.multiplyByPoint(inv, s, s);
          pos[3 * k] = s.x; pos[3 * k + 1] = s.y; pos[3 * k + 2] = s.z;
        }
        const out = { mode, n, translucent: c.translucent, appearance: c.appearance, ground: c.ground, id: null, color: null };
        try { out.id = inst.id == null ? null : JSON.parse(JSON.stringify(inst.id)); } catch (e) { out.id = String(inst.id); }
        const ic = inst.attributes && inst.attributes.color;
        if (ic && ic.value) out.color = Array.from(ic.value);
        out.pos = push(pos);
        const nv = g.attributes.normal && g.attributes.normal.values;
        if (nv && nv.length === n * 3) {
          const nn = new Float32Array(n * 3);
          for (let k = 0; k < n; k++) {
            s.x = nv[3 * k]; s.y = nv[3 * k + 1]; s.z = nv[3 * k + 2];
            if (mm) C.Matrix4.multiplyByPointAsVector(mm, s, s);
            C.Matrix3.multiplyByVector(rot, s, s);
            C.Cartesian3.normalize(s, s);
            nn[3 * k] = s.x; nn[3 * k + 1] = s.y; nn[3 * k + 2] = s.z;
          }
          out.nrm = push(nn);
        }
        const cv = g.attributes.color && g.attributes.color.values;
        if (cv && cv.length === n * 4) {
          const cc = new Uint8Array(n * 4);
          const f = cv instanceof Float32Array || cv instanceof Float64Array ? 255 : 1;
          for (let k = 0; k < n * 4; k++) cc[k] = Math.round(cv[k] * f);
          out.col = push(cc);
        }
        if (g.indices && g.indices.length) out.idx = push(new Uint32Array(g.indices));
        if (g.primitiveType === C.PrimitiveType.LINES) out.mode = 'lines';
        groups.push(out);
      }
    }
    const blob = new Uint8Array(offset);
    let o = 0;
    for (const b of chunks) { blob.set(b, o); o += b.byteLength; }
    window.__captureBlob = blob;
    return JSON.stringify({ origin: [lon, lat, h], groups, bytes: offset, ground: window.__capture.ground && { rect: window.__capture.ground.rect } });
  };
  window.__captureChunk = function (start, len) {
    const b = window.__captureBlob.subarray(start, start + len);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };
})();
