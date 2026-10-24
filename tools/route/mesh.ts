// 보행 그물 경로(아3): 서버 campus-backend mapdata/walkmesh.py 의 Mesh·MeshRouter·_Run·_pull 과 같은 계산.
// 걷는 면·길 띠를 정사각형 칸(가운데 꼭짓점으로 세모 넷)으로 덮은 격자(꾸러미 walkMeshes)를 다시 만들고,
// 정수 비용(mm × 방식별 칸 계수)으로 8×8 칸 구역 관문 표 + 꾸러미 길 그래프에서 A* 로 찾은 뒤 지난 구역만 풀어
// 같은 비용 칸만 지나는 직선으로 줄을 당긴다. 실내 층 바닥(kind floor)은 같은 층 실내 노드에만 붙고, 그물 사이 이음은
// 꾸러미 항목 seams(서버가 가져올 때 얇은 벽을 넘지 않게 고른 것)를 그대로 쓴다. 같은 꾸러미면 서버와 같은 길·거리·시간이 나온다
// (src/route/route.server.test.ts). 서버 쪽을 바꾸면 여기도 바꾸고 scripts/build-route-fixture.py 로 비교 자료를 다시 만든다.
// 파이썬과 같은 결과를 내려고 연산 순서·반복 순서·동점 처리(번호 작은 쪽)를 그대로 따른다.
// 기기에서 빠르게: 숫자 배열(Int32Array·Float64Array), 관문 표는 처음 쓰는 방식만 그때 만든다(서버는 한 번에 다 만듦,
// 표 안 간선 순서를 (출발, 도착) 순으로 맞춰 결과가 같다).
import type { EdgeIndicators, MapNode, ModeSpec, SurfaceTop, WalkMesh, WalkMeshClass, XYZ } from '../map/package';
import { basicIndicators, edgeCost, pyRound, type RouteEdge } from './cost';
import { pySum, surfaceZ } from './walk';

/** 서버 MODE_SPEC 순서(칸 등급 f 배열 순서). */
export const MESH_MODES = ['shortest', 'fastest', 'avoidStairs', 'accessible', 'preferElevator', 'rainProtected', 'nightSafe'];
const NM = MESH_MODES.length;
const BLOCK = 8;
const ENTRANCE_EVERY = 4;
const LOS_STEP = 0.25;
const ATTACH_CELLS = 1.5;
const ATTACH_MAX = 8;
const ATTACH_OUT_MAX = 2;
const STEP_OK_M = 0.2;
const AREA_DZ_M = 0.5;
const SURFACE_SAMPLE_M = 2.0;
const WALK_MIN_S_PER_M = 0.69;
const PPM = 1000000;
const S_BIT = 1,
  E_BIT = 2,
  N_BIT = 4,
  W_BIT = 8;

const mm = (d: number) => Math.floor(d * 1000 + 0.5);
function distMm(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax,
    dy = by - ay,
    dz = bz - az;
  return mm(Math.sqrt(dx * dx + dy * dy + dz * dz));
}
const scaled = (d: number, ppm: number) => Math.floor((d * ppm + PPM / 2) / PPM);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64bytes(s: string): Uint8Array {
  let end = s.length;
  while (end > 0 && s[end - 1] === '=') end--;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let o = 0,
    buf = 0,
    bits = 0;
  for (let i = 0; i < end; i++) {
    buf = ((buf << 6) | B64.indexOf(s[i])) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 255;
    }
  }
  return out;
}
export function decodeBits(s: string, n: number): Uint8Array {
  const b = b64bytes(s);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = (b[k >> 1] >> (4 * (k & 1))) & 15;
  return out;
}
export function decodeRuns(runs: number[], n: number): Int32Array {
  const out = new Int32Array(n);
  let o = 0;
  for (let k = 0; k < runs.length && o < n; k += 2) for (let r = 0; r < runs[k + 1] && o < n; r++) out[o++] = runs[k];
  return out;
}

/** 선(3D) 위 (x, y) 에서 가장 가까운 점의 높이(같으면 앞 조각). 서버 line_z. */
export function lineZ(geom: XYZ[], x: number, y: number): number {
  let best = Infinity,
    z = geom[0][2];
  for (let i = 1; i < geom.length; i++) {
    const a = geom[i - 1],
      b = geom[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const px = a[0] + t * dx,
      py = a[1] + t * dy;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < best) {
      best = d2;
      z = a[2] + t * (b[2] - a[2]);
    }
  }
  return z;
}

