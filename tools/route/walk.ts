// 열린 면(walkAreas)·걷는 면(walkSurfaces) 가로지르기와 면 위 아무 점 붙이기.
// 서버(campus-backend mapdata/routing.py 의 _Ring·_Region·_area_edges·_surface_edges·route_points, surfaces.surface_z)와 같은 규칙.
// 꾸러미에는 가상 간선이 없고 읽을 때 만든다. 서버 쪽을 바꾸면 여기도 바꾸고 scripts/build-route-fixture.py 로 비교 자료를 다시 만든다.
import type { MapNode, MapPackage, SurfaceTop, WalkArea, WalkSurface, XYZ } from '../map/package';
import { pyRound, type RouteEdge } from './cost';

const AREA_DZ_M = 0.5; // 면 높이와 노드(점) 높이 차 한도. 넘으면 다른 단(사이는 벽)
const AREA_MAX_NEIGHBORS = 12; // 노드마다 가까운 이웃 몇 개까지만
const SURFACE_SAMPLE_M = 2.0; // 걷는 면 가로지르기 선은 이만큼마다 면 높이를 찍는다
const NODE_AT_M = 0.05; // 점이 노드에서 이만큼 안이면 그 노드
const ATTACH_RADIUS_M = 25.0; // 면 위가 아닌 점: 이 안 가장 가까운 노드
const ATTACH_DZ_M = 2.0;

type P2 = [number, number];
const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 파이썬 3.12+ sum() 과 같게(Neumaier 보정 합). */
export function pySum(xs: number[]): number {
  let s = 0,
    c = 0;
  for (const x of xs) {
    const t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += s - t + x;
    else c += x - t + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

/** 면 외곽(닫히지 않은 꼭짓점 목록). 경계 위 점은 안으로 본다. */
export class Ring {
  edges: [P2, P2][];
  constructor(polygon: number[][]) {
    const pts: P2[] = polygon.map((p) => [p[0], p[1]]);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    this.edges = pts.map((p, k) => [p, pts[(k + 1) % pts.length]]);
  }
  private near(p: P2, a: P2, b: P2): boolean {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < 1e-6;
  }
  covers(p: P2): boolean {
    let inside = false;
    for (const [a, b] of this.edges) {
      if (this.near(p, a, b)) return true;
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
    }
    return inside;
  }
  onEdge(p: P2): boolean {
    return this.edges.some(([a, b]) => this.near(p, a, b));
  }
  /** 선분 pq 가 이 고리의 변과 만나는 곳(pq 위 비율 t). */
  cuts(p: P2, q: P2, length: number): number[] {
    const out: number[] = [];
    for (const [a, b] of this.edges) {
      const d1 = cross(p, q, a),
        d2 = cross(p, q, b);
      const on1 = Math.abs(d1) < 1e-7 * length,
        on2 = Math.abs(d2) < 1e-7 * length;
      if (on1 && on2) {
        for (const c of [a, b]) out.push(((c[0] - p[0]) * (q[0] - p[0]) + (c[1] - p[1]) * (q[1] - p[1])) / length ** 2);
      } else if (d1 > 0 !== d2 > 0 || on1 || on2) {
        const den = cross(a, b, p) - cross(a, b, q);
        if (den) out.push(cross(a, b, p) / den);
      }
    }
    return out;
  }
  /** 선분 pq 가 통째로 면 안(경계 포함)에 있는가: 경계와 만나는 곳마다 자르고 조각 가운데를 본다. */
  sees(p: P2, q: P2): boolean {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) return true;
    return piecesInside(p, q, this.cuts(p, q, length), (m) => this.covers(m));
  }
}

function piecesInside(p: P2, q: P2, cuts: number[], covers: (m: P2) => boolean): boolean {
  const ts = [0, ...cuts.filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y), 1];
  for (let k = 1; k < ts.length; k++) {
    const t0 = ts[k - 1],
      t1 = ts[k];
    if (t1 - t0 < 1e-9) continue;
    const m = (t0 + t1) / 2;
    if (!covers([p[0] + m * (q[0] - p[0]), p[1] + m * (q[1] - p[1])])) return false;
  }
  return true;
}

