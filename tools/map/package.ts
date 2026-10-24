// 지도 꾸러미 형식 v1 (schemaVersion 1). 설명: docs/map-package-v1.md
// 좌표는 EPSG:5186 미터 (x 동, y 북, z 해발 m). 꾸러미 안의 참조는 모두 문자열 key.

export const SCHEMA_VERSION = 1 as const;

export type Location = 'outdoor' | 'indoor';
export type EdgeKind = 'walkway' | 'sidewalk' | 'crossing' | 'corridor' | 'stairs' | 'ramp' | 'elevator' | 'vehicle_road';
export type Direction = 'both' | 'forward' | 'backward';
export type Access = 'allowed' | 'prohibited' | 'unknown';
export type XYZ = [number, number, number];
export type XY = [number, number];

export interface Release {
  version: number;
  createdAt: string;
  source: string;
}
export interface Campus {
  code: string;
  name: string;
  crs: 5186;
}
export interface Building {
  key: string;
  name: string;
  aliases: string[];
  center: XY | null;
  footprint: XY[] | null;
}
export interface Floor {
  key: string;
  buildingKey: string;
  code: string; // "B1", "1F"
  sortOrder: number; // 아래층일수록 작음
  floorZ: number | null;
  zEstimated: boolean;
}
export interface MapNode {
  key: string;
  location: Location;
  buildingKey: string | null; // indoor 면 필수
  floorKey: string | null; // outdoor 면 null, indoor 인데 층 모르면 null
  kind: string;
  x: number;
  y: number;
  z: number;
  estimated: boolean;
  /** 노드 지표(서버 꾸러미 선택 칸): 가까운 표지 등 */
  indicators?: NodeIndicators;
}
/** 길 지표(서버가 가져올 때 계산, 꾸러미 선택 칸). 없는 칸 = 모름. 경로 계산에 쓰는 것만 적음. */
export interface EdgeIndicators {
  horizontalM?: number;
  climbM: number;
  descentM: number;
  maxSlopePct: number | null;
  /** 정방향(from→to)·역방향 걷는 시간(초) */
  walkS: number;
  walkSBack: number;
  indoor?: boolean;
  steps?: number | null;
  minWidthM?: number | null;
  /** 지붕 덮인 비율 0~1, null 은 모름 */
  coveredRatio?: number | null;
  /** 가로등 밝힌 비율 0~1, null 은 모름 */
  litRatio?: number | null;
  vehicle?: 'shared' | 'crossing' | 'adjacent' | 'none' | null;
  wheelchair?: 'yes' | 'likely' | 'steep' | 'unknown' | 'no';
  [k: string]: unknown;
}
export interface NodeIndicators {
  landmark?: { key: string; name: string; distM: number };
  [k: string]: unknown;
}
/** 경로 방식 하나의 비용 규칙(서버 MODE_SPEC 과 같은 모양). */
export interface ModeSpec {
  label: string;
  base: 'lengthM' | 'walkS';
  exclude: ('stairs' | 'wheelchairNo')[];
  mult: Record<string, number>;
  exposure?: { rain?: number; dark?: number; vehicle?: number };
  elevatorWaitS?: number;
  note?: string;
}
export interface Edge {
  key: string;
  from: string;
  to: string;
  name: string | null;
  kind: EdgeKind;
  direction: Direction;
  pedestrianAccess: Access;
  wheelchairAccess: Access;
  lengthM: number;
  stepCount: number | null;
  widthM: number | null;
  geometry: XYZ[];
  estimated: boolean;
  indicators?: EdgeIndicators;
}
export interface Place {
  key: string;
  location: Location;
  buildingKey: string | null;
  floorKey: string | null;
  nodeKey: string | null; // 경로가 붙는 노드. null 이면 경로 못 냄
  name: string;
  aliases: string[];
  category: string;
  x: number;
  y: number;
  z: number;
}
export interface WalkArea {
  key: string;
  location: Location;
  floorKey: string | null;
  name: string;
  kind: 'field' | 'plaza' | 'parking_aisle' | 'other';
  polygon: XY[];
  z: number | null;
  estimated: boolean;
}
export interface WalkAreaNode {
  areaKey: string;
  nodeKey: string;
}
/** 걷는 면 윗면: 한 높이 또는 한 방향 기울기(origin 에서 direction 쪽으로 잰 거리마다 높이, 사이는 직선, 끝 밖은 끝 높이). */
export type SurfaceTop = { z: number } | { profile: { origin: XY; direction: XY; points: [number, number][] } };
/** 걷는 면(서버 꾸러미 선택 칸): 구조물 기단 ∩ 사람 다니는 곳 − 건물·솟은 구조물. 기울어진 면도 있음. */
export interface WalkSurface {
  key: string;
  name: string;
  material: string | null;
  top: SurfaceTop;
  /** [[바깥 고리, 구멍 고리...], ...] (고리는 닫지 않은 꼭짓점 목록) */
  polygons: XY[][][];
  platforms?: string[];
  estimated: boolean;
}
export interface WalkSurfaceNode {
  surfaceKey: string;
  nodeKey: string;
}
/** 보행 그물 칸 등급(꾸러미 공용 표 walkMeshClasses 한 줄): 방식별 1 m 비용(ppm 정수, 서버 MODE_SPEC 순서,
 * null = 못 지나감)과 지표. */