/** (비용, 번호) 최소 힙: 비용이 같으면 번호 작은 것(파이썬 heapq 튜플 순서). 숫자 배열 두 개. */
class PairHeap {
  c: number[] = [];
  v: number[] = [];
  get size() {
    return this.c.length;
  }
  private less(i: number, j: number) {
    return this.c[i] < this.c[j] || (this.c[i] === this.c[j] && this.v[i] < this.v[j]);
  }
  private swap(i: number, j: number) {
    const c = this.c[i],
      v = this.v[i];
    this.c[i] = this.c[j];
    this.v[i] = this.v[j];
    this.c[j] = c;
    this.v[j] = v;
  }
  push(c: number, v: number) {
    this.c.push(c);
    this.v.push(v);
    for (let i = this.c.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** 맨 위를 꺼내 popC·popV 에 둔다. */
  popC = 0;
  popV = 0;
  pop() {
    this.popC = this.c[0];
    this.popV = this.v[0];
    const lc = this.c.pop()!,
      lv = this.v.pop()!;
    if (this.c.length) {
      this.c[0] = lc;
      this.v[0] = lv;
      const n = this.c.length;
      for (let i = 0; ;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
  }
}

/** walkMeshes 항목 하나 → 꼭짓점·간선·구역. 서버 Mesh. */
export class Mesh {
  key: string;
  kind: string;
  entry: WalkMesh;
  cell: number;
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  cols: number;
  rows: number;
  codes: Uint8Array;
  cls: Int32Array;
  classes: WalkMeshClass[]; // 꾸러미 공용 표
  cf: Int32Array[]; // 방식 → 등급 → ppm (-1 = 못 지나감), 공용
  top: SurfaceTop | null;
  line: XYZ[] | null;
  nc: number;
  nv: number;
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
  ne: number;
  ea: Int32Array;
  eb: Int32Array;
  ec0: Int32Array; // 간선이 든 칸(둘째 칸 없으면 -1)
  ec1: Int32Array;
  eb0: Int32Array; // 간선이 든 구역(둘째 구역 없으면 -1, 오름차순)
  eb1: Int32Array;
  edist: Int32Array;
  eid = new Map<number, number>(); // 작은 꼭짓점·nv + 큰 꼭짓점 → 간선 번호
  adjStart: Int32Array; // 꼭짓점 v 의 간선: adjEdge[adjStart[v] .. adjStart[v+1]) (번호 순)
  adjEdge: Int32Array;
  vb: Int32Array; // 꼭짓점마다 속한 구역 넷까지(오름차순, -1 채움)
  nbx: number;
  blockCells = new Map<number, number[]>();
  rim: number[] = [];
  comp: Int32Array;
  bbox: [number, number, number, number];
  private eppmCache: (Int32Array | null)[] = new Array(NM).fill(null);
  private costCache: (Int32Array | null)[] = new Array(NM).fill(null);
  // 구역 안 다익스트라 쓰는 자리(한 번에 하나)
  sDist: Float64Array;
  sPrev: Int32Array;
  sStamp: Int32Array;
  sGen = 0;

  constructor(entry: WalkMesh, edgeGeom: (key: string) => XYZ[], classes: WalkMeshClass[], cf: Int32Array[]) {
    this.key = entry.key;
    this.kind = entry.kind ?? 'surface';
    this.entry = entry;
    this.cell = entry.cell;
    [this.ox, this.oy] = entry.origin;
    [this.ux, this.uy] = entry.axis;
    this.cols = entry.cols;
    this.rows = entry.rows;
    const cols = this.cols,
      rows = this.rows;
    const n = cols * rows;
    this.codes = decodeBits(entry.tris, n);
    this.cls = decodeRuns(entry.cls, n);
    this.classes = classes;
    this.cf = cf;
    this.top = entry.top ?? null;
    this.line = entry.edge ? edgeGeom(entry.edge) : null;
    const nc = (cols + 1) * (rows + 1);
    this.nc = nc;
    const nv = nc + n;
    this.nv = nv;
    this.xs = new Float64Array(nv);
    this.ys = new Float64Array(nv);
    this.zs = new Float64Array(nv);
    const { cell, ox, oy, ux, uy } = this;
    for (let v = 0; v < nv; v++) {
      let i: number, j: number;
      if (v < nc) {
        i = v % (cols + 1);
        j = Math.floor(v / (cols + 1));
      } else {
        const k = v - nc;
        i = (k % cols) + 0.5;
        j = Math.floor(k / cols) + 0.5;
      }
      const x = ox + cell * (i * ux - j * uy);
      const y = oy + cell * (i * uy + j * ux);
      this.xs[v] = x;
      this.ys[v] = y;
      this.zs[v] = this.z(x, y);
    }
    // 간선: 칸 순서, 세모 S·E·N·W, 변 (p,q)·(p,m)·(q,m) 처음 나온 순서로 번호
    const triN = new Int32Array(nv);
    const ea: number[] = [],
      eb: number[] = [],
      ec0: number[] = [],
      ec1: number[] = [];
    const eid = this.eid;
    const addEdge = (a: number, b: number, k: number) => {
      const lo = a < b ? a : b,
        hi = a < b ? b : a;
      const key = lo * nv + hi;
      const x = eid.get(key);
      if (x === undefined) {
        eid.set(key, ea.length);
        ea.push(lo);
        eb.push(hi);
        ec0.push(k);
        ec1.push(-1);
      } else if ((ec1[x] === -1 ? ec0[x] : ec1[x]) !== k) ec1[x] = k;
    };
    const tri = (p: number, q: number, m: number, k: number) => {
      triN[p]++;
      triN[q]++;
      triN[m]++;
      addEdge(p, q, k);
      addEdge(p, m, k);
      addEdge(q, m, k);
    };
    for (let k = 0; k < n; k++) {
      const c = this.codes[k];
      if (!c) continue;
      const i = k % cols,
        j = Math.floor(k / cols);
      const c00 = j * (cols + 1) + i;
      const c10 = c00 + 1,
        c01 = c00 + cols + 1;
      const c11 = c01 + 1;
      const m = nc + k;
      if (c & S_BIT) tri(c00, c10, m, k);
      if (c & E_BIT) tri(c10, c11, m, k);
      if (c & N_BIT) tri(c11, c01, m, k);
      if (c & W_BIT) tri(c01, c00, m, k);
    }
    const ne = ea.length;
    this.ne = ne;
    this.ea = Int32Array.from(ea);
    this.eb = Int32Array.from(eb);
    this.ec0 = Int32Array.from(ec0);
    this.ec1 = Int32Array.from(ec1);
    this.edist = new Int32Array(ne);
    for (let x = 0; x < ne; x++) {
      const a = ea[x],
        b = eb[x];
      this.edist[x] = distMm(this.xs[a], this.ys[a], this.zs[a], this.xs[b], this.ys[b], this.zs[b]);
    }
    const nbx = Math.floor((cols + BLOCK - 1) / BLOCK);
    this.nbx = nbx;
    const blockOf = (k: number) => Math.floor(Math.floor(k / cols) / BLOCK) * nbx + Math.floor((k % cols) / BLOCK);
    for (let k = 0; k < n; k++)
      if (this.codes[k]) {
        const b = blockOf(k);
        const l = this.blockCells.get(b);
        if (l) l.push(k);
        else this.blockCells.set(b, [k]);
      }
    this.eb0 = new Int32Array(ne);
    this.eb1 = new Int32Array(ne);
    for (let x = 0; x < ne; x++) {
      const b0 = blockOf(ec0[x]),
        b1 = ec1[x] < 0 ? b0 : blockOf(ec1[x]);
      this.eb0[x] = Math.min(b0, b1);
      this.eb1[x] = b0 === b1 ? -1 : Math.max(b0, b1);
    }
    // 이웃 간선 목록(CSR, 꼭짓점마다 간선 번호 순)
    this.adjStart = new Int32Array(nv + 1);
    for (let x = 0; x < ne; x++) {
      this.adjStart[ea[x] + 1]++;
      this.adjStart[eb[x] + 1]++;
    }
    for (let v = 0; v < nv; v++) this.adjStart[v + 1] += this.adjStart[v];
    this.adjEdge = new Int32Array(2 * ne);
    const fill = this.adjStart.slice(0, nv);
    for (let x = 0; x < ne; x++) {
      this.adjEdge[fill[ea[x]]++] = x;
      this.adjEdge[fill[eb[x]]++] = x;
    }
    // 꼭짓점 구역(넷까지, 오름차순)
    this.vb = new Int32Array(nv * 4).fill(-1);
    for (let v = 0; v < nv; v++) {
      let cnt = 0;
      for (let p = this.adjStart[v]; p < this.adjStart[v + 1]; p++) {
        const x = this.adjEdge[p];
        for (const b of [this.eb0[x], this.eb1[x]]) {
          if (b < 0) continue;
          let at = 0;
          while (at < cnt && this.vb[v * 4 + at] < b) at++;
          if (at < cnt && this.vb[v * 4 + at] === b) continue;
          for (let q = cnt; q > at; q--) this.vb[v * 4 + q] = this.vb[v * 4 + q - 1];
          this.vb[v * 4 + at] = b;
          cnt++;
        }
      }
    }
    for (let v = 0; v < nv; v++) if (triN[v] && triN[v] < (v < nc ? 8 : 4)) this.rim.push(v);
    this.comp = new Int32Array(nv).fill(-1);
    let nxt = 0;
    const stack: number[] = [];
    for (let v0 = 0; v0 < nv; v0++) {
      if (this.comp[v0] >= 0 || this.adjStart[v0] === this.adjStart[v0 + 1]) continue;
      this.comp[v0] = nxt;
      stack.push(v0);
      while (stack.length) {
        const u = stack.pop()!;
        for (let p = this.adjStart[u]; p < this.adjStart[u + 1]; p++) {
          const x = this.adjEdge[p];
          const w = this.ea[x] === u ? this.eb[x] : this.ea[x];
          if (this.comp[w] < 0) {
            this.comp[w] = nxt;
            stack.push(w);
          }
        }
      }
      nxt++;
    }
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      any = false;
    for (let v = 0; v < nv; v++)
      if (this.adjStart[v] < this.adjStart[v + 1]) {
        any = true;
        x0 = Math.min(x0, this.xs[v]);
        y0 = Math.min(y0, this.ys[v]);
        x1 = Math.max(x1, this.xs[v]);
        y1 = Math.max(y1, this.ys[v]);
      }
    this.bbox = any ? [x0, y0, x1, y1] : [0, 0, -1, -1];
    this.sDist = new Float64Array(nv);
    this.sPrev = new Int32Array(nv);
    this.sStamp = new Int32Array(nv);
  }

  hasEdges(v: number) {
    return this.adjStart[v] < this.adjStart[v + 1];
  }
  inBlock(v: number, b: number) {
    const o = v * 4;
    return this.vb[o] === b || this.vb[o + 1] === b || this.vb[o + 2] === b || this.vb[o + 3] === b;
  }
  vblocks(v: number): number[] {
    const out: number[] = [];
    for (let q = 0; q < 4 && this.vb[v * 4 + q] >= 0; q++) out.push(this.vb[v * 4 + q]);
    return out;
  }
  z(x: number, y: number): number {
    return this.line === null ? surfaceZ(this.top!, x, y) : lineZ(this.line, x, y);
  }
  /** 방식 → 간선마다 1 m 계수(닿는 칸 등급 가운데 가장 낮은 것, ppm, -1 = 못 지나감). */
  eppm(mi: number): Int32Array {
    let out = this.eppmCache[mi];
    if (!out) {
      const f = this.cf[mi];
      out = new Int32Array(this.ne);
      for (let x = 0; x < this.ne; x++) {
        let best = f[this.cls[this.ec0[x]]];
        if (this.ec1[x] >= 0) {
          const v = f[this.cls[this.ec1[x]]];
          if (v >= 0 && (best < 0 || v < best)) best = v;
        }
        out[x] = best;
      }
      this.eppmCache[mi] = out;
    }
    return out;
  }
  /** 방식 → 간선마다 정수 비용(-1 = 못 지나감). */
  cost(mi: number): Int32Array {
    let out = this.costCache[mi];
    if (!out) {
      const ep = this.eppm(mi);
      out = new Int32Array(this.ne);
      for (let x = 0; x < this.ne; x++) out[x] = ep[x] < 0 ? -1 : scaled(this.edist[x], ep[x]);
      this.costCache[mi] = out;
    }
    return out;
  }
  /** 꼭짓점 계수: 닿는 간선 가운데 가장 낮은 것(-1 = 없음). */
  vf(mi: number, v: number): number {
    const ep = this.eppm(mi);
    let best = -1;
    for (let p = this.adjStart[v]; p < this.adjStart[v + 1]; p++) {
      const f = ep[this.adjEdge[p]];
      if (f >= 0 && (best < 0 || f < best)) best = f;
    }
    return best;
  }
  xyz(v: number): XYZ {
    return [this.xs[v], this.ys[v], this.zs[v]];
  }
  local(x: number, y: number): [number, number] {
    const dx = x - this.ox,
      dy = y - this.oy;
    return [(dx * this.ux + dy * this.uy) / this.cell, (-dx * this.uy + dy * this.ux) / this.cell];
  }
  /** 쓸 수 있는 세모 위면 그 칸 번호, 격자 안이지만 못 쓰는 세모면 -1, 격자 밖이면 -2. locBit 에 세모 비트. */
  locBit = 0;
  locate(x: number, y: number): number {
    const dx = x - this.ox,
      dy = y - this.oy;
    const a = (dx * this.ux + dy * this.uy) / this.cell,
      b = (-dx * this.uy + dy * this.ux) / this.cell;
    const i = Math.floor(a),
      j = Math.floor(b);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -2;
    const u = a - i,
      w = b - j;
    this.locBit = w <= u ? (u + w <= 1 ? S_BIT : E_BIT) : u + w <= 1 ? W_BIT : N_BIT;
    return j * this.cols + i;
  }
  /** 쓸 수 있는 세모 위면 그 칸 번호, 아니면 -1. */
  usable(x: number, y: number): number {
    const k = this.locate(x, y);
    return k >= 0 && this.codes[k] & this.locBit ? k : -1;
  }
  nearVertices(x: number, y: number, r: number): number[] {
    const [a, b] = this.local(x, y);
    const k = Math.ceil(r / this.cell) + 1;
    const fa = Math.floor(a),
      fb = Math.floor(b);
    const r2 = r * r;
    const d2s: number[] = [],
      vs: number[] = [];
    const take = (v: number) => {
      if (!this.hasEdges(v)) return;
      const dx = this.xs[v] - x,
        dy = this.ys[v] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        d2s.push(d2);
        vs.push(v);
      }
    };
    for (let j = fb - k; j < fb + k + 2; j++)
      for (let i = fa - k; i < fa + k + 2; i++) {
        if (i >= 0 && i <= this.cols && j >= 0 && j <= this.rows) take(j * (this.cols + 1) + i);
        if (i >= 0 && i < this.cols && j >= 0 && j < this.rows) take(this.nc + j * this.cols + i);
      }
    const idx = vs.map((_, i) => i).sort((p, q) => d2s[p] - d2s[q] || vs[p] - vs[q]);
    return idx.map((i) => vs[i]);
  }
  /** p → q 직선이 쓸 수 있는 세모만 지나는가(붙이기용). */
  sees(px: number, py: number, qx: number, qy: number): boolean {
    const dx = qx - px,
      dy = qy - py;
    const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / (this.cell * LOS_STEP)));
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      if (this.usable(px + t * dx, py + t * dy) < 0) return false;
    }
    return true;
  }
  /** 구역 b 안 다익스트라(서버 block_search). 결과는 sDist·sPrev·sStamp(= sGen 이면 닿음)에 남는다. */
  blockSearch(b: number, seeds: Seed[], modeI: number) {
    const cost = this.cost(modeI);
    const gen = ++this.sGen;
    const { sDist, sPrev, sStamp } = this;
    const pq = new PairHeap();
    for (const [v, c] of seeds)
      if (sStamp[v] !== gen || c < sDist[v]) {
        sStamp[v] = gen;
        sDist[v] = c;
        sPrev[v] = -1;
        pq.push(c, v);
      }
    while (pq.size) {
      pq.pop();
      const d = pq.popC,
        v = pq.popV;
      if (d > sDist[v]) continue;
      for (let p = this.adjStart[v]; p < this.adjStart[v + 1]; p++) {
        const x = this.adjEdge[p];
        const c = cost[x];
        if (c < 0 || (this.eb0[x] !== b && this.eb1[x] !== b)) continue;
        const w = this.ea[x] === v ? this.eb[x] : this.ea[x];
        const nd = d + c;
        if (sStamp[w] !== gen || nd < sDist[w]) {
          sStamp[w] = gen;
          sDist[w] = nd;
          sPrev[w] = v;
          pq.push(nd, w);
        }
      }
    }
  }
  reached(v: number) {
    return this.sStamp[v] === this.sGen;
  }
}

