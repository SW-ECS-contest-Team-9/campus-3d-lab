// headless Chrome(PC) 에서 client3d(제품 빌드)를 띄우고 웹 모델링 기하를 가로채 out/capture.{json,bin}, 바닥 그림 out/ground.png 로 저장.
// 사용: node export/capture.mjs [url=http://127.0.0.1:5291/client3d.html]
// 원본 자료는 읽기만 함(시험 서버 3210 의 공개 읽기 API 를 tools/serve.mjs 가 대신 받아 줌).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5291/client3d.html';
const hook = fs.readFileSync(new URL('./capture-hook.js', import.meta.url), 'utf8');
const port = 9462;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/c3dcap`,
  '--window-size=412,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
]);
let tabs = null;
for (let i = 0; i < 40 && !tabs; i++) {
  await new Promise((r) => setTimeout(r, 500));
  tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
let ready = false;
const wait = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.args[0]?.value === 'C3D_READY') ready = true;
};
const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result.result.value;
};
await call('Runtime.enable');
await call('Page.enable');
await call('Page.addScriptToEvaluateOnNewDocument', {
  source: `${hook}\nwindow.ReactNativeWebView={postMessage(s){if(s.includes('"type":"ready"'))console.log('C3D_READY')}};`,
});
const t0 = Date.now();
await call('Page.navigate', { url });
while (!ready && Date.now() - t0 < 300000) await new Promise((r) => setTimeout(r, 500));
console.log('ready', ready, Date.now() - t0, 'ms');
const gridMeta = JSON.parse(await ev(`fetch('/api/v1/terrain/grid').then(r=>r.headers.get('X-Grid'))`));
const b = gridMeta.bounds;
const meta = JSON.parse(await ev(`__captureDump(${(b.west + b.east) / 2},${(b.south + b.north) / 2},0)`));
meta.grid = gridMeta;
fs.mkdirSync('out', { recursive: true });
const bin = Buffer.alloc(meta.bytes);
const step = 4 << 20;
for (let o = 0; o < meta.bytes; o += step) Buffer.from(await ev(`__captureChunk(${o},${step})`), 'base64').copy(bin, o);
fs.writeFileSync('out/capture.bin', bin);
fs.writeFileSync('out/capture.json', JSON.stringify(meta));
const g = await ev('window.__capture.ground && window.__capture.ground.url');
if (g?.startsWith('data:image/png;base64,')) fs.writeFileSync('out/ground.png', Buffer.from(g.slice(22), 'base64'));
console.log('groups', meta.groups.length, 'bytes', meta.bytes, 'ground', !!g);
chrome.kill();
process.exit(0);
