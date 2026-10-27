// 가로챈 웹 모델링 기하(out/capture.*) + 지형 격자 + 층 자료 → 모바일용 campus.glb 하나와 크기 보고서.
// 사용: node export/build-glb.mjs [서버=http://127.0.0.1:5291] [출력=native/assets/campus.glb]
// 노드 이름 규칙(앱이 읽음):
//   ground            지형(바닥 그림을 정점 색으로, 캠퍼스 밖 포함), 0.3 m 내려 구조물 바닥과 겹치지 않게
//   structures        기단·계단·벽·캠퍼스 바닥(빛 없음, 웹과 같이 flat)
//   surfaces          길 면(빛 없음)
//   lines             길·구역 테두리 선
//   b|<buildingId>    건물 하나(덩어리+창·지붕, 빛 받음). extras: { name, baseM, roofM }
//   f|<buildingId>|<i> 층 판(처음엔 숨김). extras: { name, m, building }
//   i|<동>|<층 높이>   실내 빈 곳(복도·로비·계단·승강기) 한 층: 바닥+벽+천장, 안쪽만 보임(처음엔 숨김, 1인칭용).
//                      extras: { interior: 동, m, floor, rings: [[x,y]…](EPSG:5186, 합친 바깥선) }
import fs from 'node:fs';
import path from 'node:path';
import earcut from '../vendor/tracker/node_modules/earcut/src/earcut.js';
import { makeFrame, tmForward } from './geo.mjs';
import { createRequire } from 'node:module';
const ClipperLib = createRequire(import.meta.url)('../vendor/tracker/node_modules/clipper-lib/clipper.js');

const [server = 'http://127.0.0.1:5291', outFile = 'native/assets/campus.glb'] = process.argv.slice(2);
// 실내 자료(사2, 동 노트에서 만든 것). 읽기만 함.
const INTERIORS = process.env.INTERIORS ?? 'C:/campus-tracker-claude/frontend/public/interiors.geojson';
const meta = JSON.parse(fs.readFileSync('out/capture.json', 'utf8'));
const bin = fs.readFileSync('out/capture.bin');
const [lon0, lat0] = meta.origin;
const frame = makeFrame(lon0, lat0);
const view = (ref, T) => (ref ? new T(bin.buffer, bin.byteOffset + ref[0], ref[1] / T.BYTES_PER_ELEMENT) : null);

/** 메시 모음: 정점(float32 x,y,z — glTF 축), 법선(선택), 색(uint8 rgba), 색인 */
class MeshBuilder {
  constructor(mode = 4) { this.mode = mode; this.pos = []; this.nrm = []; this.col = []; this.idx = []; this.n = 0; this.hasNormals = null; }
  add(pos, nrm, col, idx) {
    const base = this.n, n = pos.length / 3;
    for (let i = 0; i < n; i++) {
      // 가로챈 좌표는 동·북·위 → glTF (동, 위, −북)
      this.pos.push(pos[3 * i], pos[3 * i + 2], -pos[3 * i + 1]);
      if (nrm) this.nrm.push(nrm[3 * i], nrm[3 * i + 2], -nrm[3 * i + 1]);
      this.col.push(col(i));
    }
    if (idx) for (const k of idx) this.idx.push(base + k);
    else for (let i = 0; i < n; i++) this.idx.push(base + i);
    this.n += n;
  }
}

