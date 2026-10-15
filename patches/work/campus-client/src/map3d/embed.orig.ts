// 3D 지도 페이지(campus-tracker frontend/client3d.html)와 주고받는 메시지 v1. 화면·RN 에 의존하지 않음(시험 가능).
// 페이지 쪽 정의: campus-tracker frontend/src/client3d-protocol.ts. 바꾸면 둘 다 바꾼다.
import type { MapPackage, XYZ } from '../map/package';
import type { Graph, RouteResult } from '../route/route';
import type { Fix } from '../location/fix';
import { epsg5186ToWgs84 } from '../location/projection';
import { DEV_HOST } from '../config/devHost';

export const V = 1;

export type Map3dCommand =
  | {
      v: 1;
      type: 'setLocation';
      lon: number;
      lat: number;
      z: number | null;
      accuracyM: number;
      floor: string | null;
      building: string | null;
      state: 'ok' | 'uncertain';
    }
  | { v: 1; type: 'clearLocation' }
  | { v: 1; type: 'setRoute'; points: XYZ[]; floorChanges: { at: XYZ; label: string | null }[] }
  | { v: 1; type: 'clearRoute' }
  | { v: 1; type: 'focus'; x: number; y: number; z: number | null; building: string | null; floor: string | null }
  | { v: 1; type: 'setFloor'; building: string; floor: string | null; explode?: boolean }
  | { v: 1; type: 'setMarkerImages'; ok: string; uncertain: string };

export type Map3dEvent =
  | { v: 1; type: 'ready'; buildings: { id: string; name: string }[]; light: boolean }
  | { v: 1; type: 'pick'; kind: 'building' | 'place' | 'point'; id?: string; name?: string; x: number; y: number; z: number }
  | { v: 1; type: 'cameraChanged'; x: number; y: number; heightM: number; headingDeg: number; pitchDeg: number }
  | { v: 1; type: 'floorChanged'; building: string | null; floor: string | null; explode: boolean }
  | { v: 1; type: 'error'; error: string; command?: string };

/** 꾸러미 건물 key("b:북악관") ↔ 3D 장면 건물 id("북악관"). 장소 key("p:<id>") ↔ 장면 장소 id. */
export const sceneBuildingId = (buildingKey: string) => buildingKey.replace(/^b:/, '');
export const packageBuildingKey = (sceneId: string) => `b:${sceneId}`;
export const packagePlaceKey = (sceneId: string) => `p:${sceneId}`;

/** 받은 사건(객체 또는 JSON 문자열)을 확인. 모르는 것·v 가 다른 것은 null. */
export function parseEvent(raw: unknown): Map3dEvent | null {
  let d = raw;
  if (typeof raw === 'string') {
    try {
      d = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== 'object') return null;
  const e = d as Record<string, unknown>;
  if (e.v !== V || typeof e.type !== 'string') return null;
  const n = (k: string) => typeof e[k] === 'number' && Number.isFinite(e[k] as number);
  switch (e.type) {
    case 'ready':
      return Array.isArray(e.buildings) ? (e as unknown as Map3dEvent) : null;
    case 'pick':
      return (e.kind === 'building' || e.kind === 'place' || e.kind === 'point') && n('x') && n('y') && n('z')
        ? (e as unknown as Map3dEvent)
        : null;
    case 'cameraChanged':
      return n('x') && n('y') ? (e as unknown as Map3dEvent) : null;
    case 'floorChanged':
    case 'error':
      return e as unknown as Map3dEvent;
    default:
      return null;
  }
}

/** 경로 → setRoute: 지나는 길의 모양 그대로(EPSG:5186, z), 층이 바뀌는 노드에 표시. */
export function routeCommand(g: Graph, r: Extract<RouteResult, { ok: true }>): Map3dCommand {
  const points: XYZ[] = [];
  const push = (p: XYZ) => {
    const l = points[points.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1] || l[2] !== p[2]) points.push(p);
  };
  const floorChanges: { at: XYZ; label: string | null }[] = [];
  let lastFloor = g.floorLabel(r.nodeKeys[0]);
  for (let i = 0; i < r.nodeKeys.length; i++) {
    const a = r.nodeKeys[i],
      b = r.nodeKeys[i + 1];
    const node = g.nodes.get(a)!;
    const label = g.floorLabel(a);
    if (label && lastFloor && label !== lastFloor) {
      const prev = floorChanges[floorChanges.length - 1],
        text = `→ ${label.split(' ').pop() ?? label}`;
      // 승강기·계단으로 여러 층을 지나면 한 자리에 한 표시(도착 층)
      if (prev && Math.hypot(prev.at[0] - node.x, prev.at[1] - node.y) < 3)
        floorChanges[floorChanges.length - 1] = { at: [node.x, node.y, node.z], label: text };
      else floorChanges.push({ at: [node.x, node.y, node.z], label: text });
    }
    if (label) lastFloor = label;
    if (!b) {
      push([node.x, node.y, node.z]);
      break;
    }
    const arcs = (g.adj.get(a) ?? []).filter((x) => x.to === b).sort((x, y) => x.edge.lengthM - y.edge.lengthM);
    const arc = arcs[0];
    if (!arc || arc.edge.geometry.length < 2) {
      push([node.x, node.y, node.z]);
      continue;
    }
    const geom = arc.forward ? arc.edge.geometry : [...arc.edge.geometry].reverse();
    for (const p of geom) push([p[0], p[1], p[2]]);
  }
  return { v: 1, type: 'setRoute', points, floorChanges };
}

/** 현재 위치 → setLocation. 불확실하면 state 'uncertain'(층·높이를 보내지 않음: 건물·층을 다시 확인하게). */
export function locationCommand(
  fix: Fix,
  where: { buildingKey: string | null; floorCode: string | null; z: number | null } = { buildingKey: null, floorCode: null, z: null },
): Map3dCommand {
  const { lon, lat } = epsg5186ToWgs84(fix.x, fix.y);
  const sure = !fix.uncertain;
  return {
    v: 1,
    type: 'setLocation',
    lon,
    lat,
    accuracyM: Math.min(5000, Math.max(0, fix.accuracyM ?? 50)),
    state: sure ? 'ok' : 'uncertain',
    z: sure ? where.z : null,
    floor: sure ? where.floorCode : null,
    building: sure && where.buildingKey ? sceneBuildingId(where.buildingKey) : null,
  };
}

/** 층 고르기 → setFloor. 'all' 이면 floor null(건물 전체). */
export function floorCommand(pkg: MapPackage, buildingKey: string, floorKey: string, explode = false): Map3dCommand {
  const code = floorKey === 'all' ? null : (pkg.floors.find((f) => f.key === floorKey)?.code ?? null);
  return { v: 1, type: 'setFloor', building: sceneBuildingId(buildingKey), floor: code, explode };
}

/** 페이지 주소 + 가벼운 모드(light=1) + 페이지 자체 층 판 숨김(ui=min: 앱이 층 고르기를 보여 줄 때). */
export function pageUrl(base: string, light = false, minimal = false): string {
  const u = base.trim() || DEFAULT_MAP3D_URL;
  const q = [light ? 'light=1' : '', minimal ? 'ui=min' : ''].filter(Boolean).join('&');
  return q ? `${u}${u.includes('?') ? '&' : '?'}${q}` : u;
}
export const DEFAULT_MAP3D_URL = `http://${DEV_HOST}:5273/client3d.html`;