/** 구멍 있는 면 여러 조각([[바깥 고리, 구멍 고리...], ...]). 경계 위 점은 안으로 본다(구멍 경계 위도). */
export class Region {
  parts: [Ring, Ring[]][];
  rings: Ring[];
  constructor(polygons: number[][][][]) {
    this.parts = polygons.map((p) => [new Ring(p[0]), p.slice(1).map((h) => new Ring(h))]);
    this.rings = this.parts.flatMap(([o, hs]) => [o, ...hs]);
  }
  covers(p: P2): boolean {
    return this.parts.some(([outer, holes]) => outer.covers(p) && !holes.some((h) => h.covers(p) && !h.onEdge(p)));
  }
  sees(p: P2, q: P2): boolean {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) return this.covers(p);
    return piecesInside(
      p,
      q,
      this.rings.flatMap((r) => r.cuts(p, q, length)),
      (m) => this.covers(m),
    );
  }
}

/** 면 높이(서버 surfaces.surface_z). */
export function surfaceZ(top: SurfaceTop, x: number, y: number): number {
  if ('z' in top) return top.z;
  const { origin, direction, points } = top.profile;
  const n = Math.sqrt(direction[0] * direction[0] + direction[1] * direction[1]) || 1;
  const d = ((x - origin[0]) * direction[0] + (y - origin[1]) * direction[1]) / n;
  if (d <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [d0, h0] = points[i - 1],
      [d1, h1] = points[i];
    if (d <= d1) return d1 > d0 ? h0 + ((h1 - h0) * (d - d0)) / (d1 - d0) : h1;
  }
  return points[points.length - 1][1];
}

type Pt = { key: string; x: number; y: number; z: number };

/** p → q 직선을 SURFACE_SAMPLE_M 마다 면 높이로 찍은 3D 선. 두 끝은 노드 높이. */
export function surfaceLine(top: SurfaceTop, p: Pt, q: Pt): XYZ[] {
  const h = Math.hypot(q.x - p.x, q.y - p.y);
  const k = Math.max(1, Math.ceil(h / SURFACE_SAMPLE_M));
  const pts: XYZ[] = [[p.x, p.y, p.z]];
  for (let i = 1; i < k; i++) {
    const t = i / k;
    const x = p.x + t * (q.x - p.x),
      y = p.y + t * (q.y - p.y);
    pts.push([pyRound(x, 2), pyRound(y, 2), pyRound(surfaceZ(top, x, y), 2)]);
  }
  pts.push([q.x, q.y, q.z]);
  return pts;
}

/** 노드마다 가까운 이웃부터 12개까지, 면 안에 머무는 직선으로 보이는 쌍(i < j, 정렬). */
function visiblePairs(ns: Pt[], shape: { sees: (p: P2, q: P2) => boolean }): [number, number][] {
  const keep = new Set<number>();
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    const near: [number, number][] = [];
    for (let j = 0; j < ns.length; j++) if (j !== i) near.push([Math.hypot(ns[j].x - n.x, ns[j].y - n.y), j]);
    near.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let picked = 0;
    for (const [, j] of near) {
      if (picked >= AREA_MAX_NEIGHBORS) break;
      const pair = Math.min(i, j) * ns.length + Math.max(i, j);
      if (keep.has(pair) || shape.sees([n.x, n.y], [ns[j].x, ns[j].y])) {
        keep.add(pair);
        picked++;
      }
    }
  }
  return [...keep].sort((x, y) => x - y).map((pair) => [Math.floor(pair / ns.length), pair % ns.length]);
}

/** 면 가로지르기 자료: 면별 노드·모양. 그래프를 만들 때 한 번. */
export interface WalkIndex {
  areas: Map<string, WalkArea>;
  areaRings: Map<string, Ring>;
  areaMembers: Map<string, MapNode[]>;
  surfaces: Map<string, WalkSurface>;
  surfaceRegions: Map<string, Region>;
  surfaceMembers: Map<string, MapNode[]>;
}

function groupMembers<T>(links: T[], pick: (w: T) => [string, MapNode] | null): Map<string, MapNode[]> {
  const m = new Map<string, MapNode[]>();
  for (const w of links) {
    const got = pick(w);
    if (!got) continue;
    const l = m.get(got[0]);
    if (l) l.push(got[1]);
    else m.set(got[0], [got[1]]);
  }
  for (const l of m.values()) l.sort((x, y) => cmpStr(x.key, y.key));
  return m;
}