export interface WalkMeshClass {
  f: (number | null)[];
  coveredRatio: number | null;
  litRatio: number | null;
  vehicle: string | null;
  slopePct: number | null;
}
/** 보행 그물(서버 꾸러미 선택 칸): 걷는 면·길 띠를 정사각형 칸(가운데 꼭짓점으로 세모 넷)으로 덮은 격자.
 * 격자 점 (i, j) → origin + cell·(i·ux − j·uy, i·uy + j·ux). tris = 칸마다 4 비트(S1·E2·N4·W8, 한 바이트에 두 칸) base64,
 * cls = 칸 등급 번호(공용 표 walkMeshClasses 번호) run-length [번호, 개수, ...]. 높이는 top(면·실내 바닥) 또는
 * 길 edge 중심선(띠). seams = 같은 높이로 맞닿은 뒤 그물과의 이음 [그물 key, [꼭짓점, 꼭짓점, ...]].
 * 실내 바닥(floor)은 floorKey·buildingKey 층에 속한다. 설명: src/route/mesh.ts */
export interface WalkMesh {
  key: string;
  kind: 'surface' | 'band' | 'floor';
  sources: string[];
  name: string;
  areaKind: string;
  top?: SurfaceTop;
  edge?: string;
  widthM?: number;
  origin: XY;
  axis: XY;
  cell: number;
  cols: number;
  rows: number;
  tris: string;
  cover: number;
  cls: number[];
  seams?: [string, number[]][];
  floorKey?: string;
  buildingKey?: string;
}
export interface MapPackage {
  schemaVersion: 1;
  release: Release;
  campus: Campus;
  buildings: Building[];
  floors: Floor[];
  nodes: MapNode[];
  edges: Edge[];
  places: Place[];
  walkAreas: WalkArea[];
  walkAreaNodes: WalkAreaNode[];
  /** 걷는 면과 면 위 노드(선택 칸). 같은 면 위 노드끼리 면 안 직선으로 가로지른다 */
  walkSurfaces?: WalkSurface[];
  walkSurfaceNodes?: WalkSurfaceNode[];
  /** 경로 방식별 비용 규칙(서버 꾸러미 선택 칸). 없으면 앱에 든 같은 규칙 */
  routeModes?: Record<string, ModeSpec>;
  /** 보행 그물(선택 칸). 있으면 경로를 그물로 찾는다(src/route/mesh.ts) */
  walkMeshes?: WalkMesh[];
  /** 보행 그물 칸 등급 공용 표(walkMeshes 의 cls 번호가 가리킨다) */
  walkMeshClasses?: WalkMeshClass[];
}

export type ValidationResult = { ok: true; pkg: MapPackage } | { ok: false; errors: string[] };

