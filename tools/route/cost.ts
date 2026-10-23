// 경로 방식별 길 비용: 서버(campus-backend mapdata/routing.py·indicators.py)와 같은 규칙을 기기에서.
// 꾸러미에 지표가 없는 길(옛 꾸러미·열린 면 가상 간선)은 서버처럼 길 선으로 지표를 계산한다.
// 서버 쪽을 바꾸면 여기도 바꾸고 scripts/build-route-fixture.py 로 비교 자료를 다시 만든다.
import type { Access, EdgeIndicators, EdgeKind, ModeSpec, WalkArea, XYZ } from '../map/package';

export type RouteEdgeKind = EdgeKind | 'open_area';
/** 그래프의 길: 꾸러미 길 + 열린 면 가상 간선(kind open_area). */
export interface RouteEdge {
  key: string;
  from: string;
  to: string;
  name: string | null;
  kind: RouteEdgeKind;
  areaKind?: WalkArea['kind'] | 'surface';
  /** 걷는 면 가상 간선이면 그 면 */
  surfaceKey?: string;
  pedestrianAccess: Access;
  wheelchairAccess: Access;
  lengthM: number;
  stepCount: number | null;
  widthM: number | null;
  geometry: XYZ[];
  indicators?: EdgeIndicators;
}

const WALK_MPS = 1.2;
const SLOPE_WINDOW_M = 2.0;
const STEP_RISE_EST_M = 0.16;
const STEP_RUN_M = 0.3;
const STEP_UP_S = 0.6;
const STEP_DOWN_S = 0.5;
export const ELEVATOR_WAIT_S = 30.0;
const ELEVATOR_MPS = 1.0;
const ELEVATOR_STOP_S = 8.0;
const WHEELCHAIR_MAX_SLOPE_PCT = 8.33;
const WHEELCHAIR_COMFORT_SLOPE_PCT = 5.56;
const WHEELCHAIR_MIN_WIDTH_M = 0.9;

const COMMON = { pedestrianUnknown: 1.2, vehicleRoadWalk: 1.1, vehicleRoad: 1.5, openArea: 1.02 };
/** 꾸러미에 routeModes 가 없을 때 쓰는 규칙(서버 MODE_SPEC 과 같음). */
export const DEFAULT_MODE_SPEC: Record<string, ModeSpec> = {
  shortest: { label: '최단 거리', base: 'lengthM', exclude: [], mult: { ...COMMON } },
  fastest: { label: '가장 빠른 길', base: 'walkS', exclude: [], mult: { ...COMMON }, elevatorWaitS: ELEVATOR_WAIT_S },
  avoidStairs: { label: '계단 없이', base: 'lengthM', exclude: ['stairs'], mult: { ...COMMON } },
  accessible: {
    label: '휠체어·유모차',
    base: 'lengthM',
    exclude: ['stairs', 'wheelchairNo'],
    mult: { ...COMMON, wheelchairSteep: 2.0, wheelchairUnknown: 1.5 },
  },
  preferElevator: { label: '승강기 우선', base: 'lengthM', exclude: [], mult: { ...COMMON, stairs: 4.0, elevator: 0.5 } },
  rainProtected: { label: '비 안 맞는 길', base: 'lengthM', exclude: [], mult: { ...COMMON }, exposure: { rain: 2.0 } },
  nightSafe: { label: '밤에 밝은 길', base: 'lengthM', exclude: [], mult: { ...COMMON }, exposure: { dark: 1.0, vehicle: 0.5 } },
};

/** 파이썬 round(x, n) 과 같게: 값 그대로의 10진 전개에서 반올림, 딱 절반이면 짝수 쪽. */
export function pyRound(x: number, n = 0): number {
  const near = Number(x.toFixed(n));
  let full: string;
  try {
    full = Math.abs(x).toFixed(100);
  } catch {
    return near;
  }
  const dot = full.indexOf('.');
  const rest = full.slice(dot + 1 + n);
  if (!/^50*$/.test(rest)) return near;
  const cut = full.slice(0, n ? dot + 1 + n : dot); // 0 쪽으로 자른 값
  const last = Number(cut[cut.length - 1]);
  return last % 2 === 0 ? Math.sign(x) * Number(cut) : near;
}

const dist2 = (a: XYZ, b: XYZ) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function toblerS(h: number, dz: number): number {
  if (h <= 0) return 0;
  const g = dz / h;
  const v = (WALK_MPS * Math.exp(-3.5 * Math.abs(g + 0.05))) / Math.exp(-3.5 * 0.05);
  return h / v;
}

/** (수평 길이, 높이 차) 묶음: 수평 2 m 가 찰 때까지 잇고, 끝의 짧은 묶음은 앞 묶음에 붙인다. */
function windows(g: XYZ[]): [number, number][] {
  const out: [number, number][] = [];
  let h = 0,
    dz = 0;
  for (let i = 1; i < g.length; i++) {
    h += dist2(g[i - 1], g[i]);
    dz += g[i][2] - g[i - 1][2];
    if (h >= SLOPE_WINDOW_M) {
      out.push([h, dz]);
      h = 0;
      dz = 0;
    }
  }
  if (h > 0 || dz) {
    if (out.length && h < SLOPE_WINDOW_M) {
      const [ph, pdz] = out.pop()!;
      out.push([ph + h, pdz + dz]);
    } else out.push([h, dz]);
  }
  return out;
}