export function walkIndex(pkg: MapPackage, nodes: Map<string, MapNode>): WalkIndex {
  const areas = new Map(pkg.walkAreas.map((a) => [a.key, a]));
  const surfaces = new Map((pkg.walkSurfaces ?? []).map((s) => [s.key, s]));
  return {
    areas,
    areaRings: new Map(pkg.walkAreas.map((a) => [a.key, new Ring(a.polygon)])),
    areaMembers: groupMembers(pkg.walkAreaNodes, (w) => {
      const a = areas.get(w.areaKey),
        n = nodes.get(w.nodeKey);
      return a && n && a.z !== null && Math.abs(n.z - a.z) <= AREA_DZ_M ? [a.key, n] : null;
    }),
    surfaces,
    surfaceRegions: new Map([...surfaces.values()].map((s) => [s.key, new Region(s.polygons)])),
    surfaceMembers: groupMembers(pkg.walkSurfaceNodes ?? [], (w) => {
      const s = surfaces.get(w.surfaceKey),
        n = nodes.get(w.nodeKey);
      return s && n && n.location === 'outdoor' && Math.abs(n.z - surfaceZ(s.top, n.x, n.y)) <= AREA_DZ_M ? [s.key, n] : null;
    }),
  };
}

export function areaEdge(w: WalkIndex, ak: string, p: Pt, q: Pt): RouteEdge {
  const a = w.areas.get(ak)!;
  return {
    key: `x:${ak}:${p.key}:${q.key}`,
    from: p.key,
    to: q.key,
    name: a.name || null,
    kind: 'open_area',
    areaKind: a.kind,
    pedestrianAccess: 'allowed',
    wheelchairAccess: 'unknown',
    lengthM: pyRound(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z), 2),
    stepCount: null,
    widthM: null,
    geometry: [
      [p.x, p.y, p.z],
      [q.x, q.y, q.z],
    ],
  };
}

export function surfaceEdge(w: WalkIndex, sk: string, p: Pt, q: Pt): RouteEdge {
  const s = w.surfaces.get(sk)!;
  const g = surfaceLine(s.top, p, q);
  const seg: number[] = [];
  for (let i = 1; i < g.length; i++) seg.push(Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1], g[i][2] - g[i - 1][2]));
  return {
    key: `y:${sk}:${p.key}:${q.key}`,
    from: p.key,
    to: q.key,
    name: s.name || null,
    kind: 'open_area',
    areaKind: 'surface',
    surfaceKey: sk,
    pedestrianAccess: 'allowed',
    wheelchairAccess: 'unknown',
    lengthM: pyRound(pySum(seg), 2),
    stepCount: null,
    widthM: null,
    geometry: g,
  };
}

/** 면 가로지르기 가상 간선: 열린 면 먼저(key 순), 그다음 걷는 면(key 순, 열린 면이 이은 쌍은 건너뜀). */
export function walkEdges(w: WalkIndex): RouteEdge[] {
  const out: RouteEdge[] = [];
  for (const ak of [...w.areaMembers.keys()].sort(cmpStr)) {
    const ns = w.areaMembers.get(ak)!;
    for (const [i, j] of visiblePairs(ns, w.areaRings.get(ak)!)) out.push(areaEdge(w, ak, ns[i], ns[j]));
  }
  const joined = new Set(out.map((e) => [e.from, e.to].sort(cmpStr).join('\n')));
  for (const sk of [...w.surfaceMembers.keys()].sort(cmpStr)) {
    const ns = w.surfaceMembers.get(sk)!;
    for (const [i, j] of visiblePairs(ns, w.surfaceRegions.get(sk)!)) {
      if (joined.has([ns[i].key, ns[j].key].sort(cmpStr).join('\n'))) continue;
      out.push(surfaceEdge(w, sk, ns[i], ns[j]));
    }
  }
  return out;
}

export type Hit = { dz: number; z: number; kind: 'area' | 'surface'; key: string };