const EDGE_KINDS: EdgeKind[] = ['walkway', 'sidewalk', 'crossing', 'corridor', 'stairs', 'ramp', 'elevator', 'vehicle_road'];
const DIRECTIONS: Direction[] = ['both', 'forward', 'backward'];
const ACCESS: Access[] = ['allowed', 'prohibited', 'unknown'];
const LOCATIONS: Location[] = ['outdoor', 'indoor'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isArr = Array.isArray;

/** 받은 JSON 이 형식 v1 을 지키는지 확인한다. 오류는 최대 50개까지 모은다. */
export function validatePackage(input: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 50) errors.push(m);
  };
  const p = input as Record<string, any>;
  if (!p || typeof p !== 'object') return { ok: false, errors: ['꾸러미가 객체가 아님'] };
  if (p.schemaVersion !== SCHEMA_VERSION) return { ok: false, errors: [`schemaVersion ${p.schemaVersion} 지원 안 함`] };
  if (!p.release || !isNum(p.release.version) || !isStr(p.release.createdAt)) err('release 형식 오류');
  if (!p.campus || !isStr(p.campus.code) || p.campus.crs !== 5186) err('campus 형식 오류 (crs 5186)');
  for (const k of ['buildings', 'floors', 'nodes', 'edges', 'places', 'walkAreas', 'walkAreaNodes']) {
    if (!isArr(p[k])) err(`${k} 가 배열이 아님`);
  }
  if (errors.length) return { ok: false, errors };

  const uniq = (list: any[], name: string) => {
    const s = new Set<string>();
    for (const o of list) {
      if (!isStr(o.key)) err(`${name}: key 없음`);
      else if (s.has(o.key)) err(`${name}: key 중복 ${o.key}`);
      else s.add(o.key);
    }
    return s;
  };
  const bKeys = uniq(p.buildings, 'building');
  const fKeys = uniq(p.floors, 'floor');
  const nKeys = uniq(p.nodes, 'node');
  uniq(p.edges, 'edge');
  uniq(p.places, 'place');
  const aKeys = uniq(p.walkAreas, 'walkArea');

  const floorCodes = new Set<string>();
  for (const f of p.floors) {
    if (!bKeys.has(f.buildingKey)) err(`floor ${f.key}: 건물 없음 ${f.buildingKey}`);
    const c = `${f.buildingKey}/${f.code}`;
    if (floorCodes.has(c)) err(`floor ${f.key}: 같은 건물에 층 코드 중복 ${f.code}`);
    floorCodes.add(c);
    if (!isNum(f.sortOrder)) err(`floor ${f.key}: sortOrder`);
  }
  const located = (o: any, name: string) => {
    if (!LOCATIONS.includes(o.location)) err(`${name} ${o.key}: location`);
    if (o.location === 'outdoor' && (o.floorKey != null || o.buildingKey != null)) err(`${name} ${o.key}: outdoor 인데 건물·층 있음`);
    if (o.location === 'indoor' && !bKeys.has(o.buildingKey)) err(`${name} ${o.key}: indoor 인데 건물 없음`);
    if (o.floorKey != null && !fKeys.has(o.floorKey)) err(`${name} ${o.key}: 층 없음 ${o.floorKey}`);
    if (!isNum(o.x) || !isNum(o.y) || !isNum(o.z)) err(`${name} ${o.key}: 좌표`);
  };
  for (const n of p.nodes) located(n, 'node');
  for (const pl of p.places) {
    located(pl, 'place');
    if (!isStr(pl.name)) err(`place ${pl.key}: name`);
    if (!isArr(pl.aliases)) err(`place ${pl.key}: aliases`);
    if (pl.nodeKey != null && !nKeys.has(pl.nodeKey)) err(`place ${pl.key}: 노드 없음 ${pl.nodeKey}`);
  }
  for (const e of p.edges) {
    if (!nKeys.has(e.from) || !nKeys.has(e.to)) err(`edge ${e.key}: 끝 노드 없음`);
    if (e.from === e.to) err(`edge ${e.key}: 양 끝이 같음`);
    if (!EDGE_KINDS.includes(e.kind)) err(`edge ${e.key}: kind ${e.kind}`);
    if (!DIRECTIONS.includes(e.direction)) err(`edge ${e.key}: direction ${e.direction}`);
    if (!ACCESS.includes(e.pedestrianAccess)) err(`edge ${e.key}: pedestrianAccess`);
    if (!isNum(e.lengthM) || e.lengthM <= 0) err(`edge ${e.key}: lengthM`);
    if (!isArr(e.geometry) || e.geometry.length < 2) err(`edge ${e.key}: geometry`);
  }
  for (const a of p.walkAreas) {
    if (!isArr(a.polygon) || a.polygon.length < 3) err(`walkArea ${a.key}: polygon`);
  }
  for (const wn of p.walkAreaNodes) {
    if (!aKeys.has(wn.areaKey) || !nKeys.has(wn.nodeKey)) err(`walkAreaNode ${wn.areaKey}/${wn.nodeKey}: 참조 오류`);
  }
  if (p.walkSurfaces !== undefined || p.walkSurfaceNodes !== undefined) {
    if (!isArr(p.walkSurfaces) || !isArr(p.walkSurfaceNodes)) err('walkSurfaces·walkSurfaceNodes 가 배열이 아님');
    else {
      const sKeys = uniq(p.walkSurfaces, 'walkSurface');
      for (const s of p.walkSurfaces) if (!isArr(s.polygons) || !s.top) err(`walkSurface ${s.key}: polygons·top`);
      for (const w of p.walkSurfaceNodes)
        if (!sKeys.has(w.surfaceKey) || !nKeys.has(w.nodeKey)) err(`walkSurfaceNode ${w.surfaceKey}/${w.nodeKey}: 참조 오류`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, pkg: p as MapPackage };
}
