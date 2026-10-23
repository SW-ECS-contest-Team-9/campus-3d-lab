// 1인칭 길 안내(시험): 경로 선 위 눈높이 1.6 m 로 걸어가며 앞을 봄. 층이 바뀌는 곳(계단·승강기)은 어둡게 했다가 다음 층에서 다시 밝힘.
// 실내에서는 지금 층의 실내 빈 곳(i| 노드: 바닥·벽·천장)만 보이고, 서 있는 건물 껍데기(지붕·위층)는 숨김.
// 바닥에 경로 띠(지금 층 구간만)와 다음 꺾임 화살표, 글 안내(onHud)를 냄. 장면 자료는 바꾸지 않음(보이기만 바꿈).
import * as THREE from 'three';

export const FP = {
  eyeM: 1.6,
  /** 걷는 속도(m/s). 시연은 speed 배수로 */
  speedMps: 1.4,
  /** 이만큼 앞의 경로 점을 봄(m) — 짧으면 꺾일 때 고개를 홱 돌리고, 길면 모퉁이를 미리 질러 봄 */
  lookAheadM: 6,
  /** 세로 시야각(도). 세로 화면에서 가로 시야는 이보다 훨씬 좁음(70° → 약 36°) */
  fovDeg: 70,
  /** 고개 돌림 부드럽게: 시간 상수(s)와 최대 속도(도/s) — 멀미 줄이기 */
  yawTauS: 0.35,
  maxYawDegPerS: 75,
  /** 내려다보는 각(도): 바닥 띠가 화면 아래쪽에 보이게 */
  pitchDeg: -12,
  fadeS: 0.35,
  ribbonW: 0.9,
  /** 이 각도 넘게 꺾이면 '꺾임'(도), 이 거리 안이면 화살표·안내 */
  turnDeg: 35,
  turnReachM: 40,
  /** 층 바뀜 판단: 기울기(높이/수평) 넘고 높이차 합이 이만큼 이상(m) */
  steep: 0.35,
  levelChangeM: 1.2,
  /** 지금 층 실내를 보일 거리(m) */
  interiorReachM: 150,
};

export interface FpInterior { node: THREE.Mesh; m: number; floor: string; rings: number[][][] }
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
  /** 바깥 길 점의 발 높이: 경로 높이가 구조물·길 면 윗면보다 조금 낮으면(인도 턱 등) 윗면으로(0.4 m 안만: 더 높으면 화단·벽 윗면이라 무시) */
  surfaceTops?: (pts: THREE.Vector3[]) => (number | null)[];
}
export interface FpStep { kind: string; floorChange: boolean; toFloor: string | null }
export interface Hud { text: string; sub: string; floor: string | null; turn: 'left' | 'right' | 'up' | 'down' | 'arrive' | null; distM: number | null }

interface Transition { i0: number; i1: number; s0: number; s1: number; kind: 'stairs' | 'elevator'; up: boolean; label: string }
interface Turn { s: number; i: number; dir: 'left' | 'right'; deg: number; heading: number }

