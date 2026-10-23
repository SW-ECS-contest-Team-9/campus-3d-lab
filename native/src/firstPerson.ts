// 1인칭 길 안내: 경로 선 위 눈높이 1.6 m 로 걸어가며 앞을 봄. 층이 바뀌는 곳(계단·승강기)은 어둡게 했다가 다음 층에서 다시 밝힘.
// 실내에서는 지금 층의 실내 빈 곳(i| 노드: 바닥·벽·천장)만 보이고, 서 있는 건물 껍데기(지붕·위층)는 숨김.
// 실내 자료가 없는데 머리 위가 막힌 구간(지하 통로 등)은 경로를 따라 단순한 통로(바닥·벽·천장)를 만들어 보임.
// 바닥에 경로 띠(지금 층 구간만, 묻힌 곳은 옅게 비쳐 보임)와 다음 꺾임 화살표, 글 안내(onHud)를 냄. 장면 자료는 바꾸지 않음(보이기만 바꿈).
// campus-3d-lab native/src/firstPerson.ts 와 campus-client src/map3d/native/firstPerson.ts 는 같은 파일(한쪽을 고치면 복사).
import * as THREE from 'three';

export const FP = {
  eyeM: 1.6,
  /** 걷는 속도(m/s). 미리 보기는 speed 배수로(1~3배) */
  speedMps: 1.4,
  maxSpeed: 3,
  /** 이만큼 앞의 경로 점을 봄(m) — 짧으면 꺾일 때 고개를 홱 돌리고, 길면 모퉁이를 미리 질러 봄 */
  lookAheadM: 6,
  /** 세로 시야각(도) 범위와 바라는 가로 시야각: 세로 화면에서 가로 시야가 너무 좁지 않게 세로 시야를 이 범위에서 넓힘(멀미 권장 65~75°) */
  fovMinDeg: 65,
  fovMaxDeg: 75,
  wantHfovDeg: 60,
  /** 고개 돌림 부드럽게: 시간 상수(s)와 최대 속도(도/s) — 멀미 줄이기 */
  yawTauS: 0.35,
  maxYawDegPerS: 75,
  /** 내려다보는 각(도): 바닥 띠가 화면 아래쪽에 보이게 */
  pitchDeg: -12,
  fadeS: 0.35,
  ribbonW: 0.9,
  /** 띠가 구조물에 묻힌 곳도 보이게 겹쳐 그리는 옅은 띠의 불투명도 */
  ghostOpacity: 0.35,
  /** 이 각도 넘게 꺾이면 '꺾임'(도), 이 거리 안이면 화살표·안내 */
  turnDeg: 35,
  turnReachM: 40,
  /** 층 바뀜 판단: 기울기(높이/수평) 넘고 높이차 합이 이만큼 이상(m) */
  steep: 0.35,
  levelChangeM: 1.2,
  /** 지금 층 실내를 보일 거리(m) */
  interiorReachM: 150,
  /** 따라가기(걸으며): 카메라가 목표 거리(보정 위치의 경로 위 거리)를 쫓는 시간 상수(s)와 최대 속도(m/s) — 위치가 튀어도 부드럽게 */
  followTauS: 0.8,
  followMaxMps: 3,
  /** 덮인 통로: 머리 위(발 + 이 높이 넘게) 면이 있고 실내 자료가 없는 구간이 이만큼 이상 이어지면(m) 통로를 만들어 보임 */
  coverAboveM: 2.2,
  coverMinM: 3,
  tunnelW: 3.2,
  tunnelH: 2.7,
};