const inBbox = (b: number[], x: number, y: number, r: number) => b[0] - r <= x && x <= b[2] + r && b[1] - r <= y && y <= b[3] + r;

type Seed = [number, number]; // (꼭짓점, 비용 또는 mm)
type Hit = [number, Seed[]]; // (그물, seeds)
type Info =
  | { t: 'edge'; e: RouteEdge }
  | { t: 'block'; mi: number; b: number }
  | { t: 'seam'; a: number; va: number; b: number; vb: number }
  | { t: 'qblock'; mi: number; b: number; which: number };
type AEdge = { to: number; info: Info; c: number }; // c: 정수 비용(길이면 -1, 그때 그때 계산)
type Ref = { k: 'n'; i: number } | { k: 'q'; i: number } | { k: 'v'; mi: number; v: number };
const refKey = (r: Ref) => (r.k === 'v' ? `v${r.mi}:${r.v}` : `${r.k}${r.i}`);
type Tmp = Map<number, { key: string; xyz: XYZ; hits: Hit[] }>;
type Link = [number, number, number, number, number]; // (그물 A, 꼭짓점, 그물 B, 꼭짓점, mm), A < B

/** 그물 길찾기가 쓰는 길 그래프(route.ts Graph 의 일부). */
export interface MeshGraph {
  nodes: MapNode[];
  /** 노드 key → [길, 다음 노드, 정방향인지] (서버 MapIndex.out 과 같은 순서) */
  out: (key: string) => { edge: RouteEdge; to: string; forward: boolean }[];
  ind: (e: RouteEdge) => EdgeIndicators;
  modes: Record<string, ModeSpec>;
  edgeGeom: (key: string) => XYZ[];
  nodeAt: (x: number, y: number, z: number) => MapNode | null;
  nearestNode: (x: number, y: number, z: number) => MapNode | null;
}