/** 점 (x, y, z) 를 덮고 높이(±0.5 m)가 맞는 열린 면·걷는 면(열린 면 먼저, 각각 key 순). */
export function pointOn(w: WalkIndex, x: number, y: number, z: number): Hit[] {
  const hits: Hit[] = [];
  for (const ak of [...w.areas.keys()].sort(cmpStr)) {
    const a = w.areas.get(ak)!;
    if (a.z !== null && Math.abs(z - a.z) <= AREA_DZ_M && w.areaRings.get(ak)!.covers([x, y]))
      hits.push({ dz: Math.abs(z - a.z), z: a.z, kind: 'area', key: ak });
  }
  for (const sk of [...w.surfaces.keys()].sort(cmpStr)) {
    const zs = surfaceZ(w.surfaces.get(sk)!.top, x, y);
    if (Math.abs(z - zs) <= AREA_DZ_M && w.surfaceRegions.get(sk)!.covers([x, y]))
      hits.push({ dz: Math.abs(z - zs), z: zs, kind: 'surface', key: sk });
  }
  return hits;
}

/** 면 위 임시 노드 pt 를 그 면의 노드(와 같은 면 위 앞서 만든 임시 노드)에 잇는 가상 간선(이웃 수 제한 없음). */
export function pointEdges(w: WalkIndex, pt: Pt, hits: Hit[], others: { pt: Pt; on: Set<string> }[]): RouteEdge[] {
  const out: RouteEdge[] = [];
  const joined = new Set<string>();
  for (const h of hits) {
    const shape = h.kind === 'area' ? w.areaRings.get(h.key)! : w.surfaceRegions.get(h.key)!;
    const mem: Pt[] = h.kind === 'area' ? (w.areaMembers.get(h.key) ?? []) : (w.surfaceMembers.get(h.key) ?? []);
    for (const n of [...mem, ...others.filter((o) => o.on.has(h.key)).map((o) => o.pt)]) {
      if (joined.has(n.key) || !shape.sees([pt.x, pt.y], [n.x, n.y])) continue;
      joined.add(n.key);
      out.push(h.kind === 'area' ? areaEdge(w, h.key, pt, n) : surfaceEdge(w, h.key, pt, n));
    }
  }
  return out;
}

/** (x, y, z) 에서 5 cm 안의 첫 노드(꾸러미 순서). */
export function nodeAt(nodes: MapNode[], x: number, y: number, z: number): MapNode | null {
  return nodes.find((n) => Math.hypot(n.x - x, n.y - y, n.z - z) <= NODE_AT_M) ?? null;
}

/** 25 m·높이 차 2 m 안 가장 가까운(3D) 노드. */
export function nearestNode(nodes: MapNode[], x: number, y: number, z: number): MapNode | null {
  let best: MapNode | null = null,
    bd = Infinity;
  for (const n of nodes) {
    if (Math.abs(n.z - z) > ATTACH_DZ_M || Math.hypot(n.x - x, n.y - y) > ATTACH_RADIUS_M) continue;
    const d = Math.hypot(n.x - x, n.y - y, n.z - z);
    if (d < bd) {
      best = n;
      bd = d;
    }
  }
  return best;
}

/** 높이를 모르는 점(GPS): (x, y) 를 덮는 면 가운데 높이가 가장 가까운 바깥 노드(평면 50 m 안) 높이에 가까운 면의 높이. 덮는 면이 없으면 null. */
export function surfaceHeightAt(w: WalkIndex, nodes: MapNode[], x: number, y: number): number | null {
  const cands: number[] = [];
  for (const [ak, a] of w.areas) if (a.z !== null && w.areaRings.get(ak)!.covers([x, y])) cands.push(a.z);
  for (const [sk, s] of w.surfaces) if (w.surfaceRegions.get(sk)!.covers([x, y])) cands.push(surfaceZ(s.top, x, y));
  if (!cands.length) return null;
  let ref: MapNode | null = null,
    rd = 50;
  for (const n of nodes) {
    if (n.location !== 'outdoor') continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= rd) {
      ref = n;
      rd = d;
    }
  }
  if (!ref) return cands[0];
  const rz = ref.z;
  return cands.reduce((b, c) => (Math.abs(c - rz) < Math.abs(b - rz) ? c : b));
}