export interface FpInterior { node: THREE.Mesh; m: number; floor: string; rings: number[][][] }
export interface FpSurface { top: number | null; ceil: number | null }
export interface FpHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  fromTm: (x: number, y: number, z: number) => THREE.Vector3;
  toTm: (p: THREE.Vector3) => { x: number; y: number; z: number };
  buildings: THREE.Mesh[];
  interiors: FpInterior[];
  /** 1인칭 동안 숨길 것(위에서 보는 경로·위치 표지) */
  hide: THREE.Object3D[];
  /** 실내에 있을 때 숨길 바깥 층(지형·구조물·길 면·선): 실내 바닥보다 높은 바깥 바닥이 앞을 가림 */
  outdoor: THREE.Object3D[];
  /**
   * 경로 점마다 발밑 윗면(top: 발 −0.5 ~ +0.4 m 안에서 가장 높은 면 — 인도 턱 등)과 머리 위 면(ceil: 발 + coverAboveM 넘는 가장 낮은 면).
   * top 이 발보다 높으면 발을 윗면으로 올림(0.4 m 넘게 높으면 화단·벽 윗면이라 무시).
   */
  surfaces?: (pts: THREE.Vector3[]) => FpSurface[];
  /** 보이는 부분의 가로/세로 비(앱 카드가 화면 일부를 가리면 그 나머지). 없으면 camera.aspect */
  viewAspect?: () => number;
  /** 보이는 부분의 세로 시야를 deg 로(앱이 투영을 옮겨 쓰면 그에 맞춰). 없으면 camera.fov = deg */
  setFov?: (deg: number) => void;
}
export interface FpStep { kind: string; floorChange: boolean; toFloor: string | null }
export interface Hud { text: string; sub: string; floor: string | null; turn: 'left' | 'right' | 'up' | 'down' | 'arrive' | null; distM: number | null }
export interface FpProgress { s: number; total: number; playing: boolean; done: boolean; speed: number; follow: boolean; target: number | null }

interface Transition { i0: number; i1: number; s0: number; s1: number; kind: 'stairs' | 'elevator'; up: boolean; label: string }
interface Turn { s: number; i: number; dir: 'left' | 'right'; deg: number; heading: number }
interface Tunnel { s0: number; s1: number; mesh: THREE.Object3D }

const DEG = Math.PI / 180;
const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const inRing = (x: number, y: number, r: number[][]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
// 합친 바깥선: 바깥 고리 안이고 구멍 밖(짝홀 규칙으로 모든 고리를 세면 됨)
const inRings = (x: number, y: number, rings: number[][][]) => rings.reduce((c, r) => (inRing(x, y, r) ? !c : c), false);

/** 보이는 부분 가로/세로 비 → 세로 시야(도): 가로 시야가 wantHfovDeg 쯤 되게, 세로는 fovMin~fovMax 안 */
export function fpFov(aspect: number) {
  const v = (2 * Math.atan(Math.tan((FP.wantHfovDeg / 2) * DEG) / Math.max(0.1, aspect))) / DEG;
  return Math.min(FP.fovMaxDeg, Math.max(FP.fovMinDeg, v));
}

/**
 * 경로 점마다 발밑 윗면·머리 위 면(구조물·길 면·지형 메시): 삼각형을 한 번만 훑고 경로 점이 있는 2 m 칸만 봄
 * (점마다 광선을 쏘면 Hermes 에서 28 s). 세로 면(벽)은 뺌.
 */
export function scanSurfaces(targets: THREE.Object3D[], pts: THREE.Vector3[]): FpSurface[] {
  const C = 2, key = (x: number, z: number) => Math.floor(x / C) * 100003 + Math.floor(z / C);
  const cells = new Map<number, number[]>();
  pts.forEach((p, i) => { const k = key(p.x, p.z); const a = cells.get(k); if (a) a.push(i); else cells.set(k, [i]); });
  const out: FpSurface[] = pts.map(() => ({ top: null, ceil: null }));
  for (const obj of targets) obj.traverse((m: any) => {
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    m.updateWorldMatrix(true, false);
    const W = m.matrixWorld.elements as number[];
    // 장면 메시는 이동만 있다고 봄(회전·크기 없음) — 아니면 건너뜀
    if (Math.abs(W[0] - 1) > 1e-6 || Math.abs(W[5] - 1) > 1e-6 || Math.abs(W[10] - 1) > 1e-6) return;
    const ox = W[12], oy = W[13], oz = W[14];
    const P = m.geometry.attributes.position.array as ArrayLike<number>, I = m.geometry.index?.array as ArrayLike<number> | undefined;
    const n = I ? I.length : P.length / 3;
    for (let t = 0; t < n; t += 3) {
      const i0 = (I ? I[t] : t) * 3, i1 = (I ? I[t + 1] : t + 1) * 3, i2 = (I ? I[t + 2] : t + 2) * 3;
      const ax = P[i0] + ox, az = P[i0 + 2] + oz, bx = P[i1] + ox, bz = P[i1 + 2] + oz, cx = P[i2] + ox, cz = P[i2 + 2] + oz;
      const x0 = Math.floor(Math.min(ax, bx, cx) / C), x1 = Math.floor(Math.max(ax, bx, cx) / C), z0 = Math.floor(Math.min(az, bz, cz) / C), z1 = Math.floor(Math.max(az, bz, cz) / C);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) continue;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue; // 벽(세로 면)
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const list = cells.get(gx * 100003 + gz);
        if (!list) continue;
        for (const i of list) {
          const p = pts[i];
          const w0 = ((bz - cz) * (p.x - cx) + (cx - bx) * (p.z - cz)) / d, w1 = ((cz - az) * (p.x - cx) + (ax - cx) * (p.z - cz)) / d, w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const y = w0 * P[i0 + 1] + w1 * P[i1 + 1] + w2 * P[i2 + 1] + oy;
          const o = out[i];
          if (y > p.y - 0.5 && y < p.y + 0.4 && (o.top === null || y > o.top)) o.top = y;
          if (y > p.y + FP.coverAboveM && y < p.y + 60 && (o.ceil === null || y < o.ceil)) o.ceil = y;
        }
      }
    }
  });
  return out;
}

