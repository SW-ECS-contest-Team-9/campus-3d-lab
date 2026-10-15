// headless Chrome(PC) 으로 페이지를 띄워 READY 를 기다린 뒤 (선택) 스크립트를 돌리고 갈무리.
// 사용: node tools/preview-shot.mjs <url> <out.png> [js(READY 뒤 실행, Promise 가능)] [w=360] [h=800] [dpr=3]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [url, out, js = '', w = '360', h = '800', dpr = '3'] = process.argv.slice(2);
const port = 9463;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/c3dprev`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
]);
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
await call('Runtime.enable'); await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: +dpr, mobile: true });
const t0 = Date.now();
await call('Page.navigate', { url });
while (!ready && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200));
console.log(ready ?? 'no READY', logs.filter((l) => /EXC|rror/.test(l)).slice(0, 5).join('\n'));
if (js) { const r = await call('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }); console.log('js:', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? null)); }
await new Promise((r) => setTimeout(r, 800));
const shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
chrome.kill();
process.exit(0);
