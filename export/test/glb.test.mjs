// 변환 시험: native/assets/campus.glb 가 앱이 기대하는 모양인지(이름 규칙·숨김·크기·좌표).
// 사용: node --test export/test   (먼저 export/build-glb.mjs 로 만든 뒤)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { makeFrame, tmForward, tmInverse } from '../geo.mjs';

const buf = fs.readFileSync(new URL('../../native/assets/campus.glb', import.meta.url));
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = buf.subarray(20 + jsonLen + 8);

test('GLB 머리와 크기(30 MB 미만)', () => {
  assert.equal(buf.readUInt32LE(0), 0x46546c67);
  assert.equal(buf.readUInt32LE(4), 2);
  assert.equal(buf.readUInt32LE(8), buf.length);
  assert.ok(buf.length < 30 * 1024 * 1024, `${buf.length} B`);
});

test('그림 없음(RN GLTFLoader 가 Image/Blob 없이 읽게)', () => {
  assert.ok(!gltf.images?.length && !gltf.textures?.length);
});

test('노드 이름 규칙: ground·structures·surfaces·건물 b|·층 f|(숨김)', () => {
  const names = gltf.nodes.map((n) => n.name);
  for (const n of ['ground', 'structures', 'surfaces', 'lines']) assert.ok(names.includes(n), n);
  const b = gltf.nodes.filter((n) => n.name.startsWith('b|'));
  const f = gltf.nodes.filter((n) => n.name.startsWith('f|'));
  assert.ok(b.length >= 30, `건물 ${b.length}`);
  assert.ok(f.length >= 100, `층 ${f.length}`);
  for (const n of b) assert.ok(n.extras?.id && n.extras?.name, n.name);
  for (const n of f) { assert.equal(n.extras.hidden, true); assert.ok(Number.isFinite(n.extras.m)); assert.ok(gltf.nodes.some((x) => x.extras?.id === n.extras.building), n.name); }
});

test('실내 i|: 숨김, 층 높이·바깥선 있음, 한 층 64 KB 미만, 단면(안쪽만 보임)', () => {
  const ii = gltf.nodes.filter((n) => n.name.startsWith('i|'));
  assert.ok(ii.length >= 50, `실내 ${ii.length}`);
  for (const n of ii) {
    assert.equal(n.extras.hidden, true);
    assert.ok(Number.isFinite(n.extras.m) && n.extras.rings?.length && n.extras.interior, n.name);
    const p = gltf.meshes[n.mesh].primitives[0];
    assert.equal(gltf.materials[p.material].doubleSided, false, n.name);
    const a = gltf.accessors[p.attributes.POSITION];
    assert.ok(a.min[1] > n.extras.m - 0.5 && a.max[1] < n.extras.m + 3, `${n.name} y ${a.min[1]}..${a.max[1]}`);
    const bytes = Object.values(p.attributes).concat([p.indices]).reduce((s2, i) => s2 + gltf.bufferViews[gltf.accessors[i].bufferView].byteLength, 0);
    assert.ok(bytes < 64 * 1024, `${n.name} ${bytes}`);
  }
});

test('층 판 하나는 작음(16 KB 미만)', () => {
  for (const n of gltf.nodes.filter((x) => x.name.startsWith('f|'))) {
    const p = gltf.meshes[n.mesh].primitives[0];
    const bytes = Object.values(p.attributes).concat([p.indices]).reduce((a, i) => a + gltf.bufferViews[gltf.accessors[i].bufferView].byteLength, 0);
    assert.ok(bytes < 16 * 1024, `${n.name} ${bytes}`);
  }
});

test('좌표: 건물 높이(y)는 해발 기단~지붕 안, 위치는 원점 1 km 안', () => {
  for (const n of gltf.nodes.filter((x) => x.name.startsWith('b|'))) {
    const a = gltf.accessors[gltf.meshes[n.mesh].primitives[0].attributes.POSITION];
    assert.ok(a.min[1] > n.extras.baseM - 15 && a.max[1] < n.extras.roofM + 15, `${n.name} y ${a.min[1]}..${a.max[1]} (${n.extras.baseM}..${n.extras.roofM})`);
    assert.ok(Math.hypot(a.max[0], a.max[2]) < 1000 && Math.hypot(a.min[0], a.min[2]) < 1000, n.name);
  }
});

test('geo: EPSG:5186 왕복과 원점 변환', () => {
  const p = tmForward(37.615, 127.0127);
  const g = tmInverse(p.x, p.y);
  assert.ok(Math.abs(g.latitude - 37.615) < 1e-8 && Math.abs(g.longitude - 127.0127) < 1e-8);
  const [lon0, lat0] = gltf.extras.origin;
  const f = makeFrame(lon0, lat0);
  const o = f.fromLonLat(lon0, lat0, 100);
  assert.ok(Math.abs(o[0]) < 1e-6 && Math.abs(o[1] - 100) < 1e-6 && Math.abs(o[2]) < 1e-6);
  const north = f.fromLonLat(lon0, lat0 + 0.001, 0);
  assert.ok(north[2] < -100 && Math.abs(north[0]) < 0.01, '북쪽은 −z');
  void bin;
});
