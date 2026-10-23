// 1인칭 안내 갈무리·시간 재기(PC headless Chrome, 화면에 안 띄움).
// 사용: node tools/fp-shots.mjs <경로 fixture> <출력 폴더> [간격 m=2] [gpu=1]
//   - 경로를 1인칭으로 시작해 간격마다 seek → 갈무리(출력/NNN.png, 360x800 dpr 2)
//   - 끝나고 실제 시간으로 1배속 12 s 걸으며 프레임 간격(p50·p95) → 출력/frames.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [fixture, outDir, every = '2', gpu = '1'] = process.argv.slice(2);
const url = 'http://127.0.0.1:5292/out/preview/index.html';
const port = 9464;
fs.mkdirSync(outDir, { recursive: true });
const gl = gpu === '1' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/c3dfp`, ...gl, 'about:blank']);
let tabs = null;
for (let i = 0; i < 40 && !tabs; i++) { await new Promise((r) => setTimeout(r, 500)); tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; let ready = null; const wait = new Map(); const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled') { const t = d.params.args.map((a) => a.value ?? a.description).join(' '); logs.push(t); if (String(t).startsWith('READY')) ready = t; }
  if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
};
const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await call('Runtime.enable'); await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
const t0 = Date.now();
await call('Page.navigate', { url });
while (!ready && Date.now() - t0 < 180000) await sleep(200);
console.log(ready ?? 'no READY', logs.filter((l) => /EXC|rror/.test(l)).slice(0, 5).join('\n'));
const glInfo = await ev(`(() => { const c = document.createElement('canvas').getContext('webgl2'); const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER); })()`);
console.log('gl', glInfo);
const route = JSON.parse(fs.readFileSync(fixture, 'utf8'));
await ev(`__s.firstPerson.start(${JSON.stringify({ points: route.points, steps: route.steps })}, { speed: 1 }), __s.firstPerson.setPaused(true), true`);
const info = await ev('__s.firstPerson.info()');
console.log(JSON.stringify(info));
const shots = [];
for (let s = 0, k = 0; s <= info.total + 0.01; s += +every, k++) {
  // 층 바뀜 구간 안(가려진 자리)은 건너뜀
  if (info.transitions.some((t) => s > t.s0 + 0.05 && s < t.s1 - 0.05)) continue;
  await ev(`__s.firstPerson.seek(${s}), true`);
  await sleep(120);
  const st = await ev('({ hud: window.__hud, i: __s.firstPerson.info() })');
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const f = `${outDir}/${String(shots.length).padStart(3, '0')}.png`;
  fs.writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
  shots.push({ f, s: Math.round(s * 10) / 10, hud: st.hud?.text, floor: st.i.floor, vis: st.i.visible });
}
fs.writeFileSync(`${outDir}/shots.json`, JSON.stringify(shots, null, 1));
// 실제 시간으로 걷기: 처음부터, 3배속(층 바뀜 어둡게 하기 포함), 12 s
await ev(`__s.firstPerson.seek(0), __s.firstPerson.setSpeed(3), __s.firstPerson.setPaused(false), window.__frames.length = 0, true`);
await sleep(12000);
const fr = await ev(`(() => { const f = window.__frames; const d = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b); const q = (x) => d[Math.min(d.length - 1, Math.floor(d.length * x))]; return { n: d.length, p50: q(0.5), p95: q(0.95), max: d[d.length - 1], fps: d.length / ((f[f.length - 1] - f[0]) / 1000), info: __s.firstPerson.info(), render: __s.info() }; })()`);
fr.gl = glInfo;
fs.writeFileSync(`${outDir}/frames.json`, JSON.stringify(fr, null, 1));
console.log('frames', JSON.stringify({ n: fr.n, p50: fr.p50, p95: fr.p95, max: fr.max, fps: fr.fps, render: fr.render }));
chrome.kill();
process.exit(0);