const buildings = new Map();
const structures = new MeshBuilder();
const surfaces = new MeshBuilder();
const lines = new MeshBuilder(1);
const stats = { groups: meta.groups.length, skipped: 0 };
for (const g of meta.groups) {
  const pos = view(g.pos, Float32Array), nrm = view(g.nrm, Float32Array), col = view(g.col, Uint8Array), idx = view(g.idx, Uint32Array);
  const ic = g.color ?? [200, 200, 200, 255];
  const colour = col ? (i) => [col[4 * i], col[4 * i + 1], col[4 * i + 2], col[4 * i + 3]] : () => ic;
  if (g.mode === 'strip') {
    const segs = [];
    for (let i = 0; i + 1 < g.n; i++) segs.push(i, i + 1);
    lines.add(pos, null, colour, segs);
    continue;
  }
  if (g.mode !== 'tri') { stats.skipped++; continue; }
  const kind = g.id && typeof g.id === 'object' ? g.id.kind : null;
  if (kind === 'building') {
    const id = g.id.buildingId;
    if (!buildings.has(id)) buildings.set(id, new MeshBuilder());
    // 덩어리(법선 있음)와 창·지붕(법선 있음)을 한 메시로. 법선 없는 것이 섞이면 위쪽 법선.
    const b = buildings.get(id);
    b.add(pos, nrm ?? new Float32Array(g.n * 3).map((_, k) => (k % 3 === 2 ? 1 : 0)), colour, idx);
  } else if (kind === 'structure') structures.add(pos, null, colour, idx);
  else surfaces.add(pos, null, colour, idx);
}

// ---------- 지형: 격자(2 m) 를 4 m 로 솎아 바닥 그림을 입힘 ----------
const res = await fetch(`${server}/api/v1/terrain/grid`);
const grid = JSON.parse(res.headers.get('X-Grid'));
const heights = new Float32Array(await res.arrayBuffer());
const STEP = 2;
// out/ground.rgba: 바닥 그림을 RGBA 로 푼 것(export/ground-rgba.py)
const rgbaHead = JSON.parse(fs.readFileSync('out/ground.rgba.json', 'utf8'));
const ground = { pos: [], uv: [], idx: [], image: { w: rgbaHead.w, h: rgbaHead.h, data: fs.readFileSync('out/ground.rgba') } };
const [rw, rs, re, rn] = meta.ground.rect; // 라디안
// 웹 미리보기(structures-layer·road-surface-layer·scene-local-corrections)가 지형을 숨기는 곳과 같게: 캠퍼스 구역·기단·
// 지표면·terrain-clip 폴리곤 안은 지형을 그리지 않는다(세 점 다 안이면 삼각형 제거, 경계 삼각형은 안쪽 점을 내려 구조물 밑으로).
const scene0 = await (await fetch(`${server}/api/v1/scene`)).json();
const STRUCTURES_DIR = process.env.STRUCTURES_DIR ?? 'C:/campus-tracker-claude/frontend/public';
const clipPolys = []; // 각 항목: [outer, ...holes] (EPSG:5186 링)
const polysOf = (geom) => !geom ? [] : geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : []; // 선·점은 무시
for (const g of scene0.campus ?? []) {
  const geom = typeof g === 'string' ? JSON.parse(g) : g;
  for (const poly of polysOf(geom)) clipPolys.push(poly.map((ring) => ring.map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; })));
}
const clipTypes = new Set(['platform', 'surface']);
for (const file of fs.readdirSync(`${STRUCTURES_DIR}/structures`).filter((f) => f.endsWith('.geojson'))) {
  for (const f of JSON.parse(fs.readFileSync(`${STRUCTURES_DIR}/structures/${file}`, 'utf8')).features) {
    if (!clipTypes.has(f.properties?.type)) continue;
    for (const poly of polysOf(f.geometry)) clipPolys.push(poly);
  }
}
if (fs.existsSync(`${STRUCTURES_DIR}/corrections/terrain-clip-v1.geojson`)) {
  for (const f of JSON.parse(fs.readFileSync(`${STRUCTURES_DIR}/corrections/terrain-clip-v1.geojson`, 'utf8')).features) {
    for (const poly of polysOf(f.geometry)) clipPolys.push(poly);
  }
}
const ringHas = (x, y, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
const bboxes = clipPolys.map((poly) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; });
const clipped = (x, y) => clipPolys.some((poly, k) => { const b = bboxes[k]; return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && ringHas(x, y, poly[0]) && !poly.slice(1).some((h) => ringHas(x, y, h)); });
const HIDE_DROP_M = 1.5;

