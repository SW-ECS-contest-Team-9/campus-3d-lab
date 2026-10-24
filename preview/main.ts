// PC 미리보기: 앱과 같은 campusScene 을 브라우저 canvas 로. 시험 손잡이 window.__s (명령·끌기·시간 재기).
import * as THREE from 'three';
import { createCampusScene } from '../native/src/campusScene';
const canvas = document.getElementById('c') as HTMLCanvasElement;
const w = innerWidth, h = innerHeight;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
const events: any[] = [];
(window as any).__events = events;
const t0 = performance.now();
const glb = await (await fetch('/native/assets/campus.glb')).arrayBuffer();
const tLoad = performance.now();
const hud = document.getElementById('hud')!;
const s = await createCampusScene({ renderer, width: w, height: h, glb, onHud: (x) => { hud.style.display = 'block'; hud.innerHTML = `<b>${x.text}</b><br><small>${x.sub}${x.floor ? ' · ' + x.floor : ''}</small>`; (window as any).__hud = x; }, emit: (e) => { events.push(e); if (e.type === 'ready') console.log('READY ' + Math.round(performance.now() - t0)); } });
(window as any).__s = s;
(window as any).__timing = { fetchMs: Math.round(tLoad - t0), sceneMs: Math.round(performance.now() - tLoad) };
const m = document.getElementById('m')!;
// 프레임 간격 기록(1인칭 시간 재기): window.__frames
const frames: number[] = [];
(window as any).__frames = frames;
(function loop() {
  if (s.frameTick()) frames.push(performance.now());
  if (!s.firstPerson.active()) hud.style.display = 'none';
  const p = s.markerScreen();
  m.style.display = p ? 'block' : 'none';
  if (p) { m.style.left = p.x + 'px'; m.style.top = p.y + 'px'; m.style.background = p.state === 'ok' ? '#0f766e' : '#b45309'; }
  requestAnimationFrame(loop);
})();