/** 층 이름 "북악관 6F" → "북악관 6층" */
const floorText = (f: string) => f.replace(/(\d+)F$/, '$1층');

export function createFirstPerson(host: FpHost, onHud?: (h: Hud) => void) {
  const { camera } = host;
  const group = new THREE.Group();
  group.visible = false;
  host.scene.add(group);
  // 어둡게 하기: 카메라에 붙은 검은 판
  const fadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const fade = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), fadeMat);
  fade.position.z = -0.2; fade.renderOrder = 1000; fade.visible = false;
  camera.add(fade);
  if (!camera.parent) host.scene.add(camera);
  const bbox = host.buildings.map((b) => new THREE.Box3().setFromObject(b));

  let pts: THREE.Vector3[] = [];
  let cum: number[] = [];
  let trans: Transition[] = [];
  let turns: Turn[] = [];
  let tunnels: Tunnel[] = [];
  let levels: { s0: number; s1: number; ribbon: THREE.Object3D }[] = [];
  let arrow: THREE.Mesh | null = null;
  const st = { follow: false, target: null as number | null, on: false, s: 0, yaw: 0, speed: 1, paused: false, fadeT: 0, phase: 'walk' as 'walk' | 'out' | 'in', pending: null as Transition | null, level: 0, visKey: '', hudKey: '', floor: null as string | null };
  const saved = { near: 1, far: 5000, fov: 45 };

  const total = () => cum[cum.length - 1] ?? 0;
  const posAt = (s: number) => {
    s = Math.min(Math.max(s, 0), total());
    let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const t = cum[i + 1] > cum[i] ? (s - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    return pts[i].clone().lerp(pts[i + 1], t);
  };
  const levelOf = (s: number) => Math.max(0, levels.findIndex((l) => s >= l.s0 - 1e-6 && s <= l.s1 + 1e-6));
  // 수평 방향(라디안, three 의 y 회전: 0 = −z(북)을 봄)
  const yawTo = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
  const headingAt = (s: number, ahead: number) => {
    const l = levels[levelOf(s)];
    const a = posAt(s), b = posAt(Math.min(l.s1, s + ahead));
    if (Math.hypot(b.x - a.x, b.z - a.z) < 0.3) { const c = posAt(Math.max(l.s0, s - 2)); return Math.hypot(a.x - c.x, a.z - c.z) > 0.3 ? yawTo(c, a) : st.yaw; }
    return yawTo(a, b);
  };

  /** 점 줄을 따라 너비 w 의 띠(높이 y0 만큼 띄움): 위치 배열과 색인 */
  function strip(sel: THREE.Vector3[], w: number, y0: number, pos: number[], idx: number[]) {
    const base = pos.length / 3;
    for (let i = 0; i < sel.length; i++) {
      const a = sel[Math.max(0, i - 1)], b = sel[Math.min(sel.length - 1, i + 1)];
      const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
      const side = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(w / 2);
      const p = sel[i];
      pos.push(p.x + side.x, p.y + y0, p.z + side.z, p.x - side.x, p.y + y0, p.z - side.z);
      if (i) { const k = base + 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
  }
  const pick = (from: number, to: number) => {
    const sel: THREE.Vector3[] = [];
    for (let i = from; i <= to; i++) if (!sel.length || sel[sel.length - 1].distanceTo(pts[i]) > 0.05) sel.push(pts[i]);
    return sel;
  };

  function ribbonMesh(from: number, to: number) {
    const g = new THREE.Group();
    const sel = pick(from, to);
    if (sel.length < 2) return g;
    const pos: number[] = [], idx: number[] = [];
    strip(sel, FP.ribbonW, 0.07, pos, idx);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const band = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b6fe0, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    band.renderOrder = 1;
    g.add(band);
    // 묻힌 곳(경로가 구조물 윗면보다 낮은 곳)도 보이게: 깊이 검사 없이 옅게 한 번 더(맨 나중에 그림)
    const ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b6fe0, side: THREE.DoubleSide, transparent: true, opacity: FP.ghostOpacity, depthTest: false, depthWrite: false }));
    ghost.renderOrder = 900;
    g.add(ghost);
    // 갈매기 표(3 m 마다): 가는 방향
    const cpos: number[] = [];
    let acc = 0;
    for (let i = 1; i < sel.length; i++) {
      const a = sel[i - 1], b = sel[i], len = a.distanceTo(b);
      for (let s = 3 - acc; s < len; s += 3) {
        const p = a.clone().lerp(b, s / len);
        const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize(), sd = new THREE.Vector3(-d.z, 0, d.x);
        const tip = p.clone().addScaledVector(d, 0.25), l1 = p.clone().addScaledVector(d, -0.15).addScaledVector(sd, 0.3), r1 = p.clone().addScaledVector(d, -0.15).addScaledVector(sd, -0.3);
        const m1 = p.clone().addScaledVector(d, 0.02);
        for (const q of [tip, l1, m1, tip, m1, r1]) cpos.push(q.x, q.y + 0.09, q.z);
      }
      acc = (acc + len) % 3;
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    const chev = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    chev.renderOrder = 2;
    g.add(chev);
    return g;
  }

  /** 덮인 통로(실내 자료 없음): 경로를 따라 바닥·양쪽 벽·천장(안쪽만 보이게 양면) */
  function tunnelMesh(from: number, to: number) {
    const sel = pick(from, to);
    const g = new THREE.Group();
    if (sel.length < 2) return g;
    const W = FP.tunnelW / 2, H = FP.tunnelH;
    const floor: number[] = [], fi: number[] = [], wall: number[] = [], wi: number[] = [], ceil: number[] = [], ci: number[] = [];
    strip(sel, FP.tunnelW, 0.01, floor, fi);
    strip(sel, FP.tunnelW, H, ceil, ci);
    // 벽: 양쪽 가장자리 선을 세움
    for (const sgn of [1, -1]) {
      const base = wall.length / 3;
      for (let i = 0; i < sel.length; i++) {
        const a = sel[Math.max(0, i - 1)], b = sel[Math.min(sel.length - 1, i + 1)];
        const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
        const p = sel[i], x = p.x - d.z * W * sgn, z = p.z + d.x * W * sgn;
        wall.push(x, p.y, z, x, p.y + H, z);
        if (i) { const k = base + 2 * i; wi.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
    }
    const mk = (pos: number[], idx: number[], color: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    };
    g.add(mk(floor, fi, 0xc9c3b6), mk(wall, wi, 0xe4e7eb), mk(ceil, ci, 0xf3f2ee));
    // 벽 아래 띠(어둡게): 바닥과 벽 경계를 또렷하게
    const sk: number[] = [], si: number[] = [];
    for (const sgn of [1, -1]) {
      const base = sk.length / 3;
      for (let i = 0; i < sel.length; i++) {
        const a = sel[Math.max(0, i - 1)], b = sel[Math.min(sel.length - 1, i + 1)];
        const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
        const p = sel[i], x = p.x - d.z * (W - 0.01) * sgn, z = p.z + d.x * (W - 0.01) * sgn;
        sk.push(x, p.y, z, x, p.y + 0.12, z);
        if (i) { const k = base + 2 * i; si.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
    }
    g.add(mk(sk, si, 0x78808c));
    return g;
  }

  function arrowMesh() {
    // 큰 화살표(길이 1.8 m)를 바닥에 눕혀 꺾인 뒤 방향을 가리킴
    const sh = new THREE.Shape();
    sh.moveTo(0, 1.0); sh.lineTo(0.7, 0.2); sh.lineTo(0.28, 0.2); sh.lineTo(0.28, -0.8); sh.lineTo(-0.28, -0.8); sh.lineTo(-0.28, 0.2); sh.lineTo(-0.7, 0.2); sh.closePath();
    const geo = new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
    const edge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x1d4ed8, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5 }));
    edge.scale.setScalar(1.18); edge.position.y = -0.005; edge.renderOrder = 3; m.renderOrder = 4;
    m.add(edge);
    return m;
  }

  /** 시야: 보이는 부분 비율에 맞춰(세로 화면이면 세로 시야를 넓혀 가로 시야 확보) */
  function fit() {
    if (!st.on) return;
    const deg = fpFov(host.viewAspect?.() ?? camera.aspect);
    if (host.setFov) host.setFov(deg);
    else { camera.fov = deg; camera.updateProjectionMatrix(); }
  }

  function start(points: number[][], steps: FpStep[] = [], opts: { speed?: number; paused?: boolean; follow?: boolean } = {}) {
    stop();
    pts = [];
    const raw = points.map(([x, y, z]) => host.fromTm(x, y, z));
    const surf = host.surfaces?.(raw) ?? [];
    const covered: boolean[] = [];
    raw.forEach((v, k) => {
      const t = host.toTm(v);
      const indoor = host.interiors.some((i) => Math.abs(i.m - v.y) < 0.7 && inRings(t.x, t.y, i.rings));
      const top = surf[k]?.top;
      if (!indoor && top != null && top > v.y) v.y = top;
      const cov = !indoor && surf[k]?.ceil != null;
      if (!pts.length || pts[pts.length - 1].distanceTo(v) > 0.01) { pts.push(v); covered.push(cov); }
      else covered[covered.length - 1] ||= cov;
    });
    if (pts.length < 2) return false;
    cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    // 층 바뀜: 가파른 구간이 이어지고 높이차가 크면
    trans = [];
    const changes = steps.filter((s) => s.floorChange);
    const steepAt = (k: number) => { const a = pts[k], b = pts[k + 1]; const dz = b.y - a.y; return Math.abs(dz) > 0.05 && Math.abs(dz) > FP.steep * Math.hypot(b.x - a.x, b.z - a.z); };
    for (let i = 0; i < pts.length - 1;) {
      if (!steepAt(i)) { i++; continue; }
      let j = i; while (j < pts.length - 1 && steepAt(j)) j++;
      const dz = pts[j].y - pts[i].y, dxy = Math.hypot(pts[j].x - pts[i].x, pts[j].z - pts[i].z);
      if (Math.abs(dz) >= FP.levelChangeM) {
        const step = changes[trans.length];
        // 종류는 경로 단계(계단·승강기)를 먼저 믿고, 없으면 모양(수평으로 거의 안 움직이면 승강기)
        const kind = step?.kind === 'elevator' || step?.kind === 'stairs' ? step.kind : dxy < 1.5 ? 'elevator' : 'stairs';
        const to = step?.toFloor ?? (dz > 0 ? '위층' : '아래층');
        trans.push({ i0: i, i1: j, s0: cum[i], s1: cum[j], kind, up: dz > 0, label: `${kind === 'elevator' ? '승강기로' : '계단으로'} ${floorText(to)}` });
      }
      i = j;
    }
    // 층 구간과 띠
    levels = [];
    let from = 0;
    for (const t of [...trans, null]) {
      const to = t ? t.i0 : pts.length - 1;
      const ribbon = ribbonMesh(from, to);
      ribbon.visible = false;
      group.add(ribbon);
      levels.push({ s0: cum[from], s1: cum[to], ribbon });
      if (t) from = t.i1;
    }
    // 덮인 통로: 머리 위가 막히고 실내 자료가 없는 점이 coverMinM 넘게 이어지는 곳(층 바뀜 구간 밖)
    tunnels = [];
    const inTrans = (i: number) => trans.some((t) => i > t.i0 && i < t.i1);
    for (let i = 0; i < pts.length;) {
      if (!covered[i] || inTrans(i)) { i++; continue; }
      let j = i; while (j + 1 < pts.length && covered[j + 1] && !inTrans(j + 1)) j++;
      const a = Math.max(0, i - 1), b = Math.min(pts.length - 1, j + 1);
      if (cum[b] - cum[a] >= FP.coverMinM) {
        const mesh = tunnelMesh(a, b);
        mesh.visible = false;
        group.add(mesh);
        tunnels.push({ s0: cum[a], s1: cum[b], mesh });
      }
      i = j + 1;
    }
    // 꺾임: 앞뒤 3 m 방향 차이
    turns = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const s = cum[i], l = levels[levelOf(s)];
      if (s - l.s0 < 1 || l.s1 - s < 1) continue;
      const a = posAt(Math.max(l.s0, s - 3)), b = posAt(Math.min(l.s1, s + 3)), p = pts[i];
      if (Math.hypot(p.x - a.x, p.z - a.z) < 0.5 || Math.hypot(b.x - p.x, b.z - p.z) < 0.5) continue;
      const d = wrap(yawTo(p, b) - yawTo(a, p));
      if (Math.abs(d) < FP.turnDeg * DEG) continue;
      const turn = { s, i, dir: d > 0 ? 'left' : 'right', deg: Math.abs(d) / DEG, heading: yawTo(p, b) } as Turn;
      const prev = turns[turns.length - 1];
      if (prev && s - prev.s < 4) { if (turn.deg > prev.deg) turns[turns.length - 1] = turn; continue; }
      turns.push(turn);
    }
    arrow = arrowMesh(); arrow.visible = false; group.add(arrow);
    saved.near = camera.near; saved.far = camera.far; saved.fov = camera.fov;
    camera.near = 0.1; camera.far = 2000;
    for (const o of host.hide) o.visible = false;
    group.visible = true;
    Object.assign(st, { follow: !!opts.follow, target: null, on: true, s: 0, speed: clampSpeed(opts.speed ?? 1), paused: !!opts.paused, fadeT: 0, phase: 'walk', pending: null, level: 0, visKey: '', hudKey: '' });
    fit();
    st.yaw = headingAt(0, FP.lookAheadM);
    place(0);
    return true;
  }

  function stop() {
    if (!st.on) return;
    st.on = false;
    for (const c of [...group.children]) { group.remove(c); c.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
    tunnels = []; levels = []; arrow = null;
    group.visible = false; fade.visible = false; fadeMat.opacity = 0;
    for (const o of host.hide) o.visible = true;
    for (const b of host.buildings) b.visible = true;
    for (const o of host.outdoor) o.visible = true;
    for (const i of host.interiors) i.node.visible = false;
    camera.near = saved.near; camera.far = saved.far; camera.fov = saved.fov; camera.updateProjectionMatrix();
  }

  /** 보이기: 실내(발이 그 층 빈 곳 안)면 그 높이의 실내만, 서 있는 건물 껍데기는 숨김. 덮인 통로면 만든 통로와 그 높이 실내만. */
  function visibility(feet: THREE.Vector3, force = false) {
    const t = host.toTm(feet);
    const here = host.interiors.find((i) => Math.abs(i.m - feet.y) < 0.7 && inRings(t.x, t.y, i.rings));
    const tun = here ? null : tunnels.find((u) => st.s >= u.s0 - 0.5 && st.s <= u.s1 + 0.5) ?? null;
    const key = here ? `${here.node.name}` : tun ? `t${tunnels.indexOf(tun)}` : `out`;
    st.floor = here ? `${here.node.name.split('|')[1]} ${here.floor}` : null;
    if (key === st.visKey && !force) return;
    st.visKey = key;
    const inside = !!here || !!tun;
    const m = here ? here.m : feet.y;
    for (const i of host.interiors) i.node.visible = inside && Math.abs(i.m - m) < 0.7 && near(i, feet);
    for (const u of tunnels) u.mesh.visible = u === tun;
    for (const o of host.outdoor) o.visible = !inside;
    host.buildings.forEach((b, k) => { const bb = bbox[k]; b.visible = !(inside && feet.x > bb.min.x - 1 && feet.x < bb.max.x + 1 && feet.z > bb.min.z - 1 && feet.z < bb.max.z + 1); });
  }
  const ibox = new Map<FpInterior, THREE.Box3>();
  const near = (i: FpInterior, p: THREE.Vector3) => {
    let b = ibox.get(i); if (!b) { b = new THREE.Box3().setFromObject(i.node, true); ibox.set(i, b); }
    return b.distanceToPoint(p) < FP.interiorReachM;
  };

  function place(dt: number) {
    const feet = posAt(st.s);
    const lv = levelOf(st.s);
    if (lv !== st.level || !levels[lv].ribbon.visible) { levels.forEach((l, k) => (l.ribbon.visible = k === lv)); st.level = lv; }
    // 고개: 앞 점을 향해 부드럽게(최대 속도 제한)
    const want = headingAt(st.s, FP.lookAheadM);
    if (dt <= 0) st.yaw = want;
    else { const d = wrap(want - st.yaw); const k = 1 - Math.exp(-dt / FP.yawTauS); const lim = FP.maxYawDegPerS * DEG * dt; st.yaw = wrap(st.yaw + Math.max(-lim, Math.min(lim, d * k))); }
    camera.position.set(feet.x, feet.y + FP.eyeM, feet.z);
    camera.rotation.set(FP.pitchDeg * DEG, st.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    visibility(feet);
    hud();
  }

  function hudAt(): Hud {
    const tNext = trans.find((t) => t.s0 >= st.s - 0.01);
    const turn = turns.find((t) => t.s > st.s + 0.5 && (!tNext || t.s < tNext.s0));
    const left = total() - st.s;
    if (st.phase !== 'walk' && st.pending) return { text: st.pending.label, sub: st.pending.kind === 'elevator' ? '승강기 타는 중' : '계단 오르내리는 중', floor: st.floor, turn: st.pending.up ? 'up' : 'down', distM: 0 };
    if (turn && turn.s - st.s < FP.turnReachM) return { text: `${Math.round(turn.s - st.s)} m 앞 ${turn.dir === 'left' ? '왼쪽' : '오른쪽'}`, sub: `도착까지 ${Math.round(left)} m`, floor: st.floor, turn: turn.dir, distM: turn.s - st.s };
    if (tNext && tNext.s0 - st.s < FP.turnReachM) return { text: `${Math.round(tNext.s0 - st.s)} m 앞 ${tNext.label}`, sub: `도착까지 ${Math.round(left)} m`, floor: st.floor, turn: tNext.up ? 'up' : 'down', distM: tNext.s0 - st.s };
    return { text: left < 1 ? '도착' : left < FP.turnReachM ? `${Math.round(left)} m 앞 도착` : '앞으로', sub: `도착까지 ${Math.round(left)} m`, floor: st.floor, turn: left < FP.turnReachM ? 'arrive' : null, distM: left };
  }

  function hud() {
    const h = hudAt();
    const turn = h.turn === 'left' || h.turn === 'right' ? turns.find((t) => t.s > st.s + 0.5) : null;
    // 화살표: 다음 꺾임 자리에, 꺾인 뒤 방향으로
    if (arrow) {
      arrow.visible = !!turn && st.phase === 'walk';
      if (turn) { const p = pts[turn.i]; arrow.position.set(p.x, p.y + 0.1, p.z); arrow.rotation.set(0, turn.heading, 0); }
    }
    const key = `${h.text}|${h.sub}|${h.floor}`;
    if (key !== st.hudKey) { st.hudKey = key; onHud?.(h); }
  }

  /** 매 프레임: dt(s). 1인칭이면 true(계속 그려야 함). */
  function tick(dt: number) {
    if (!st.on) return false;
    dt = Math.min(dt, 0.1);
    if (st.phase === 'walk') {
      // 따라가기: 목표가 앞이면 쫓아감(최대 속도 제한), 뒤·없음이면 그 자리. 미리 보기: 배속으로 걸음.
      const step = st.follow
        ? st.target == null || st.target <= st.s ? 0 : Math.min(FP.followMaxMps * dt, (st.target - st.s) * (1 - Math.exp(-dt / FP.followTauS)))
        : st.paused ? 0 : FP.speedMps * st.speed * dt;
      if (step > 0) {
        const next = trans.find((t) => t.s0 >= st.s - 0.01);
        st.s = Math.min(st.s + step, total());
        if (next && st.s >= next.s0) { st.s = next.s0; st.pending = next; st.phase = 'out'; st.fadeT = 0; }
        if (st.s >= total() && !st.follow) st.paused = true; // 끝: 멈춤(다시 보기는 seek(0))
      }
    } else {
      st.fadeT += dt;
      const k = Math.min(1, st.fadeT / FP.fadeS);
      if (st.phase === 'out') {
        fadeMat.opacity = k;
        if (k >= 1) { st.s = st.pending!.s1 + 0.01; st.phase = 'in'; st.fadeT = 0; place(0); }
      } else {
        fadeMat.opacity = 1 - k;
        if (k >= 1) { st.phase = 'walk'; st.pending = null; }
      }
      fade.visible = fadeMat.opacity > 0.001;
    }
    if (st.phase !== 'in') place(dt);
    else hud();
    return true;
  }

  /** 경로 위 s(m) 자리로 바로(고개도 바로). 층 바뀜 구간 안이면 그 구간 끝(다음 층)으로. */
  function seek(s: number) {
    if (!st.on) return;
    s = Math.max(0, Math.min(s, total()));
    const t = trans.find((x) => s > x.s0 + 1e-6 && s < x.s1);
    st.s = t ? t.s1 + 0.01 : s;
    st.phase = 'walk'; st.pending = null; fade.visible = false; fadeMat.opacity = 0;
    place(0);
  }
  const clampSpeed = (k: number) => Math.min(FP.maxSpeed, Math.max(0.25, Number.isFinite(k) ? k : 1));

  return {
    start, stop, tick, seek, fit,
    active: () => st.on,
    setPaused: (p: boolean) => { st.paused = p; if (!p && st.s >= total()) seek(0); },
    setSpeed: (k: number) => { st.speed = clampSpeed(k); },
    /** 따라가기 목표(경로 처음부터 m). null 이면 그 자리에 멈춤. 지금보다 뒤면 그 자리(뒤로 크게 간 것은 부르는 쪽이 seek). */
    setTarget: (m: number | null) => { st.target = m == null ? null : Math.max(0, Math.min(m, total())); },
    progress: (): FpProgress => ({ s: st.s, total: total(), playing: st.on && (st.follow ? st.target != null : !st.paused), done: st.on && st.s >= total() - 0.01, speed: st.speed, follow: st.follow, target: st.target }),
    /** 지금 카메라(장면 좌표): 시험용 */
    pose: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, yawDeg: st.yaw / DEG, fov: camera.fov }),
    hud: hudAt,
    info: () => ({ s: st.s, total: total(), level: st.level, levels: levels.length, transitions: trans.map((t) => ({ s0: Math.round(t.s0 * 10) / 10, s1: Math.round(t.s1 * 10) / 10, kind: t.kind, up: t.up, label: t.label })), turns: turns.map((t) => ({ s: Math.round(t.s * 10) / 10, dir: t.dir, deg: Math.round(t.deg) })), tunnels: tunnels.map((u) => ({ s0: Math.round(u.s0 * 10) / 10, s1: Math.round(u.s1 * 10) / 10 })), floor: st.floor, phase: st.phase, visible: { interiors: host.interiors.filter((i) => i.node.visible).length, buildingsHidden: host.buildings.filter((b) => !b.visible).length, tunnel: tunnels.some((u) => u.mesh.visible), outdoor: host.outdoor.some((o) => o.visible) } }),
  };
}
export type FirstPerson = ReturnType<typeof createFirstPerson>;
