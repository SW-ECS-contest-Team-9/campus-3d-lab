// 캠퍼스 3D 장면(three.js) — 플랫폼 공용: 앱(expo-gl)과 PC 미리보기(브라우저 canvas)가 같은 코드를 씀.
// 자료: export/build-glb.mjs 가 만든 campus.glb(웹 모델링을 그대로 구운 것). 명령·사건은 client3d 메시지 형식 v1 과 같음.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeFrame, tmForward } from './geo';
import { matchFloor, parseCommand, PROTOCOL_VERSION, type Command, type PageEvent } from './protocol';

type Unversioned<T> = T extends unknown ? Omit<T, 'v'> : never;
export type Emit = (e: PageEvent) => void;

const COLOR = { route: 0x2563eb, routeEdge: 0xffffff, ok: 0x0f766e, uncertain: 0xb45309, change: 0xdb2777, floorNow: 0x4f46e5, floor: 0xeef1f6, background: 0xdfe6e9 };
const CAMERA = { pitchDeg: -50, headingDeg: -20, minDist: 25, maxDist: 1400, fov: 45 };
const EXPLODE_GAP = 5; // 펼친 층 사이 더 띄우는 높이(m)

interface Floor { m: number; name: string | null; node: THREE.Mesh }
interface Building { id: string; name: string; node: THREE.Mesh; floors: Floor[] }

export interface SceneOptions {
  renderer: THREE.WebGLRenderer;
  width: number;
  height: number;
  glb: ArrayBuffer;
  emit: Emit;
  light?: boolean;
  now?: () => number;
}