export type MeshEnd = { nodeKey: string; attached: 'node' | 'surface' | 'nearest_node'; areas?: string[] } | null;
export interface MeshRouteEdge {
  edge: RouteEdge;
  forward: boolean;
}
export interface MeshRoute {
  nodeKeys: string[];
  edges: MeshRouteEdge[];
  cost: number;
}

/** seeds 가운데 (구역 다익스트라 비용 + 붙이는 비용)이 가장 작은 것 [비용, 꼭짓점]. 같으면 앞 것. */
function best(M: Mesh, seeds: Seed[]): [number, number] | null {
  let out: [number, number] | null = null;
  for (const [v, c] of seeds) if (M.reached(v) && (out === null || M.sDist[v] + c < out[0])) out = [M.sDist[v] + c, v];
  return out;
}
const cmpNums = (p: number[], q: number[]) => {
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i];
  return 0;
};

export class MeshRouter {
  meshes: Mesh[];
  covered = new Set<string>();
  nkeys: string[];
  nid = new Map<string, number>();
  links: Link[] = [];
  /** 이음이 있는 그물 짝(작은 번호·nm + 큰 번호) */
  pairs = new Set<number>();
  nodeAtt = new Map<number, Hit[]>();
  live: Set<number>[] = [];
  gateSets: Set<number>[] = [];
  seamLinks: Link[] = [];
  gid = new Map<string, number>();
  gref: [number, number][] = [];
  nAbs = 0;
  /** 방식 → 추상 그래프 이웃(처음 쓸 때 만든다) */
  private aadj: (AEdge[][] | null)[] = new Array(NM).fill(null);
  nodeBlocks = new Map<string, [number, Seed[]][]>();
  blockGates = new Map<string, number[]>();
  private blockList: [number, number][] = []; // (그물, 구역) 순서
  private pkgAdj: AEdge[][] = [];
  hppm: Record<string, number> = {};
  private pkgCost: Map<string, number>[] = Array.from({ length: NM }, () => new Map());
  buildMs: number;
  /** 만들기 단계별 누적 시간(ms) */
  phases: Record<string, number> = {};

  constructor(
    private g: MeshGraph,
    entries: WalkMesh[],
    classes: WalkMeshClass[],
  ) {
    const t0 = Date.now();
    const cf: Int32Array[] = [];
    for (let m = 0; m < NM; m++) cf.push(Int32Array.from(classes, (c) => (c.f[m] === null ? -1 : c.f[m]!)));
    this.meshes = entries.map((e) => new Mesh(e, g.edgeGeom, classes, cf));
    this.phases.meshes = Date.now() - t0;
    for (const e of entries) if ((e.kind ?? 'surface') === 'surface') for (const k of e.sources) this.covered.add(k);
    this.nkeys = g.nodes.map((n) => n.key);
    this.nkeys.forEach((k, i) => this.nid.set(k, i));
    for (const m of MESH_MODES) {
      const s = g.modes[m];
      this.hppm[m] = Math.floor(Math.min(1.0, ...Object.values(s.mult)) * (s.base === 'walkS' ? WALK_MIN_S_PER_M : 1.0) * 0.99 * PPM);
    }
    this.seams();
    this.phases.seams = Date.now() - t0;
    this.attachNodes();
    this.live = this.meshes.map(() => new Set<number>());
    for (const hits of this.nodeAtt.values())
      for (const [mi, seeds] of hits) for (const [v] of seeds) this.live[mi].add(this.meshes[mi].comp[v]);
    for (const [a, va, b, vb] of this.links) {
      this.live[a].add(this.meshes[a].comp[va]);
      this.live[b].add(this.meshes[b].comp[vb]);
    }
    this.phases.attach = Date.now() - t0;
    this.gates();
    this.prepareTables();
    this.phases.gates = Date.now() - t0;
    this.buildMs = Date.now() - t0;
  }

  /** 항목에 실린 이음(서버가 가져올 때 계산, 서버 _seams). */
  private seams() {
    const pos = new Map(this.meshes.map((M, i) => [M.key, i]));
    const links: Link[] = [];
    this.meshes.forEach((A, ai) => {
      for (const [bkey, flat] of A.entry.seams ?? []) {
        const bi = pos.get(bkey);
        if (bi === undefined) continue;
        const B = this.meshes[bi];
        for (let p = 0; p + 1 < flat.length; p += 2) {
          const v = flat[p],
            w = flat[p + 1];
          links.push([ai, v, bi, w, distMm(A.xs[v], A.ys[v], A.zs[v], B.xs[w], B.ys[w], B.zs[w])]);
        }
      }
    });
    this.links = links.sort(cmpNums);
    for (const [a, , b] of this.links) this.pairs.add(a * this.meshes.length + b);
  }

  /** floor: undefined 면 모든 그물, null 이면 바깥 그물, 문자열이면 그 층 실내 바닥에만. */
  attachPoint(x: number, y: number, z: number, needInside: boolean, floor?: string | null): Hit[] {
    const out: Hit[] = [];
    this.meshes.forEach((M, mi) => {
      if (floor !== undefined && (M.entry.floorKey ?? null) !== floor) return;
      const r = ATTACH_CELLS * M.cell;
      if (!inBbox(M.bbox, x, y, r) || Math.abs(z - M.z(x, y)) > AREA_DZ_M) return;
      const inside = M.usable(x, y) >= 0;
      if (needInside && !inside) return;
      const got: Seed[] = [];
      for (const v of M.nearVertices(x, y, r)) {
        if (got.length >= (inside ? ATTACH_MAX : ATTACH_OUT_MAX)) break;
        if (!inside || M.sees(x, y, M.xs[v], M.ys[v])) got.push([v, distMm(x, y, z, M.xs[v], M.ys[v], M.zs[v])]);
      }
      if (got.length) out.push([mi, got]);
    });
    return out;
  }

  private attachNodes() {
    this.g.nodes.forEach((n, i) => {
      if (n.location !== 'outdoor' && !n.floorKey) return;
      const hits = this.attachPoint(n.x, n.y, n.z, false, n.location === 'indoor' ? n.floorKey : null); // 실내 노드는 같은 층 바닥에만
      if (hits.length) this.nodeAtt.set(i, hits);
    });
  }