const cols = Math.floor((grid.width - 1) / STEP) + 1, rows = Math.floor((grid.height - 1) / STEP) + 1;
const hidden = new Uint8Array(cols * rows);
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const gi = i * STEP, gj = j * STEP;
    const x = grid.originX + (gi + 0.5) * grid.resolution, y = grid.originY + (gj + 0.5) * grid.resolution;
    const hide = clipped(x, y);
    hidden[j * cols + i] = hide ? 1 : 0;
    const h = heights[gj * grid.width + gi] - 0.3 - (hide ? HIDE_DROP_M : 0);
    const p = frame.fromTm(x, y, h);
    ground.pos.push(...p);
    // 바닥 그림의 경위도 사각형 안 위치(위쪽이 북)
    const llx = (x - grid.originX) / (grid.width * grid.resolution), lly = (y - grid.originY) / (grid.height * grid.resolution);
    ground.uv.push(llx, 1 - lly);
  }
}
let hiddenTris = 0;
for (let j = 0; j + 1 < rows; j++) for (let i = 0; i + 1 < cols; i++) {
  const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
  if (!(hidden[a] && hidden[b] && hidden[c])) ground.idx.push(a, b, c); else hiddenTris++;
  if (!(hidden[b] && hidden[d] && hidden[c])) ground.idx.push(b, d, c); else hiddenTris++;
}
console.log(`ground: clip polygons ${clipPolys.length}, hidden cells ${hidden.reduce((s, v) => s + v, 0)}/${hidden.length}, removed triangles ${hiddenTris}`);
void rw; void rs; void re; void rn;

// ---------- 층 판(층 펼치기·한 층 보기용) ----------
const scene = await (await fetch(`${server}/api/v1/scene`)).json();
const floorMeshes = [];
for (const b of scene.buildings) {
  const w = b.appearance?.windows;
  if (!w?.floorsM?.length) continue;
  const tris = [];
  for (const poly of b.geometry.coordinates) {
    const flat = [], holes = [];
    poly.forEach((ring, r) => { if (r) holes.push(flat.length / 2); for (const [lon, lat] of ring.slice(0, -1)) flat.push(lon, lat); });
    const t = earcut(flat, holes);
    tris.push({ flat, t, rings: poly });
  }
  w.floorsM.forEach((m, i) => {
    if (m < b.baseM - 6 || m >= b.roofM) return;
    const mb = new MeshBuilder();
    for (const { flat, t, rings } of tris) {
      const top = [];
      for (let k = 0; k < flat.length; k += 2) top.push(...frame.fromLonLat(flat[k], flat[k + 1], m + 0.05));
      // MeshBuilder 는 동·북·위 순 입력을 받으므로 되돌려 넣음
      const enu = [];
      for (let k = 0; k < top.length; k += 3) enu.push(top[k], -top[k + 2], top[k + 1]);
      mb.add(enu, new Float32Array(enu.length).map((_, k) => (k % 3 === 2 ? 1 : 0)), () => [236, 240, 247, 255], t);
      // 가장자리 띠(0.4 m)
      for (const ring of rings) {
        const pts = ring.map(([lon, lat]) => frame.fromLonLat(lon, lat, 0));
        for (let k = 0; k + 1 < pts.length; k++) {
          const [ax, , az] = pts[k], [bx, , bz] = pts[k + 1];
          const quad = [ax, -az, m + 0.05, bx, -bz, m + 0.05, bx, -bz, m - 0.35, ax, -az, m - 0.35];
          // 높이는 frame 의 위 성분(곡률 차 <2 cm, 무시)
          const nx = bz - az, ny = bx - ax, len = Math.hypot(nx, ny) || 1;
          mb.add(quad, new Float32Array([nx / len, ny / len, 0, nx / len, ny / len, 0, nx / len, ny / len, 0, nx / len, ny / len, 0]), () => [120, 132, 150, 255], [0, 1, 2, 0, 2, 3]);
        }
      }
    }
    floorMeshes.push({ name: `f|${b.buildingId}|${i}`, extras: { building: b.buildingId, name: w.floorNames?.[i] ?? `${i + 1}`, m }, mesh: mb });
  });
}