export async function createCampusScene(o: SceneOptions) {
  const now = o.now ?? (() => Date.now());
  const emit = (e: Unversioned<PageEvent>) => o.emit({ v: PROTOCOL_VERSION, ...e } as PageEvent);
  const renderer = o.renderer;
  let needs = true;
  function dirty() { needs = true; }
  renderer.setClearColor(COLOR.background, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f80, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-0.55, 0.75, 0.65); // 남서쪽 위에서(웹과 같은 방향의 고정 빛)
  scene.add(sun);

  const gltf: any = await new Promise((res, rej) => new GLTFLoader().parse(o.glb, '', res, rej));
  const root: THREE.Object3D = gltf.scene;
  scene.add(root);
  const extras = gltf.parser.json.extras ?? {};
  const [lon0, lat0] = extras.origin as number[];
  const frame = makeFrame(lon0, lat0);
  // 화면 좌표 → EPSG:5186 (원점 둘레 1 km 안이므로 국소 근사로 충분, 오차 수 cm)
  const R = 6378137, DEG = Math.PI / 180;
  const toTm = (p: THREE.Vector3) => { const lat = lat0 + (-p.z / R) / DEG; const lon = lon0 + (p.x / (R * Math.cos(lat0 * DEG))) / DEG; const t = tmForward(lat, lon); return { x: t.x, y: t.y, z: p.y }; };
  const fromTm = (x: number, y: number, z: number) => new THREE.Vector3(...frame.fromTm(x, y, z));

  // 노드 extras 는 Object3D.userData 에 들어옴(메시가 노드 자체이거나 자식)
  const nodes: THREE.Object3D[] = [];
  root.traverse((n) => { if (n.userData && (n.userData.id || n.userData.building || n.name === 'ground' || n.name === 'structures' || n.name === 'surfaces' || n.name === 'lines')) nodes.push(n); });
  const meshOf = (n: THREE.Object3D) => (n as any).isMesh ? (n as THREE.Mesh) : (n.children.find((c: any) => c.isMesh) as THREE.Mesh);
  const buildings = new Map<string, Building>();
  const layer: Record<string, THREE.Object3D | undefined> = {};
  for (const n of nodes) {
    if (n.userData.id) buildings.set(n.userData.id, { id: n.userData.id, name: n.userData.name, node: meshOf(n), floors: [] });
    else if (!n.userData.building) layer[n.name] = n;
  }
  for (const n of nodes) {
    if (!n.userData.building) continue;
    const b = buildings.get(n.userData.building);
    if (!b) continue;
    n.visible = false;
    b.floors.push({ m: n.userData.m, name: n.userData.name, node: meshOf(n) });
  }
  for (const b of buildings.values()) b.floors.sort((a, c) => a.m - c.m);
  // 블록(예: '한림관#고리')은 기본 건물('한림관')에 딸림 — 펼치기·비침·고르기를 함께
  const baseId = (id: string) => id.split('#')[0];
  const blocksOf = (id: string) => [...buildings.values()].filter((b) => baseId(b.id) === id);
  // 건물 재질은 하나를 나눠 씀 → 비침(한 층 보기)을 위해 건물마다 복제
  for (const b of buildings.values()) { const m = (b.node.material as THREE.MeshStandardMaterial).clone(); m.transparent = false; b.node.material = m; }
  for (const b of buildings.values()) for (const f of b.floors) f.node.material = new THREE.MeshLambertMaterial({ color: COLOR.floor, vertexColors: false, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
  // 선은 폰 화면에서 1 px — 가벼운 모드에선 끔
  let light = !!o.light;
  const applyLight = () => { if (layer.lines) layer.lines.visible = !light; };
  applyLight();

  // ---------- 카메라: 비스듬히 위에서, 끌기 = 이동, 두 손가락 = 확대·회전·기울이기 ----------
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, o.width / o.height, 1, 5000);
  const box = new THREE.Box3();
  for (const b of buildings.values()) box.expandByObject(b.node);
  const center = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3());
  const bounds = { minX: box.min.x - 150, maxX: box.max.x + 150, minZ: box.min.z - 150, maxZ: box.max.z + 150 };
  const cam = { target: center.clone(), dist: 0, heading: CAMERA.headingDeg * DEG, pitch: CAMERA.pitchDeg * DEG };
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const homeDist = () => radius * (o.height > o.width ? 2.5 : 1.9); // client3d 와 같은 비율
  const home = () => { cam.target.copy(center); cam.dist = homeDist(); cam.heading = CAMERA.headingDeg * DEG; cam.pitch = CAMERA.pitchDeg * DEG; dirty(); };
  const applyCamera = () => {
    cam.dist = Math.min(Math.max(cam.dist, CAMERA.minDist), CAMERA.maxDist);
    cam.pitch = Math.min(Math.max(cam.pitch, -89 * DEG), -15 * DEG);
    cam.target.x = Math.min(Math.max(cam.target.x, bounds.minX), bounds.maxX);
    cam.target.z = Math.min(Math.max(cam.target.z, bounds.minZ), bounds.maxZ);
    const h = Math.cos(-cam.pitch) * cam.dist, v = Math.sin(-cam.pitch) * cam.dist;
    // heading 0 = 북쪽을 봄(카메라는 남쪽에), 시계 방향 +
    camera.position.set(cam.target.x - Math.sin(cam.heading) * h, cam.target.y + v, cam.target.z + Math.cos(cam.heading) * h);
    camera.lookAt(cam.target);
  };
  home();

  // ---------- 다시 그리기: 바뀐 것이 있을 때만(배터리) ----------
  let lastCam = '';
  let lastSent = 0;
  const sendCamera = () => {
    const p = toTm(camera.position);
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${cam.dist.toFixed(1)},${cam.heading.toFixed(3)},${cam.pitch.toFixed(3)}`;
    if (key === lastCam || now() - lastSent < 300) return;
    lastCam = key; lastSent = now();
    emit({ type: 'cameraChanged', x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, heightM: Math.round(p.z * 10) / 10, headingDeg: Math.round(cam.heading / DEG), pitchDeg: Math.round(cam.pitch / DEG) });
  };

  // ---------- 땅 높이(위치 표지를 바닥에 놓을 때) ----------
  const ray = new THREE.Raycaster();
  const groundTargets = [layer.structures, layer.surfaces, layer.ground].filter(Boolean) as THREE.Object3D[];
  const groundAt = (x: number, z: number) => { ray.set(new THREE.Vector3(x, 2000, z), new THREE.Vector3(0, -1, 0)); const hit = ray.intersectObjects(groundTargets, true)[0]; return hit ? hit.point.y : center.y; };

  // ---------- 경로 ----------
  const routeGroup = new THREE.Group();
  scene.add(routeGroup);
  function ribbon(pts: THREE.Vector3[], width: number) {
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
      const side = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(width / 2);
      const p = pts[i];
      pos.push(p.x + side.x, p.y, p.z + side.z, p.x - side.x, p.y, p.z - side.z);
      if (i) { const k = 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }
  function setRoute(points: number[][], changes: { at: number[]; label: string | null }[]) {
    clearRoute();
    const pts = points.map(([x, y, z]) => { const v = fromTm(x, y, Number.isFinite(z) ? z : 0); if (!Number.isFinite(z)) v.y = groundAt(v.x, v.z); v.y += 0.4; return v; });
    const edge = new THREE.Mesh(ribbon(pts, 3.2), new THREE.MeshBasicMaterial({ color: COLOR.routeEdge, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    const line = new THREE.Mesh(ribbon(pts.map((p) => p.clone().setY(p.y + 0.05)), 2.2), new THREE.MeshBasicMaterial({ color: COLOR.route, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }));
    // 건물 속 구간도 보이게: 깊이 검사 없이 60 % 로 한 번 더(웹의 depthFail 과 같은 뜻)
    const ghost = new THREE.Mesh(line.geometry, new THREE.MeshBasicMaterial({ color: COLOR.route, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }));
    ghost.renderOrder = 10;
    routeGroup.add(edge, line, ghost);
    const dot = new THREE.SphereGeometry(1.6, 12, 8);
    for (const c of changes) { const v = fromTm(c.at[0], c.at[1], Number.isFinite(c.at[2]) ? c.at[2] : 0); const s = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: COLOR.change, depthTest: false })); s.position.copy(v).setY(v.y + 1); s.renderOrder = 11; routeGroup.add(s); }
    const ends = [pts[0], pts[pts.length - 1]];
    ends.forEach((p, i) => { const s = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: i ? COLOR.change : COLOR.ok, depthTest: false })); s.position.copy(p).setY(p.y + 1); s.scale.setScalar(1.3); s.renderOrder = 11; routeGroup.add(s); });
    // 경로 전체가 보이게
    const bb = new THREE.Box3().setFromPoints(pts);
    bb.getCenter(cam.target); cam.dist = Math.max(80, bb.getSize(new THREE.Vector3()).length() * 1.3);
    follow.paused = true;
    dirty();
  }
  function clearRoute() { for (const c of [...routeGroup.children]) { routeGroup.remove(c); (c as THREE.Mesh).geometry?.dispose?.(); } dirty(); }

  // ---------- 층: 펼치기 / 한 층만 ----------
  let floorState: { building: string; index: number | null; explode: boolean } | null = null;
  function floorOffset(b: Building, i: number) { return floorState?.explode && floorState.building === b.id ? i * EXPLODE_GAP : 0; }
  function setFloorView(id: string | null, ref: string | null, explode: boolean, z: number | null = null) {
    for (const b of buildings.values()) {
      b.node.visible = true;
      const m = b.node.material as THREE.MeshStandardMaterial;
      m.transparent = false; m.opacity = 1; m.depthWrite = true;
      for (const f of b.floors) { f.node.visible = false; f.node.position.y = 0; }
    }
    const b = id ? buildings.get(id) ?? blocksOf(id).find((x) => x.floors.length) ?? null : null;
    if (!b) { floorState = null; emit({ type: 'floorChanged', building: null, floor: null, explode: false }); dirty(); return; }
    const index = ref || z !== null ? matchFloor(b.floors, ref, z) : -1;
    floorState = { building: b.id, index: index >= 0 ? index : null, explode };
    if (explode) {
      for (const blk of blocksOf(baseId(b.id))) blk.node.visible = false;
      b.floors.forEach((f, i) => { f.node.visible = true; f.node.position.y = i * EXPLODE_GAP; const mat = f.node.material as THREE.MeshLambertMaterial; mat.color.setHex(i === index ? COLOR.floorNow : COLOR.floor); mat.opacity = index < 0 || i === index ? 0.95 : 0.55; });
    } else if (index >= 0) {
      // 그 자리에서 그 층 판만, 모든 건물을 비침
      for (const o2 of buildings.values()) { const m = o2.node.material as THREE.MeshStandardMaterial; m.transparent = true; m.opacity = 0.25; m.depthWrite = false; }
      const f = b.floors[index]; f.node.visible = true; (f.node.material as THREE.MeshLambertMaterial).color.setHex(COLOR.floorNow); (f.node.material as THREE.MeshLambertMaterial).opacity = 0.95;
    }
    emit({ type: 'floorChanged', building: baseId(b.id), floor: index >= 0 ? b.floors[index].name : null, explode });
    placeMarker();
    dirty();
  }

  // ---------- 현재 위치: 3D 자리(정확도 원) + 화면 위 캐릭터(앱이 RN 그림으로 얹음) ----------
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLOR.ok, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide }));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLOR.ok, transparent: true, opacity: 0.15, depthTest: false, side: THREE.DoubleSide }));
  ring.renderOrder = disc.renderOrder = 12;
  const here = new THREE.Group(); here.add(disc, ring); here.visible = false; scene.add(here);
  let loc: (Extract<Command, { type: 'setLocation' }> & { p: THREE.Vector3 }) | null = null;
  const follow = { paused: false, candidate: null as string | null, count: 0, since: 0 };
  function placeMarker() {
    if (!loc) return;
    const p = loc.p.clone();
    const b = loc.building ? buildings.get(loc.building) : null;
    if (b && floorState?.building === b.id && floorState.index !== null && loc.state === 'ok') p.y = b.floors[floorState.index].m + floorOffset(b, floorState.index) + 0.1;
    here.position.copy(p);
  }
  function setLocation(c: Extract<Command, { type: 'setLocation' }>) {
    const v = new THREE.Vector3(...frame.fromLonLat(c.lon, c.lat, c.z ?? 0));
    if (c.z === null || c.state === 'uncertain') v.y = groundAt(v.x, v.z) + 0.2;
    loc = { ...c, p: v };
    here.visible = true;
    here.scale.setScalar(Math.max(2, c.accuracyM));
    const col = c.state === 'ok' ? COLOR.ok : COLOR.uncertain;
    (ring.material as THREE.MeshBasicMaterial).color.setHex(col); (disc.material as THREE.MeshBasicMaterial).color.setHex(col);
    // 실내 따라가기: 건물 안·확실이면 그 건물을 펼치고 지금 층. 다른 건물로는 같은 후보 2번(또는 3 s) 뒤에.
    if (c.state === 'ok' && !follow.paused) {
      const target = c.building && buildings.has(c.building) ? c.building : null;
      if (target !== (floorState?.building ?? null)) {
        if (follow.candidate !== target) { follow.candidate = target; follow.count = 1; follow.since = now(); }
        else follow.count++;
        if (follow.count >= 2 || now() - follow.since > 3000) { setFloorView(target, c.floor, true, c.z); follow.candidate = null; }
      } else if (target) setFloorView(target, c.floor, true, c.z);
      if (target) { cam.target.copy(v); dirty(); }
    }
    placeMarker();
    dirty();
  }
  /** 캐릭터 그림을 놓을 화면 자리(px). 안 보이면 null. */
  function markerScreen() {
    if (!loc || !here.visible) return null;
    const p = here.position.clone().project(camera);
    if (p.z > 1) return null;
    return { x: ((p.x + 1) / 2) * o.width, y: ((1 - p.y) / 2) * o.height, state: loc.state, floor: loc.floor };
  }

  // ---------- 누르기 ----------
  function tap(x: number, y: number) {
    ray.setFromCamera(new THREE.Vector2((x / o.width) * 2 - 1, -(y / o.height) * 2 + 1), camera);
    const targets: THREE.Object3D[] = [];
    for (const b of buildings.values()) { if (b.node.visible) targets.push(b.node); for (const f of b.floors) if (f.node.visible) targets.push(f.node); }
    const hit = ray.intersectObjects(targets, false)[0];
    if (hit) {
      const b = [...buildings.values()].find((q) => q.node === hit.object || q.floors.some((f) => f.node === hit.object))!;
      const t = toTm(hit.point);
      const main = buildings.get(baseId(b.id)) ?? b;
      emit({ type: 'pick', kind: 'building', id: main.id, name: main.name, x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100, z: Math.round(t.z * 100) / 100 });
      return;
    }
    const g = ray.intersectObjects(groundTargets, true)[0];
    if (g) { const t = toTm(g.point); emit({ type: 'pick', kind: 'point', x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100, z: Math.round(t.z * 100) / 100 }); }
  }

  // ---------- 명령(메시지 v1) ----------
  function command(raw: unknown) {
    const parsed = parseCommand(raw);
    if (!parsed.ok) { emit({ type: 'error', error: parsed.error, command: parsed.command }); return; }
    const c = parsed.command;
    switch (c.type) {
      case 'setLocation': setLocation(c); break;
      case 'clearLocation': loc = null; here.visible = false; dirty(); break;
      case 'setRoute': setRoute(c.points, c.floorChanges); break;
      case 'clearRoute': clearRoute(); break;
      case 'focus': { const v = fromTm(c.x, c.y, c.z ?? 0); if (c.z === null) v.y = groundAt(v.x, v.z); cam.target.copy(v); cam.dist = 140; follow.paused = true; if (c.building) setFloorView(c.building, c.floor, true); dirty(); break; }
      case 'setFloor': {
        setFloorView(c.building, c.floor, c.explode);
        // 펼칠 때는 그 건물로 시점을 옮김(펼친 층 전체가 보이게)
        const bs = blocksOf(baseId(c.building));
        if (bs.length && c.explode) { const bb = new THREE.Box3(); for (const x of bs) { bb.expandByObject(x.node); for (const f of x.floors) bb.expandByObject(f.node); } bb.getCenter(cam.target); cam.dist = Math.max(120, bb.getSize(new THREE.Vector3()).length() * 1.6 + bs.reduce((n, x) => Math.max(n, x.floors.length), 0) * EXPLODE_GAP); follow.paused = true; dirty(); }
        break;
      }
      case 'setMarkerImages': break; // 그림은 앱(RN)이 화면 위에 직접 그림
      case 'setMode': if (c.light !== null && c.light !== light) { light = c.light; applyLight(); dirty(); } break;
    }
  }

  // ---------- 손 조작(앱·미리보기가 부름) ----------
  function pan(dx: number, dy: number) {
    // 화면 1 px 이 목표 지점 깊이에서 몇 m 인지
    const mPerPx = (2 * cam.dist * Math.tan((CAMERA.fov * DEG) / 2)) / o.height;
    const fwd = new THREE.Vector3(Math.sin(cam.heading), 0, -Math.cos(cam.heading));
    const right = new THREE.Vector3(Math.cos(cam.heading), 0, Math.sin(cam.heading));
    cam.target.addScaledVector(right, -dx * mPerPx).addScaledVector(fwd, dy * mPerPx / Math.max(0.35, Math.sin(-cam.pitch)));
    follow.paused = true; dirty();
  }
  const zoom = (scale: number) => { cam.dist /= scale; dirty(); };
  const rotate = (rad: number) => { cam.heading += rad; dirty(); };
  const tilt = (dy: number) => { cam.pitch += dy * 0.004; dirty(); };

  function resize(w: number, h: number) { o.width = w; o.height = h; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); dirty(); }
  /** 그릴 것이 있으면 그리고 true. 앱의 rAF 고리가 매 프레임 부름. */
  function frameTick() {
    if (!needs) return false;
    needs = false;
    applyCamera();
    placeMarker();
    renderer.render(scene, camera);
    sendCamera();
    return true;
  }
  resize(o.width, o.height);
  const info = () => ({ ...renderer.info.render, geometries: renderer.info.memory.geometries });
  emit({ type: 'ready', buildings: [...buildings.values()].filter((b) => baseId(b.id) === b.id).map((b) => ({ id: b.id, name: b.name })), light });
  return { command, frameTick, resize, pan, zoom, rotate, tilt, tap, home, markerScreen, info, resumeFollow: () => { follow.paused = false; } };
}

export type CampusScene = Awaited<ReturnType<typeof createCampusScene>>;
