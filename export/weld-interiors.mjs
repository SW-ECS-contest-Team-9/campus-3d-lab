// 실내(i| 노드) 정점 합치기: build-glb 는 실내 삼각형을 정점 공유 없이(삼각형마다 3점) 넣음 → 같은 자리·같은 색 정점을 하나로 합치고 색인으로.
// 그림은 그대로(위치·색이 같은 정점만 합침). 다른 노드는 손대지 않음.
// 사용: node export/weld-interiors.mjs [glb=native/assets/campus.glb] [출력=같은 파일]
import fs from 'node:fs';

const [inFile = 'native/assets/campus.glb', outFile = inFile] = process.argv.slice(2);
const buf = fs.readFileSync(inFile);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('glb 아님');
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
if (gltf.images?.length || gltf.buffers.length !== 1) throw new Error('그림·여러 버퍼는 다루지 않음');

const views = gltf.bufferViews.map((v) => Buffer.from(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)));
const viewOf = (a) => gltf.accessors[a].bufferView;
const shared = new Map();
for (const a of gltf.accessors) shared.set(a.bufferView, (shared.get(a.bufferView) ?? 0) + 1);
const read = (a, Typed, comps) => { const acc = gltf.accessors[a], b = views[acc.bufferView], o = acc.byteOffset ?? 0; return new Typed(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + acc.count * comps * Typed.BYTES_PER_ELEMENT)); };
const IDX = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array };

let before = 0, after = 0, meshes = 0;
for (const node of gltf.nodes) {
  if (!node.name?.startsWith('i|') || node.mesh == null) continue;
  for (const prim of gltf.meshes[node.mesh].primitives) {
    const at = prim.attributes;
    if (Object.keys(at).some((k) => k !== 'POSITION' && k !== 'COLOR_0') || prim.indices == null) throw new Error(`${node.name}: POSITION·COLOR_0·indices 만 다룸`);
    for (const a of [at.POSITION, at.COLOR_0, prim.indices]) if (shared.get(viewOf(a)) !== 1 || gltf.accessors[a].byteOffset) throw new Error(`${node.name}: 버퍼 보기를 함께 씀`);
    if (gltf.accessors[at.COLOR_0].componentType !== 5121) throw new Error(`${node.name}: 색은 u8 만`);
    const n = gltf.accessors[at.POSITION].count;
    const P = read(at.POSITION, Float32Array, 3), C = read(at.COLOR_0, Uint8Array, 4);
    const I = read(prim.indices, IDX[gltf.accessors[prim.indices].componentType], 1);
    const map = new Map(), remap = new Uint32Array(n), pos = [], col = [];
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(P[3 * i] * 1e4)},${Math.round(P[3 * i + 1] * 1e4)},${Math.round(P[3 * i + 2] * 1e4)},${C[4 * i]},${C[4 * i + 1]},${C[4 * i + 2]},${C[4 * i + 3]}`;
      let j = map.get(k);
      if (j === undefined) { j = pos.length / 3; map.set(k, j); pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); col.push(C[4 * i], C[4 * i + 1], C[4 * i + 2], C[4 * i + 3]); }
      remap[i] = j;
    }
    const m = pos.length / 3;
    const idx = Array.from(I, (i) => remap[i]);
    const big = m > 65535;
    const p32 = new Float32Array(pos);
    views[viewOf(at.POSITION)] = Buffer.from(p32.buffer);
    views[viewOf(at.COLOR_0)] = Buffer.from(new Uint8Array(col).buffer);
    const ti = big ? new Uint32Array(idx) : new Uint16Array(idx);
    views[viewOf(prim.indices)] = Buffer.from(ti.buffer);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pos[3 * i + c]); mx[c] = Math.max(mx[c], pos[3 * i + c]); }
    Object.assign(gltf.accessors[at.POSITION], { count: m, min: mn, max: mx });
    gltf.accessors[at.COLOR_0].count = m;
    Object.assign(gltf.accessors[prim.indices], { componentType: big ? 5125 : 5123, count: idx.length });
    before += n; after += m; meshes++;
  }
}

// 버퍼 다시 쌓기(4바이트 맞춤)
const parts = [];
let off = 0;
gltf.bufferViews.forEach((v, i) => {
  const pad = (4 - (off % 4)) % 4;
  if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
  v.byteOffset = off; v.byteLength = views[i].length;
  parts.push(views[i]); off += views[i].length;
});
const binOut = Buffer.concat(parts);
const binPad = Buffer.concat([binOut, Buffer.alloc((4 - (binOut.length % 4)) % 4)]);
gltf.buffers[0].byteLength = binOut.length;
const js = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsPad = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsPad.length + 8 + binPad.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
fs.writeFileSync(outFile, Buffer.concat([head, ch(jsPad.length, 0x4e4f534a), jsPad, ch(binPad.length, 0x004e4942), binPad]));
console.log(`실내 ${meshes}개 메시: 정점 ${before} → ${after}, 파일 ${buf.length} → ${fs.statSync(outFile).size} 바이트`);