// ---------- 실내(1인칭): 동·층마다 빈 곳을 합쳐 벽, 빈 곳마다 바닥, 천장 ----------
// 벽 높이는 실내 문서(level-view)의 복도 상자 높이 2.7 m. 면은 안쪽(빈 곳 쪽)만 앞면 → 위에서 보면 속이 보이고 안에서는 막힘.
const ROOM_M = 2.7;
const interiorMeshes = [];
if (fs.existsSync(INTERIORS)) {
  const fc = JSON.parse(fs.readFileSync(INTERIORS, 'utf8'));
  const KIND = { corridor: [214, 208, 196, 255], lobby: [222, 214, 198, 255], link: [206, 214, 222, 255], stair: [186, 204, 228, 255], elevator: [214, 192, 232, 255] };
  const LIFT = { corridor: 0.02, link: 0.025, lobby: 0.03, stair: 0.04, elevator: 0.05 };
  const groups = new Map(); // `${동}|${m}` → { building, m, floor, polys: [{kind, rings}] }
  for (const f of fc.features) {
    const pr = f.properties, polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    pr.floorsM.forEach((m, i) => {
      const key = `${pr.building}|${m.toFixed(2)}`;
      if (!groups.has(key)) groups.set(key, { building: pr.building, m, floor: pr.floors[i], polys: [] });
      for (const rings of polys) groups.get(key).polys.push({ kind: pr.kind, rings });
    });
  }
  const S = 1000; // Clipper: 정수 mm
  const enu = (x, y, h) => { const q = frame.fromTm(x, y, h); return [q[0], -q[2], q[1]]; };
  // 삼각형 하나를 원하는 법선 쪽으로 감아 넣음(동·북·위 공간에서 판단 — MeshBuilder 의 축 바꿈은 회전이라 감김이 그대로)
  const tri = (out, a, b, c, want) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    out.push(...((n[0] * want[0] + n[1] * want[1] + n[2] * want[2]) >= 0 ? [a, b, c] : [a, c, b]));
  };
  for (const g of groups.values()) {
    const mb = new MeshBuilder();
    const push = (vs, col) => { if (vs.length) mb.add(vs.flat(), null, () => col, null); };
    const cp = new ClipperLib.Clipper();
    // 바닥(빈 곳마다, 종류 색)과 천장
    for (const { kind, rings } of g.polys) {
      const flat = [], holes = [];
      rings.forEach((ring, r) => { if (r) holes.push(flat.length / 2); for (const [x, y] of ring.slice(0, -1)) flat.push(x, y); });
      const t = earcut(flat, holes);
      const fl = [], ce = [], lift = LIFT[kind] ?? 0.02;
      for (let k = 0; k < t.length; k += 3) {
        const P = (j, h) => enu(flat[2 * t[k + j]], flat[2 * t[k + j] + 1], h);
        tri(fl, P(0, g.m + lift), P(1, g.m + lift), P(2, g.m + lift), [0, 0, 1]);
        tri(ce, P(0, g.m + ROOM_M), P(1, g.m + ROOM_M), P(2, g.m + ROOM_M), [0, 0, -1]);
      }
      push(fl, KIND[kind] ?? KIND.corridor);
      push(ce, [246, 245, 241, 255]);
      cp.AddPaths(rings.map((ring) => ring.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }))), ClipperLib.PolyType.ptSubject, true);
    }
    const sol = new ClipperLib.Paths();
    cp.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    // 벽: 합친 바깥선(바깥 고리는 반시계, 구멍은 시계 → 빈 곳은 언제나 진행 방향 왼쪽). 3 m 마다 판 색을 바꿔 깊이 단서.
    const rings = [];
    for (const path of sol) {
      const pts = path.map((q) => [q.X / S, q.Y / S]);
      rings.push(pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]));
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.05) continue;
        const left = [-(by - ay) / len, (bx - ax) / len, 0];
        const n = Math.max(1, Math.round(len / 3));
        for (let j = 0; j < n; j++) {
          const x0 = ax + ((bx - ax) * j) / n, y0 = ay + ((by - ay) * j) / n, x1 = ax + ((bx - ax) * (j + 1)) / n, y1 = ay + ((by - ay) * (j + 1)) / n;
          const a = enu(x0, y0, g.m), b = enu(x1, y1, g.m), c = enu(x1, y1, g.m + ROOM_M), d = enu(x0, y0, g.m + ROOM_M);
          const w = [];
          tri(w, a, b, c, left); tri(w, a, c, d, left);
          push(w, (j + k) % 2 ? [226, 230, 235, 255] : [238, 240, 243, 255]);
          // 걸레받이(0.12 m, 어둡게): 바닥과 벽 경계를 또렷하게
          const off = (p) => [p[0] + left[0] * 0.01, p[1] + left[1] * 0.01, p[2]];
          const e = off(enu(x0, y0, g.m + 0.12)), f2 = off(enu(x1, y1, g.m + 0.12));
          const sk = [];
          tri(sk, off(a), off(b), f2, left); tri(sk, off(a), f2, e, left);
          push(sk, [120, 128, 140, 255]);
        }
      }
    }
    interiorMeshes.push({ name: `i|${g.building}|${g.m.toFixed(2)}`, extras: { interior: g.building, m: g.m, floor: g.floor, rings }, mesh: mb });
  }
}