  private gates() {
    this.gateSets = this.meshes.map(() => new Set<number>());
    this.meshes.forEach((M, mi) => {
      const shared = new Map<number, [number, number, number[]]>();
      const nbk = M.cols * M.rows + 1; // 구역 번호 짝 키
      for (let v = 0; v < M.nc; v++) {
        const bs = M.vblocks(v);
        for (let a = 0; a < bs.length; a++)
          for (let b = a + 1; b < bs.length; b++) {
            const k = bs[a] * nbk + bs[b];
            const l = shared.get(k);
            if (l) l[2].push(v);
            else shared.set(k, [bs[a], bs[b], [v]]);
          }
      }
      const pairs = [...shared.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      for (const [b1, b2, vs] of pairs) {
        const step = Math.floor(b1 / M.nbx) === Math.floor(b2 / M.nbx) ? M.cols + 1 : 1;
        const runs: number[][] = [];
        let cur = [vs[0]];
        for (let i = 1; i < vs.length; i++) {
          const v = vs[i];
          const last = cur[cur.length - 1];
          const x = M.eid.get(last * M.nv + v);
          if (v - last === step && x !== undefined && (M.eb0[x] === b1 || M.eb1[x] === b1) && (M.eb0[x] === b2 || M.eb1[x] === b2))
            cur.push(v);
          else {
            runs.push(cur);
            cur = [v];
          }
        }
        runs.push(cur);
        for (const run of runs) {
          const mid = Math.floor(run.length / 2);
          for (let p = 0; p < run.length; p++) if (p % ENTRANCE_EVERY === mid % ENTRANCE_EVERY) this.gateSets[mi].add(run[p]);
        }
      }
    });
    const groups = new Map<string, { k: number[]; g: Link[] }>();
    for (const link of this.links) {
      const [a, va, b, vb] = link;
      const k = [a, this.meshes[a].vb[va * 4], b, this.meshes[b].vb[vb * 4]];
      const ks = k.join(',');
      const got = groups.get(ks);
      if (got) got.g.push(link);
      else groups.set(ks, { k, g: [link] });
    }
    for (const { k, g } of [...groups.values()].sort((p, q) => cmpNums(p.k, q.k))) {
      const A = this.meshes[k[0]],
        B = this.meshes[k[2]];
      const chain = g.map((_, i) => i);
      const root = (i: number) => {
        while (chain[i] !== i) {
          chain[i] = chain[chain[i]];
          i = chain[i];
        }
        return i;
      };
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) {
          const a0 = Math.min(g[i][1], g[j][1]),
            a1 = Math.max(g[i][1], g[j][1]);
          const b0 = Math.min(g[i][3], g[j][3]),
            b1 = Math.max(g[i][3], g[j][3]);
          if (g[i][1] === g[j][1] || A.eid.has(a0 * A.nv + a1) || g[i][3] === g[j][3] || B.eid.has(b0 * B.nv + b1))
            chain[root(j)] = root(i);
        }
      const members = new Map<number, Link[]>();
      for (let i = 0; i < g.length; i++) {
        const r = root(i);
        const l = members.get(r);
        if (l) l.push(g[i]);
        else members.set(r, [g[i]]);
      }
      for (const r of [...members.keys()].sort((p, q) => p - q)) {
        const ms = members.get(r)!;
        const link = ms[Math.floor(ms.length / 2)];
        this.seamLinks.push(link);
        this.gateSets[link[0]].add(link[1]);
        this.gateSets[link[2]].add(link[3]);
      }
    }
    const base = this.nkeys.length;
    this.gateSets.forEach((gs, mi) => {
      for (const v of [...gs].sort((p, q) => p - q)) {
        this.gid.set(`${mi}:${v}`, base + this.gref.length);
        this.gref.push([mi, v]);
      }
    });
    this.nAbs = base + this.gref.length;
  }

  xyzOf(a: number, tmp: Tmp): XYZ {
    const t = tmp.get(a);
    if (t) return t.xyz;
    if (a < this.nkeys.length) {
      const n = this.g.nodes[a];
      return [n.x, n.y, n.z];
    }
    const [mi, v] = this.gref[a - this.nkeys.length];
    return this.meshes[mi].xyz(v);
  }

  private attCost(mi: number, seeds: Seed[], modeI: number, b: number | null = null): Seed[] {
    const M = this.meshes[mi];
    const out: Seed[] = [];
    for (const [v, d] of seeds) {
      const f = M.vf(modeI, v);
      if (f >= 0 && (b === null || M.inBlock(v, b))) out.push([v, scaled(d, f)]);
    }
    return out;
  }

  /** 방식과 무관한 것: 꾸러미 길 이웃, 구역마다 관문·노드 관문, 구역 순서. */
  private prepareTables() {
    this.pkgAdj = this.nkeys.map((k) => {
      const out: AEdge[] = [];
      for (const arc of this.g.out(k)) {
        const e = arc.edge;
        if (
          e.kind === 'open_area' &&
          ((e.surfaceKey !== undefined && this.covered.has(e.surfaceKey)) || this.covered.has(areaOf(e) ?? '\u0000'))
        )
          continue;
        out.push({ to: this.nid.get(arc.to)!, info: { t: 'edge', e }, c: -1 });
      }
      return out;
    });
    for (const i of [...this.nodeAtt.keys()].sort((p, q) => p - q))
      for (const [mi, seeds] of this.nodeAtt.get(i)!) {
        const bs = new Set<number>();
        for (const [v] of seeds) for (const b of this.meshes[mi].vblocks(v)) bs.add(b);
        for (const b of [...bs].sort((p, q) => p - q)) {
          const k = `${mi}:${b}`;
          const l = this.nodeBlocks.get(k);
          if (l) l.push([i, seeds]);
          else this.nodeBlocks.set(k, [[i, seeds]]);
        }
      }
    const nodeBlockOf = new Map<number, number[]>();
    for (const k of this.nodeBlocks.keys()) {
      const [m2, b] = k.split(':').map(Number);
      const l = nodeBlockOf.get(m2);
      if (l) l.push(b);
      else nodeBlockOf.set(m2, [b]);
    }
    this.meshes.forEach((M, mi) => {
      const gb = new Map<number, number[]>();
      for (const v of [...this.gateSets[mi]].sort((p, q) => p - q))
        for (const b of M.vblocks(v)) {
          const l = gb.get(b);
          if (l) l.push(v);
          else gb.set(b, [v]);
        }
      const blocks = new Set<number>([...gb.keys(), ...(nodeBlockOf.get(mi) ?? [])]);
      for (const b of [...blocks].sort((p, q) => p - q)) {
        this.blockGates.set(`${mi}:${b}`, gb.get(b) ?? []);
        this.blockList.push([mi, b]);
      }
    });
  }