const DEG = Math.PI / 180;
const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const inRing = (x: number, y: number, r: number[][]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
// 합친 바깥선: 바깥 고리 안이고 구멍 밖(짝홀 규칙으로 모든 고리를 세면 됨)
const inRings = (x: number, y: number, rings: number[][][]) => rings.reduce((c, r) => (inRing(x, y, r) ? !c : c), false);

export function createFirstPerson(host: FpHost, onHud?: (h: Hud) => void) {
  const { camera } = host;
  const group = new THREE.Group();
  group.visible = false;
  host.scene.add(group);
  // 어둡게 하기: 카메라에 붙은 검은 판
  const fade = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  fade.position.z = -0.2; fade.renderOrder = 1000; fade.visible = false;
  camera.add(fade);
  if (!camera.parent) host.scene.add(camera);
  const bbox = host.buildings.map((b) => new THREE.Box3().setFromObject(b));

  let pts: THREE.Vector3[] = [];
  let cum: number[] = [];
  let trans: Transition[] = [];
  let turns: Turn[] = [];
  let levels: { s0: number; s1: number; ribbon: THREE.Object3D }[] = [];
  let arrow: THREE.Mesh | null = null;
  const st = { on: false, s: 0, yaw: 0, speed: 1, paused: false, fadeT: 0, phase: 'walk' as 'walk' | 'out' | 'in', pending: null as Transition | null, level: 0, visKey: '', lastVis: 0, hudKey: '', floor: null as string | null };
  const saved = { near: 1, far: 5000, fov: 45 };

  const posAt = (s: number) => {
    s = Math.min(Math.max(s, 0), cum[cum.length - 1]);
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

  function ribbonMesh(from: number, to: number) {
    const g = new THREE.Group();
    const sel: THREE.Vector3[] = [];
    for (let i = from; i <= to; i++) if (!sel.length || sel[sel.length - 1].distanceTo(pts[i]) > 0.05) sel.push(pts[i]);
    if (sel.length < 2) return g;
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i < sel.length; i++) {
      const a = sel[Math.max(0, i - 1)], b = sel[Math.min(sel.length - 1, i + 1)];
      const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
      const side = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(FP.ribbonW / 2);
      const p = sel[i];
      pos.push(p.x + side.x, p.y + 0.07, p.z + side.z, p.x - side.x, p.y + 0.07, p.z - side.z);
      if (i) { const k = 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const band = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b6fe0, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    band.renderOrder = 1;
    g.add(band);
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

  function arrowMesh() {
    // 바닥에 눕힌 굽은 화살표 대신 단순한 큰 화살표(길이 1.8 m), 꺾인 뒤 방향을 가리킴
    const sh = new THREE.Shape();
    sh.moveTo(0, 1.0); sh.lineTo(0.7, 0.2); sh.lineTo(0.28, 0.2); sh.lineTo(0.28, -0.8); sh.lineTo(-0.28, -0.8); sh.lineTo(-0.28, 0.2); sh.lineTo(-0.7, 0.2); sh.closePath();
    const geo = new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
    const edge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x1d4ed8, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5 }));
    edge.scale.setScalar(1.18); edge.position.y = -0.005; edge.renderOrder = 3; m.renderOrder = 4;
    m.add(edge);
    return m;
  }

  function start(points: number[][], steps: FpStep[] = [], opts: { speed?: number } = {}) {
    stop();
    pts = [];
    const raw = points.map(([x, y, z]) => host.fromTm(x, y, z));
    const tops = host.surfaceTops?.(raw) ?? [];
    raw.forEach((v, k) => {
      const t = host.toTm(v);
      const indoor = host.interiors.some((i) => Math.abs(i.m - v.y) < 0.7 && inRings(t.x, t.y, i.rings));
      const top = tops[k];
      if (!indoor && top != null && top > v.y) v.y = top;
      if (!pts.length || pts[pts.length - 1].distanceTo(v) > 0.01) pts.push(v);
    });
    if (pts.length < 2) return false;
    cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    // 층 바뀜: 가파른 구간이 이어지고 높이차가 크면
    trans = [];
    const changes = steps.filter((s) => s.floorChange);
    for (let i = 0; i < pts.length - 1;) {
      const steepAt = (k: number) => { const a = pts[k], b = pts[k + 1]; const dz = b.y - a.y; return Math.abs(dz) > 0.05 && Math.abs(dz) > FP.steep * Math.hypot(b.x - a.x, b.z - a.z); };
      if (!steepAt(i)) { i++; continue; }
      let j = i; while (j < pts.length - 1 && steepAt(j)) j++;
      const dz = pts[j].y - pts[i].y, dxy = Math.hypot(pts[j].x - pts[i].x, pts[j].z - pts[i].z);
      if (Math.abs(dz) >= FP.levelChangeM) {
        const step = changes[trans.length];
        // 종류는 경로 단계(계단·승강기)를 먼저 믿고, 없으면 모양(수평으로 거의 안 움직이면 승강기)
        const kind = step?.kind === 'elevator' || step?.kind === 'stairs' ? step.kind : dxy < 1.5 ? 'elevator' : 'stairs';
        const to = step?.toFloor ?? (dz > 0 ? '위층' : '아래층');
        trans.push({ i0: i, i1: j, s0: cum[i], s1: cum[j], kind, up: dz > 0, label: `${kind === 'elevator' ? '승강기로' : '계단으로'} ${to.replace(/(\d+)F$/, '$1층')}` });
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
    // 꺾임: 앞뒤 3 m 방향 차이
    turns = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const s = cum[i], l = levels[levelOf(s)];
      if (s - l.s0 < 1 || l.s1 - s < 1) continue;
      const a = posAt(Math.max(l.s0, s - 3)), b = posAt(Math.min(l.s1, s + 3)), p = pts[i];
      if (Math.hypot(p.x - a.x, p.z - a.z) < 0.5 || Math.hypot(b.x - p.x, b.z - p.z) < 0.5) continue;
      const d = wrap(yawTo(p, b) - yawTo(a, p));
      if (Math.abs(d) < FP.turnDeg * DEG) continue;
      const prev = turns[turns.length - 1];
      if (prev && s - prev.s < 4) { if (Math.abs(d) > prev.deg * DEG) turns[turns.length - 1] = { s, i, dir: d > 0 ? 'left' : 'right', deg: Math.abs(d) / DEG, heading: yawTo(p, b) }; continue; }
      turns.push({ s, i, dir: d > 0 ? 'left' : 'right', deg: Math.abs(d) / DEG, heading: yawTo(p, b) });
    }
    arrow = arrowMesh(); arrow.visible = false; group.add(arrow);
    saved.near = camera.near; saved.far = camera.far; saved.fov = camera.fov;
    camera.near = 0.1; camera.far = 2000; camera.fov = FP.fovDeg; camera.updateProjectionMatrix();
    for (const o of host.hide) o.visible = false;
    group.visible = true;
    Object.assign(st, { on: true, s: 0, speed: opts.speed ?? 1, paused: false, fadeT: 0, phase: 'walk', pending: null, level: 0, visKey: '', lastVis: -1, hudKey: '' });
    st.yaw = headingAt(0, FP.lookAheadM);
    place(0);
    return true;
  }

  function stop() {
    if (!st.on) return;
    st.on = false;
    for (const c of [...group.children]) { group.remove(c); c.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
    group.visible = false; fade.visible = false;
    for (const o of host.hide) o.visible = true;
    for (const b of host.buildings) b.visible = true;
    for (const o of host.outdoor) o.visible = true;
    for (const i of host.interiors) i.node.visible = false;
    camera.near = saved.near; camera.far = saved.far; camera.fov = saved.fov; camera.updateProjectionMatrix();
  }

  /** 보이기: 실내(발이 그 층 빈 곳 안)면 그 높이의 실내만, 서 있는 건물 껍데기는 숨김 */
  function visibility(feet: THREE.Vector3, force = false) {
    const t = host.toTm(feet);
    const here = host.interiors.find((i) => Math.abs(i.m - feet.y) < 0.7 && inRings(t.x, t.y, i.rings));
    const key = here ? `${here.node.name}` : `out`;
    st.floor = here ? `${here.node.name.split('|')[1]} ${here.floor}` : null;
    if (key === st.visKey && !force) return;
    st.visKey = key;
    for (const i of host.interiors) i.node.visible = !!here && Math.abs(i.m - here.m) < 0.7 && near(i, feet);
    for (const o of host.outdoor) o.visible = !here;
    host.buildings.forEach((b, k) => { const bb = bbox[k]; b.visible = !(here && feet.x > bb.min.x - 1 && feet.x < bb.max.x + 1 && feet.z > bb.min.z - 1 && feet.z < bb.max.z + 1); });
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
    hud(feet);
  }

  function hud(feet: THREE.Vector3) {
    const total = cum[cum.length - 1];
    const tNext = trans.find((t) => t.s0 >= st.s - 0.01);
    const turn = turns.find((t) => t.s > st.s + 0.5 && (!tNext || t.s < tNext.s0));
    let h: Hud;
    const left = total - st.s;
    if (st.phase !== 'walk' && st.pending) h = { text: st.pending.label, sub: st.pending.kind === 'elevator' ? '승강기 타는 중' : '계단 오르내리는 중', floor: st.floor, turn: st.pending.up ? 'up' : 'down', distM: 0 };
    else if (turn && turn.s - st.s < FP.turnReachM) h = { text: `${Math.round(turn.s - st.s)} m 앞 ${turn.dir === 'left' ? '왼쪽' : '오른쪽'}`, sub: `도착까지 ${Math.round(left)} m`, floor: st.floor, turn: turn.dir, distM: turn.s - st.s };
    else if (tNext && tNext.s0 - st.s < FP.turnReachM) h = { text: `${Math.round(tNext.s0 - st.s)} m 앞 ${tNext.label}`, sub: `도착까지 ${Math.round(left)} m`, floor: st.floor, turn: tNext.up ? 'up' : 'down', distM: tNext.s0 - st.s };
    else h = { text: left < 1 ? '도착' : left < FP.turnReachM ? `${Math.round(left)} m 앞 도착` : '앞으로', sub: `도착까지 ${Math.round(left)} m`, floor: st.floor, turn: left < FP.turnReachM ? 'arrive' : null, distM: left };
    // 화살표: 다음 꺾임 자리에, 꺾인 뒤 방향으로
    if (arrow) {
      arrow.visible = !!turn && turn.s - st.s < FP.turnReachM && st.phase === 'walk';
      if (turn) { const p = pts[turn.i]; arrow.position.set(p.x, p.y + 0.1, p.z); arrow.rotation.set(0, turn.heading, 0); }
    }
    void feet;
    const key = `${h.text}|${h.sub}|${h.floor}`;
    if (key !== st.hudKey) { st.hudKey = key; onHud?.(h); }
  }

  /** 매 프레임: dt(s). 1인칭이면 true(계속 그려야 함). */
  function tick(dt: number) {
    if (!st.on) return false;
    dt = Math.min(dt, 0.1);
    if (st.phase === 'walk') {
      if (!st.paused) {
        const next = trans.find((t) => t.s0 >= st.s - 0.01);
        st.s = Math.min(st.s + FP.speedMps * st.speed * dt, cum[cum.length - 1]);
        if (next && st.s >= next.s0) { st.s = next.s0; st.pending = next; st.phase = 'out'; st.fadeT = 0; }
      }
    } else {
      st.fadeT += dt;
      const k = Math.min(1, st.fadeT / FP.fadeS);
      if (st.phase === 'out') {
        fade.material.opacity = k;
        if (k >= 1) { st.s = st.pending!.s1 + 0.01; st.phase = 'in'; st.fadeT = 0; place(0); }
      } else {
        fade.material.opacity = 1 - k;
        if (k >= 1) { st.phase = 'walk'; st.pending = null; }
      }
      fade.visible = fade.material.opacity > 0.001;
    }
    if (st.phase !== 'in') place(dt);
    else hud(posAt(st.s));
    return true;
  }

  /** 시험·갈무리용: 경로 위 s(m) 자리로 바로(고개도 바로) */
  function seek(s: number) { if (!st.on) return; st.s = Math.max(0, Math.min(s, cum[cum.length - 1])); st.phase = 'walk'; st.pending = null; fade.visible = false; fade.material.opacity = 0; place(0); }

  return {
    start, stop, tick, seek,
    active: () => st.on,
    setPaused: (p: boolean) => { st.paused = p; },
    setSpeed: (k: number) => { st.speed = k; },
    info: () => ({ s: st.s, total: cum[cum.length - 1] ?? 0, level: st.level, levels: levels.length, transitions: trans.map((t) => ({ s0: Math.round(t.s0 * 10) / 10, s1: Math.round(t.s1 * 10) / 10, kind: t.kind, label: t.label })), turns: turns.map((t) => ({ s: Math.round(t.s * 10) / 10, dir: t.dir, deg: Math.round(t.deg) })), floor: st.floor, phase: st.phase, visible: { interiors: host.interiors.filter((i) => i.node.visible).length, buildingsHidden: host.buildings.filter((b) => !b.visible).length } }),
  };
}
export type FirstPerson = ReturnType<typeof createFirstPerson>;