// ---------- glTF 쓰기 ----------
const gltf = { asset: { version: '2.0', generator: 'campus-3d-lab build-glb' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [], extensionsUsed: ['KHR_materials_unlit'] };
const parts = []; let byteLength = 0;
function bufferView(typed, target) {
  const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (byteLength % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); byteLength += pad; }
  gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: b.length, ...(target ? { target } : {}) });
  parts.push(b); byteLength += b.length;
  return gltf.bufferViews.length - 1;
}
function accessor(typed, type, componentType, count, extra = {}) {
  gltf.accessors.push({ bufferView: bufferView(typed, extra.target), componentType, count, type, ...(extra.normalized ? { normalized: true } : {}), ...(extra.min ? { min: extra.min, max: extra.max } : {}) });
  return gltf.accessors.length - 1;
}
const material = (name, unlit, opts = {}) => { gltf.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, ...(opts.texture != null ? { baseColorTexture: { index: opts.texture } } : {}) }, ...(unlit ? { extensions: { KHR_materials_unlit: {} } } : {}), doubleSided: !opts.single }); return gltf.materials.length - 1; };
const M_LIT = material('lit', false), M_UNLIT = material('unlit', true), M_INTERIOR = material('interior', true, { single: true });
function minmax(p) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]); } return { min: mn, max: mx }; }
const report = [];
function addMesh(name, mb, mat, extras, hidden) {
  if (!mb.n) return;
  const p = new Float32Array(mb.pos);
  const attributes = { POSITION: accessor(p, 'VEC3', 5126, mb.n, { target: 34962, ...minmax(p) }), COLOR_0: accessor(new Uint8Array(mb.col.flat()), 'VEC4', 5121, mb.n, { target: 34962, normalized: true }) };
  if (mb.nrm.length) attributes.NORMAL = accessor(new Float32Array(mb.nrm), 'VEC3', 5126, mb.n, { target: 34962 });
  const big = mb.n > 65535;
  const indices = accessor(big ? new Uint32Array(mb.idx) : new Uint16Array(mb.idx), 'SCALAR', big ? 5125 : 5123, mb.idx.length, { target: 34963 });
  gltf.meshes.push({ name, primitives: [{ attributes, indices, material: mat, mode: mb.mode }] });
  gltf.nodes.push({ name, mesh: gltf.meshes.length - 1, ...(extras ? { extras: { ...extras, hidden: !!hidden } } : hidden ? { extras: { hidden: true } } : {}) });
  gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  report.push({ name, vertices: mb.n, triangles: mb.mode === 4 ? mb.idx.length / 3 : 0, bytes: mb.n * (12 + 4 + (mb.nrm.length ? 12 : 0)) + mb.idx.length * (big ? 4 : 2) });
}
// 지형: 바닥 그림을 정점 색으로 구움(앱의 GLTFLoader 가 그림 디코딩 없이 읽게 — RN 에는 Image/Blob URL 이 없음)
{
  const img = ground.image;
  const p = new Float32Array(ground.pos), n = p.length / 3;
  const col = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    const u = Math.min(img.w - 1, Math.max(0, Math.round(ground.uv[2 * k] * (img.w - 1)))), v = Math.min(img.h - 1, Math.max(0, Math.round(ground.uv[2 * k + 1] * (img.h - 1))));
    const o = (v * img.w + u) * 4;
    col[4 * k] = img.data[o]; col[4 * k + 1] = img.data[o + 1]; col[4 * k + 2] = img.data[o + 2]; col[4 * k + 3] = 255;
  }
  const attributes = { POSITION: accessor(p, 'VEC3', 5126, n, { target: 34962, ...minmax(p) }), COLOR_0: accessor(col, 'VEC4', 5121, n, { target: 34962, normalized: true }) };
  const big = n > 65535;
  const indices = accessor(big ? new Uint32Array(ground.idx) : new Uint16Array(ground.idx), 'SCALAR', big ? 5125 : 5123, ground.idx.length, { target: 34963 });
  gltf.meshes.push({ name: 'ground', primitives: [{ attributes, indices, material: M_UNLIT }] });
  gltf.nodes.push({ name: 'ground', mesh: gltf.meshes.length - 1 }); gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  report.push({ name: 'ground', vertices: n, triangles: ground.idx.length / 3, bytes: n * 16 + ground.idx.length * (big ? 4 : 2) });
}
addMesh('structures', structures, M_UNLIT);
addMesh('surfaces', surfaces, M_UNLIT);
addMesh('lines', lines, M_UNLIT);
const sceneById = new Map(scene.buildings.map((b) => [b.buildingId, b]));
for (const [id, mb] of buildings) { const b = sceneById.get(id); addMesh(`b|${id}`, mb, M_LIT, { id, name: b?.name ?? id, baseM: b?.baseM, roofM: b?.roofM }); }
for (const f of floorMeshes) addMesh(f.name, f.mesh, M_LIT, f.extras, true);
for (const f of interiorMeshes) addMesh(f.name, f.mesh, M_INTERIOR, f.extras, true);
gltf.extras = { origin: meta.origin, grid: { originX: grid.originX, originY: grid.originY, resolution: grid.resolution, width: grid.width, height: grid.height }, frame: 'x=east, y=up(MSL m), z=-north; origin lon/lat at height 0', capturedFrom: `client3d (${process.env.CAPTURED_FROM ?? 'campus-tracker'}) + /api/v1/scene, /api/v1/terrain/grid + interiors.geojson` };
gltf.buffers.push({ byteLength });