  /** 방식 하나의 추상 그래프(서버 _tables 의 그 방식 칸과 같은 값·같은 순서). */
  private tables(modeI: number): AEdge[][] {
    const have = this.aadj[modeI];
    if (have) return have;
    const t0 = Date.now();
    const aadj: AEdge[][] = Array.from({ length: this.nAbs }, (_, i) => (i < this.pkgAdj.length ? [...this.pkgAdj[i]] : []));
    for (const [mi, b] of this.blockList) {
      const M = this.meshes[mi];
      const vg = this.blockGates.get(`${mi}:${b}`)!,
        ng = this.nodeBlocks.get(`${mi}:${b}`) ?? [];
      if (vg.length + ng.length < 2) continue;
      // 이 방식과 구역 안 등급 계수가 같은 방식 가운데 첫 방식으로 계산(서버와 같게)
      const present = [...new Set((M.blockCells.get(b) ?? []).map((k) => M.cls[k]))].sort((p, q) => p - q);
      const sig = (m: number) => present.map((c) => M.cf[m][c]).join(',');
      const mine = sig(modeI);
      let m0 = 0;
      while (sig(m0) !== mine) m0++;
      const found = new Map<number, [number, number, number]>(); // s·nAbs+t → (s, t, 비용)
      const put = (s: number, t: number, c: number) => found.set(s * this.nAbs + t, [s, t, c]);
      for (const g of vg) {
        if (M.vf(m0, g) < 0) continue;
        M.blockSearch(b, [[g, 0]], m0);
        const src = this.gid.get(`${mi}:${g}`)!;
        for (const h of vg) if (h !== g && M.reached(h)) put(src, this.gid.get(`${mi}:${h}`)!, M.sDist[h]);
        for (const [n, seeds] of ng) {
          const c = best(M, this.attCost(mi, seeds, m0, b));
          if (c !== null) {
            put(src, n, c[0]);
            put(n, src, c[0]);
          }
        }
      }
      for (let p = 0; p < ng.length; p++) {
        const att = this.attCost(mi, ng[p][1], m0, b);
        if (!att.length) continue;
        M.blockSearch(b, att, m0);
        for (let q = p + 1; q < ng.length; q++) {
          const c = best(M, this.attCost(mi, ng[q][1], m0, b));
          if (c !== null) {
            put(ng[p][0], ng[q][0], c[0]);
            put(ng[q][0], ng[p][0], c[0]);
          }
        }
      }
      const rows = [...found.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      for (const [s, t, c] of rows) aadj[s].push({ to: t, info: { t: 'block', mi, b }, c });
    }
    for (const [a, va, b, vb, d] of this.seamLinks) {
      const fa = this.meshes[a].vf(modeI, va),
        fb = this.meshes[b].vf(modeI, vb);
      if (fa < 0 || fb < 0) continue;
      const c = scaled(d, Math.min(fa, fb));
      const ga = this.gid.get(`${a}:${va}`)!,
        gbb = this.gid.get(`${b}:${vb}`)!;
      aadj[ga].push({ to: gbb, info: { t: 'seam', a, va, b, vb }, c });
      aadj[gbb].push({ to: ga, info: { t: 'seam', a: b, va: vb, b: a, vb: va }, c });
    }
    this.aadj[modeI] = aadj;
    this.phases[`tables:${MESH_MODES[modeI]}`] = Date.now() - t0;
    return aadj;
  }

  /** 방식 하나의 관문 표를 미리 만든다(앱이 쉴 때 부르면 첫 길찾기가 빠름). */
  warm(mode = 'shortest') {
    this.tables(MESH_MODES.indexOf(mode));
  }

  /** 출발·도착 = 노드 key 또는 점 [x, y, z]. 서버 route_points. */
  route(start: string | XYZ, goal: string | XYZ, mode: string): { route: MeshRoute | null; ends: MeshEnd[] } {
    const modeI = MESH_MODES.indexOf(mode);
    const tmp: Tmp = new Map();
    const ends: MeshEnd[] = [];
    const specs = [start, goal];
    const raw = specs.map((spec) => {
      if (typeof spec === 'string') return null;
      const [x, y, z] = spec;
      return this.g.nodeAt(x, y, z) ? null : this.attachPoint(x, y, z, true);
    });
    specs.forEach((spec, which) => {
      const key = which === 0 ? 'q:from' : 'q:to';
      if (typeof spec === 'string') {
        ends.push(this.nid.has(spec) ? { nodeKey: spec, attached: 'node' } : null);
        return;
      }
      const [x, y, z] = spec;
      const at = this.g.nodeAt(x, y, z);
      if (at) {
        ends.push({ nodeKey: at.key, attached: 'node' });
        return;
      }
      const other = new Set<string>();
      for (const [mi, seeds] of raw[1 - which] ?? []) for (const [v] of seeds) other.add(`${mi}:${this.meshes[mi].comp[v]}`);
      const hits: Hit[] = [];
      for (const [mi, seeds] of raw[which]!) {
        const comp = this.meshes[mi].comp;
        const kept = seeds.filter(([v]) => this.live[mi].has(comp[v]) || other.has(`${mi}:${comp[v]}`));
        if (kept.length) hits.push([mi, kept]);
      }
      if (hits.length) {
        const M = this.meshes[hits[0][0]];
        tmp.set(this.nAbs + which, { key, xyz: [pyRound(x, 2), pyRound(y, 2), pyRound(M.z(x, y), 2)], hits });
        ends.push({ nodeKey: key, attached: 'surface', areas: hits.map((h) => this.meshes[h[0]].key) });
        return;
      }
      const n = this.g.nearestNode(x, y, z);
      ends.push(n ? { nodeKey: n.key, attached: 'nearest_node' } : null);
    });
    if (ends[0] === null || ends[1] === null) return { route: null, ends };
    const ids = [0, 1].map((w) => (ends[w]!.nodeKey.startsWith('q:') ? this.nAbs + w : this.nid.get(ends[w]!.nodeKey)!));
    const extra = this.tempEdges(tmp, ids, modeI);
    const found = this.search(ids[0], ids[1], mode, modeI, tmp, extra);
    if (found === null) return { route: null, ends };
    return { route: this.describe(found, tmp, modeI), ends };
  }

  private tempEdges(tmp: Tmp, ids: number[], modeI: number): Map<number, AEdge[]> {
    const extra = new Map<number, AEdge[]>();
    const add = (a: number, e: AEdge) => {
      const l = extra.get(a);
      if (l) l.push(e);
      else extra.set(a, [e]);
    };
    for (const which of [0, 1]) {
      const a = ids[which];
      const t = tmp.get(a);
      if (!t) continue;
      for (const [mi, seeds] of t.hits) {
        const M = this.meshes[mi];
        const bs = new Set<number>();
        for (const [v] of seeds) for (const b of M.vblocks(v)) bs.add(b);
        for (const b of [...bs].sort((p, q) => p - q)) {
          const att = this.attCost(mi, seeds, modeI, b);
          if (!att.length) continue;
          const targets: [number, Seed[]][] = (this.blockGates.get(`${mi}:${b}`) ?? []).map((v) => [this.gid.get(`${mi}:${v}`)!, [[v, 0]]]);
          for (const [n, s2] of this.nodeBlocks.get(`${mi}:${b}`) ?? []) targets.push([n, this.attCost(mi, s2, modeI, b)]);
          const t1 = tmp.get(ids[1]);
          if (which === 0 && t1) for (const [mj, s2] of t1.hits) if (mj === mi) targets.push([ids[1], this.attCost(mi, s2, modeI, b)]);
          M.blockSearch(b, att, modeI);
          for (const [tg, seeds2] of targets) {
            const c = best(M, seeds2);
            if (c === null) continue;
            const info: Info = { t: 'qblock', mi, b, which };
            if (which === 0) add(a, { to: tg, info, c: c[0] });
            else if (tg !== ids[0]) add(tg, { to: a, info, c: c[0] });
          }
        }
      }
    }
    return extra;
  }

  private search(start: number, goal: number, mode: string, modeI: number, tmp: Tmp, extra: Map<number, AEdge[]>) {
    const aadj = this.tables(modeI);
    const gx = this.xyzOf(goal, tmp);
    const hppm = this.hppm[mode];
    const hcache = new Map<number, number>();
    const pcost = this.pkgCost[modeI];
    const spec = this.g.modes[mode];
    const h = (a: number) => {
      let v = hcache.get(a);
      if (v === undefined) {
        const p = this.xyzOf(a, tmp);
        v = Math.floor((distMm(p[0], p[1], p[2], gx[0], gx[1], gx[2]) * hppm) / PPM);
        hcache.set(a, v);
      }
      return v;
    };
    // 힙 (f, 점, 승강기 안, g): 파이썬 튜플 순서. 점·승강기는 상태 번호 s = 점·2 + 승강기 로 같은 순서
    const dist = new Map<number, number>([[start * 2, 0]]);
    const prev = new Map<number, [number, Info]>();
    const hf: number[] = [],
      hs: number[] = [],
      hg: number[] = [];
    const less = (i: number, j: number) => hf[i] < hf[j] || (hf[i] === hf[j] && (hs[i] < hs[j] || (hs[i] === hs[j] && hg[i] < hg[j])));
    const swap = (i: number, j: number) => {
      [hf[i], hf[j]] = [hf[j], hf[i]];
      [hs[i], hs[j]] = [hs[j], hs[i]];
      [hg[i], hg[j]] = [hg[j], hg[i]];
    };
    const push = (f: number, s: number, gv: number) => {
      hf.push(f);
      hs.push(s);
      hg.push(gv);
      for (let i = hf.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (!less(i, p)) break;
        swap(i, p);
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const s = hs[0],
        gv = hg[0];
      const lf = hf.pop()!,
        ls = hs.pop()!,
        lg = hg.pop()!;
      if (hf.length) {
        hf[0] = lf;
        hs[0] = ls;
        hg[0] = lg;
        const n = hf.length;
        for (let i = 0; ;) {
          const l = 2 * i + 1,
            r = l + 1;
          let m = i;
          if (l < n && less(l, m)) m = l;
          if (r < n && less(r, m)) m = r;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
      return [s, gv];
    };
    push(h(start), start * 2, 0);
    let end = -1;
    const none: AEdge[] = [];
    while (hf.length) {
      const [su, d] = pop();
      const u = su >> 1,
        riding = su & 1;
      if (d > dist.get(su)!) continue;
      if (u === goal) {
        end = su;
        break;
      }
      for (const lst of [u < this.nAbs ? aadj[u] : none, extra.get(u) ?? none])
        for (const { to: v, info, c: c0 } of lst) {
          let c = c0,
            nr = 0;
          if (info.t === 'edge') {
            const e = info.e;
            const rev = this.nkeys[v] === e.from;
            const ck = `${e.key}\n${rev ? 1 : 0}${riding}`;
            const got = pcost.get(ck);
            if (got === undefined) {
              const raw = edgeCost(e, this.g.ind(e), spec, rev, !riding);
              c = raw === null ? -1 : mm(raw);
              pcost.set(ck, c);
            } else c = got;
            if (c < 0) continue;
            nr = e.kind === 'elevator' ? 1 : 0;
          }
          const nd = d + c;
          const sv = v * 2 + nr;
          if (nd < (dist.get(sv) ?? Infinity)) {
            dist.set(sv, nd);
            prev.set(sv, [su, info]);
            push(nd + h(v), sv, nd);
          }
        }
    }
    if (end < 0) return null;
    const steps: [number, number, Info][] = [];
    for (let cur = end; prev.has(cur);) {
      const [p, info] = prev.get(cur)!;
      steps.push([p >> 1, cur >> 1, info]);
      cur = p;
    }
    steps.reverse();
    return { start, steps, cost: dist.get(end)! };
  }

  // ----- 경로 → 선 -----
  private ref(a: number, tmp: Tmp): Ref {
    if (tmp.has(a)) return { k: 'q', i: a };
    if (a < this.nkeys.length) return { k: 'n', i: a };
    const [mi, v] = this.gref[a - this.nkeys.length];
    return { k: 'v', mi, v };
  }
  private seedsOf(r: Ref, mi: number, b: number, modeI: number, tmp: Tmp): Seed[] {
    if (r.k === 'v') return [[r.v, 0]];
    const hits = r.k === 'q' ? tmp.get(r.i)!.hits : (this.nodeAtt.get(r.i) ?? []);
    for (const [mj, seeds] of hits) if (mj === mi) return this.attCost(mi, seeds, modeI, b);
    return [];
  }
  private expand(u: number, v: number, mi: number, b: number, modeI: number, tmp: Tmp): Ref[] {
    const ru = this.ref(u, tmp),
      rv = this.ref(v, tmp);
    const M = this.meshes[mi];
    const target = rv.k === 'v' ? null : this.seedsOf(rv, mi, b, modeI, tmp);
    M.blockSearch(b, this.seedsOf(ru, mi, b, modeI, tmp), modeI);
    let w = rv.k === 'v' ? rv.v : best(M, target!)![1];
    const path: Ref[] = [];
    while (w !== -1) {
      path.push({ k: 'v', mi, v: w });
      w = M.sPrev[w];
    }
    path.reverse();
    return [ru, ...path, rv];
  }
  private point(r: Ref, tmp: Tmp): XYZ {
    if (r.k === 'q') return tmp.get(r.i)!.xyz;
    if (r.k === 'n') {
      const n = this.g.nodes[r.i];
      return [n.x, n.y, n.z];
    }
    return this.meshes[r.mi].xyz(r.v);
  }

  private describe(found: { start: number; steps: [number, number, Info][]; cost: number }, tmp: Tmp, modeI: number): MeshRoute {
    type Item = { t: 'edge'; e: RouteEdge; from: string } | { t: 'pts'; refs: Ref[] };
    const items: Item[] = [];
    for (const [u, v, info] of found.steps) {
      if (info.t === 'edge') {
        items.push({ t: 'edge', e: info.e, from: this.nkeys[u] });
        continue;
      }
      const seq = info.t === 'seam' ? [this.ref(u, tmp), this.ref(v, tmp)] : this.expand(u, v, info.mi, info.b, modeI, tmp);
      const last = items[items.length - 1];
      if (last && last.t === 'pts') {
        const prev = last.refs;
        last.refs = refKey(prev[prev.length - 1]) === refKey(seq[0]) ? [...prev, ...seq.slice(1)] : [...prev, ...seq];
      } else items.push({ t: 'pts', refs: seq });
    }
    const keyOf = (r: Ref) => (r.k === 'n' ? this.nkeys[r.i] : r.k === 'q' ? tmp.get(r.i)!.key : `v:${this.meshes[r.mi].key}:${r.v}`);
    const edges: MeshRouteEdge[] = [];
    const nodeKeys = [keyOf(this.ref(found.start, tmp))];
    for (const it of items) {
      if (it.t === 'edge') {
        const forward = it.e.from === it.from;
        edges.push({ edge: it.e, forward });
        nodeKeys.push(forward ? it.e.to : it.e.from);
        continue;
      }
      for (const ve of this.virtualEdges(it.refs, tmp, keyOf, edges.length, modeI)) {
        edges.push({ edge: ve, forward: true });
        nodeKeys.push(ve.to);
      }
    }
    return { nodeKeys, edges, cost: found.cost };
  }

  private virtualEdges(refs: Ref[], tmp: Tmp, keyOf: (r: Ref) => string, base: number, modeI: number): RouteEdge[] {
    const pts = refs.map((r) => this.point(r, tmp));
    const meshIds: number[] = [];
    for (const r of refs) if (r.k === 'v' && !meshIds.includes(r.mi)) meshIds.push(r.mi);
    const run = new Run(
      meshIds.map((i) => this.meshes[i]),
      modeI,
      meshIds,
      this.pairs,
      this.meshes.length,
    );
    const own = refs.map((r) => (r.k === 'v' ? meshIds.indexOf(r.mi) : null));
    const keep = pull(run, pts, own);
    const segs: [number, number, [number, number]][] = [];
    for (let s = 1; s < keep.length; s++) segs.push([keep[s - 1], keep[s], run.label(pts[keep[s - 1]], pts[keep[s]])]);
    const out: RouteEdge[] = [];
    let k = 0;
    while (k < segs.length) {
      let j = k;
      while (j + 1 < segs.length && segs[j + 1][2][0] === segs[k][2][0] && segs[j + 1][2][1] === segs[k][2][1]) j++;
      const M = run.meshes[segs[k][2][0]];
      let geom: XYZ[] = [];
      for (let s = k; s <= j; s++) {
        const line = run.line(pts[segs[s][0]], pts[segs[s][1]]);
        geom.push(...(geom.length ? line.slice(1) : line));
      }
      geom = geom.map((p) => [pyRound(p[0], 2), pyRound(p[1], 2), pyRound(p[2], 2)]);
      let length = 0;
      for (let s = 1; s < geom.length; s++) {
        const dx = geom[s][0] - geom[s - 1][0],
          dy = geom[s][1] - geom[s - 1][1],
          dz = geom[s][2] - geom[s - 1][2];
        length += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      const cls: WalkMeshClass[] = [];
      for (let s = k; s <= j; s++) cls.push(...run.classes(pts[segs[s][0]], pts[segs[s][1]]));
      const e: RouteEdge = {
        key: `w:${base + out.length}:${M.key}`,
        from: keyOf(refs[segs[k][0]]),
        to: keyOf(refs[segs[j][1]]),
        name: M.entry.name || null,
        kind: (M.kind === 'surface' ? 'open_area' : M.entry.areaKind) as RouteEdge['kind'],
        pedestrianAccess: 'allowed',
        wheelchairAccess: 'unknown',
        lengthM: pyRound(length, 2),
        stepCount: null,
        widthM: null,
        geometry: geom,
      };
      if (M.kind === 'surface') e.areaKind = (M.entry.areaKind || 'surface') as RouteEdge['areaKind'];
      e.indicators = { ...basicIndicators(e, M.kind === 'floor'), ...classIndicators(cls) };
      out.push(e);
      k = j + 1;
    }
    return out;
  }
}

/** 가상 길 위 표본 칸 등급들 → 지붕·조명 비율(모르는 칸 0, 다 모르면 null)·차량(절반 넘으면 shared). 서버 _class_indicators. */
function classIndicators(cls: WalkMeshClass[]) {
  const ratio = (f: 'coveredRatio' | 'litRatio') => {
    const vals = cls.map((c) => c[f]);
    return vals.every((v) => v === null || v === undefined) ? null : pyRound(pySum(vals.map((v) => v || 0.0)) / vals.length, 2);
  };
  const shared = cls.filter((c) => c.vehicle === 'shared').length;
  const vehicle = cls.length && shared * 2 >= cls.length ? 'shared' : cls.length && shared === 0 ? (cls[0].vehicle ?? null) : 'none';
  return { coveredRatio: ratio('coveredRatio'), litRatio: ratio('litRatio'), vehicle: vehicle as EdgeIndicators['vehicle'] };
}

function areaOf(e: RouteEdge): string | null {
  return e.key.startsWith('x:') ? e.key.split(':').slice(1, 3).join(':') : null;
}

/** 한 점 줄에 이어 쓰는 그물들. 서버 _Run. */
class Run {
  step: number;
  cellMax: number;
  atK = -1; // at() 이 찾은 칸
  constructor(
    public meshes: Mesh[],
    private modeI: number,
    private ids: number[] = [],
    private pairs = new Set<number>(),
    private nm = 0,
  ) {
    this.step = (meshes.length ? Math.min(...meshes.map((M) => M.cell)) : 1.0) * LOS_STEP;
    this.cellMax = meshes.length ? Math.max(...meshes.map((M) => M.cell)) : 1.0;
  }
  /** (x, y) 를 덮는 쓸 수 있는 세모의 그물 자리(-1 = 없음), 칸은 atK. */
  at(x: number, y: number, prevM: number, prevZ: number | null, gap = 0): number {
    if (prevM >= 0) {
      const k = this.meshes[prevM].usable(x, y);
      if (k >= 0) {
        this.atK = k;
        return prevM;
      }
    }
    for (let p = 0; p < this.meshes.length; p++) {
      if (p === prevM) continue;
      const M = this.meshes[p];
      const k = M.usable(x, y);
      if (k >= 0 && (prevZ === null || Math.abs(M.z(x, y) - prevZ) <= STEP_OK_M + this.step * (gap + 1))) {
        this.atK = k;
        return p;
      }
    }
    return -1;
  }
  sees(p: XYZ, q: XYZ, pm0: number | null, qm0: number | null): boolean {
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / this.step));
    let sig = 0,
      first = true;
    let pm = pm0 === null ? -1 : pm0,
      pz: number | null = pm0 !== null ? p[2] : null,
      gap = 0,
      seam = false;
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      const x = p[0] + t * dx,
        y = p[1] + t * dy;
      const got = this.at(x, y, pm, pz, gap);
      if (got < 0) {
        if (this.seamy(x, y)) {
          seam = true;
          continue;
        }
        gap++;
        if (gap * this.step > this.cellMax) return false;
        continue;
      }
      const M = this.meshes[got];
      if (gap && pm >= 0 && got === pm && !seam) return false;
      if ((gap || seam) && pm >= 0 && got !== pm && !this.linked(pm, got)) return false; // 틈 건너 다른 그물: 이음 있는 짝만
      seam = false;
      const g = M.cf[this.modeI][M.cls[this.atK]];
      if (first) {
        sig = g;
        first = false;
      } else if (g !== sig) return false;
      pm = got;
      pz = M.z(x, y);
      gap = 0;
    }
    return !first && !(gap && qm0 !== null && qm0 === pm);
  }
  linked(p: number, q: number): boolean {
    const a = Math.min(this.ids[p], this.ids[q]),
      b = Math.max(this.ids[p], this.ids[q]);
    return this.pairs.has(a * this.nm + b);
  }
  seamy(x: number, y: number): boolean {
    let n = 0;
    for (const M of this.meshes) {
      const k = M.locate(x, y);
      if (k >= 0 && M.codes[k]) {
        n++;
        if (n >= 2) return true;
      }
    }
    return false;
  }
  classes(p: XYZ, q: XYZ): WalkMeshClass[] {
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / this.step));
    const out: WalkMeshClass[] = [];
    let pm = -1,
      pz: number | null = null;
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      const x = p[0] + t * dx,
        y = p[1] + t * dy;
      const got = this.at(x, y, pm, pz);
      if (got >= 0) {
        const M = this.meshes[got];
        out.push(M.classes[M.cls[this.atK]]);
        pm = got;
        pz = M.z(x, y);
      }
    }
    return out;
  }
  label(p: XYZ, q: XYZ): [number, number] {
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / this.step));
    const order = [Math.floor(n / 2)];
    for (let s = 0; s < n; s++) if (s !== Math.floor(n / 2)) order.push(s);
    for (const s of order) {
      const t = (s + 0.5) / n;
      const got = this.at(p[0] + t * dx, p[1] + t * dy, -1, null);
      if (got >= 0) {
        const M = this.meshes[got];
        return [got, M.cf[this.modeI][M.cls[this.atK]]];
      }
    }
    return [0, -1]; // 파이썬 (0, None)
  }
  z(x: number, y: number, prev: number): number {
    let bst: number | null = null;
    for (const M of this.meshes)
      if (M.usable(x, y) >= 0) {
        const z = M.z(x, y);
        if (bst === null || Math.abs(z - prev) < Math.abs(bst - prev)) bst = z;
      }
    return bst === null ? prev : bst;
  }
  line(p: XYZ, q: XYZ): XYZ[] {
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const k = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / SURFACE_SAMPLE_M));
    const pts: XYZ[] = [[p[0], p[1], p[2]]];
    let prev = p[2];
    for (let s = 1; s < k; s++) {
      const t = s / k;
      const x = p[0] + t * dx,
        y = p[1] + t * dy;
      prev = this.z(x, y, prev);
      pts.push([x, y, prev]);
    }
    pts.push([q[0], q[1], q[2]]);
    return pts;
  }
}

/** 줄 당기기(서버 _pull). 남길 점 번호. */
function pull(run: Run, pts: XYZ[], own: (number | null)[]): number[] {
  const keep = [0];
  const last = pts.length - 1;
  let i = 0;
  while (i < last) {
    if (run.sees(pts[i], pts[last], own[i], own[last])) {
      keep.push(last);
      break;
    }
    let ok = i + 1,
      step = 1,
      fail = -1;
    for (;;) {
      const j = Math.min(i + 2 * step, last);
      if (run.sees(pts[i], pts[j], own[i], own[j])) {
        ok = j;
        if (j === last) break;
        step *= 2;
      } else {
        fail = j;
        break;
      }
    }
    if (fail >= 0) {
      let lo = ok,
        hi = fail;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (run.sees(pts[i], pts[mid], own[i], own[mid])) lo = mid;
        else hi = mid;
      }
      ok = lo;
    }
    keep.push(ok);
    i = ok;
  }
  return keep;
}