const stepsEstimate = (dz: number) => Math.max(1, pyRound(Math.abs(dz) / STEP_RISE_EST_M));

export function geometryIndicators(g: XYZ[], kind: RouteEdgeKind, steps: number | null) {
  let hor = 0,
    climb = 0,
    desc = 0;
  for (let i = 1; i < g.length; i++) {
    hor += dist2(g[i - 1], g[i]);
    climb += Math.max(0, g[i][2] - g[i - 1][2]);
    desc += Math.max(0, g[i - 1][2] - g[i][2]);
  }
  const net = g[g.length - 1][2] - g[0][2];
  let maxSlope: number | null = null;
  if (kind !== 'elevator' && hor >= 0.5) {
    maxSlope = 0;
    for (const [h, dz] of windows(g)) if (h > 0) maxSlope = Math.max(maxSlope, (Math.abs(dz) / h) * 100);
  }
  let fwd: number, back: number;
  if (kind === 'elevator') fwd = back = Math.abs(net) / ELEVATOR_MPS + ELEVATOR_STOP_S;
  else if (kind === 'stairs') {
    const n = steps || stepsEstimate(net);
    const flat = Math.max(0, hor - n * STEP_RUN_M) / WALK_MPS;
    const up = n * STEP_UP_S + flat,
      down = n * STEP_DOWN_S + flat;
    [fwd, back] = net >= 0 ? [up, down] : [down, up];
  } else {
    const w = windows(g);
    fwd = w.reduce((s, [h, dz]) => s + toblerS(h, dz), 0);
    back = w.reduce((s, [h, dz]) => s + toblerS(h, -dz), 0);
  }
  return {
    horizontalM: pyRound(hor, 2),
    climbM: pyRound(climb, 2),
    descentM: pyRound(desc, 2),
    maxSlopePct: maxSlope === null ? null : pyRound(maxSlope, 1),
    walkS: pyRound(fwd, 1),
    walkSBack: pyRound(back, 1),
  };
}

function wheelchairDerived(
  kind: RouteEdgeKind,
  maxSlope: number | null,
  width: number | null,
  source: Access,
): EdgeIndicators['wheelchair'] {
  if (source === 'prohibited') return 'no';
  if (source === 'allowed') return 'yes';
  if (kind === 'stairs') return 'no';
  if (width !== null && width < WHEELCHAIR_MIN_WIDTH_M) return 'no';
  if (kind === 'elevator') return 'likely';
  if (maxSlope === null) return 'unknown';
  if (maxSlope > WHEELCHAIR_MAX_SLOPE_PCT) return 'no';
  if (maxSlope > WHEELCHAIR_COMFORT_SLOPE_PCT) return 'steep';
  return 'likely';
}

/** 구조물 없이 길 하나로 낼 수 있는 지표(서버 basic_indicators). */
export function basicIndicators(e: RouteEdge, indoor: boolean): EdgeIndicators {
  const g = geometryIndicators(e.geometry, e.kind, e.stepCount);
  const vehicle = e.kind === 'vehicle_road' ? 'shared' : e.kind === 'crossing' ? 'crossing' : indoor ? 'none' : null;
  return {
    ...g,
    indoor,
    steps: e.kind === 'stairs' ? e.stepCount || stepsEstimate(g.climbM - g.descentM) : null,
    minWidthM: e.widthM,
    coveredRatio: indoor ? 1.0 : null,
    litRatio: null,
    vehicle,
    wheelchair: wheelchairDerived(e.kind, g.maxSlopePct, e.widthM, e.wheelchairAccess ?? 'unknown'),
  };
}

/** 길 하나의 비용. 못 지나가면 null. reverse: to→from 으로 감, boarding: 승강기에 이제 탐. */
export function edgeCost(e: RouteEdge, i: EdgeIndicators, spec: ModeSpec, reverse: boolean, boarding: boolean): number | null {
  if (spec.exclude.includes('stairs') && e.kind === 'stairs') return null;
  if (spec.exclude.includes('wheelchairNo') && i.wheelchair === 'no') return null;
  const m = spec.mult;
  let c: number;
  if (spec.base === 'walkS') {
    c = reverse ? i.walkSBack : i.walkS;
    if (boarding && e.kind === 'elevator') c += spec.elevatorWaitS ?? 0;
  } else c = e.lengthM;
  if (e.kind === 'stairs' || e.kind === 'elevator') c *= m[e.kind] ?? 1;
  if (e.pedestrianAccess === 'unknown') c *= m.pedestrianUnknown;
  if (e.kind === 'vehicle_road') c *= e.pedestrianAccess === 'allowed' ? m.vehicleRoadWalk : m.vehicleRoad;
  if (e.kind === 'open_area') c *= m.openArea;
  if (i.wheelchair === 'steep') c *= m.wheelchairSteep ?? 1;
  if (i.wheelchair === 'unknown') c *= m.wheelchairUnknown ?? 1;
  const x = spec.exposure ?? {};
  if (x.rain !== undefined) c *= 1 + x.rain * (1 - (i.coveredRatio || 0));
  if (x.dark !== undefined && !i.indoor) c *= 1 + x.dark * (1 - (i.litRatio || 0));
  if (x.vehicle !== undefined && (i.vehicle === 'shared' || i.vehicle === 'crossing')) c *= 1 + x.vehicle;
  return c;
}