const json = Buffer.from(JSON.stringify(gltf));
const jsonPad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
const binBuf = Buffer.concat(parts); const binPad = Buffer.alloc((4 - (binBuf.length % 4)) % 4);
const total = 12 + 8 + json.length + jsonPad.length + 8 + binBuf.length + binPad.length;
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length + jsonPad.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length + binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([header, jh, json, jsonPad, bh, binBuf, binPad]));
const sum = (f) => report.filter(f).reduce((a, r) => ({ v: a.v + r.vertices, t: a.t + r.triangles, b: a.b + r.bytes }), { v: 0, t: 0, b: 0 });
const summary = {
  file: outFile, bytes: total, groupsIn: stats.groups, skipped: stats.skipped,
  ground: sum((r) => r.name === 'ground'), structures: sum((r) => r.name === 'structures'), surfaces: sum((r) => r.name === 'surfaces'), lines: sum((r) => r.name === 'lines'),
  buildings: { count: buildings.size, ...sum((r) => r.name.startsWith('b|')) }, interiors: { count: interiorMeshes.length, ...sum((r) => r.name.startsWith('i|')) }, floors: { count: floorMeshes.length, ...sum((r) => r.name.startsWith('f|')), maxBytes: Math.max(...report.filter((r) => r.name.startsWith('f|')).map((r) => r.bytes)) },
};
fs.writeFileSync('out/size-report.json', JSON.stringify({ summary, nodes: report }, null, 1));
console.log(JSON.stringify(summary, null, 1));
