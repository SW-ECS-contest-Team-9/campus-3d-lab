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
const s = await createCampusScene({ renderer, width: w, height: h, glb, emit: (e) => { events.push(e); if (e.type === 'ready') console.log('READY ' + Math.round(performance.now() - t0)); } });
(window as any).__s = s;
(window as any).__timing = { fetchMs: Math.round(tLoad - t0), sceneMs: Math.round(performance.now() - tLoad) };
const m = document.getElementById('m')!;
(function loop() {
  s.frameTick();
  const p = s.markerScreen();
  m.style.display = p ? 'block' : 'none';
  if (p) { m.style.left = p.x + 'px'; m.style.top = p.y + 'px'; m.style.background = p.state === 'ok' ? '#0f766e' : '#b45309'; }
  requestAnimationFrame(loop);
})();
