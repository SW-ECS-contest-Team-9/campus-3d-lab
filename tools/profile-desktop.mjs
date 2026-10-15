// headless Chrome(PC) 에서 client3d 를 CPU 프로파일 → ready 까지 자체 시간 상위 함수. 사용: node tools/profile-desktop.mjs <url> [cpu배수=4]
import { spawn } from 'node:child_process';
const [url, rate = '4'] = process.argv.slice(2);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9461', '--user-data-dir=' + process.env.TEMP + '/c3dprof', '--window-size=360,800', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank']);
let tabs = null;
for (let i = 0; i < 40 && !tabs; i++) { await new Promise((r) => setTimeout(r, 500)); tabs = await fetch('http://127.0.0.1:9461/json').then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const wait = new Map(); let ready = null;
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d.result); wait.delete(d.id); } if (d.method === 'Runtime.consoleAPICalled' && String(d.params.args[0]?.value).startsWith('READY')) ready = d.params.args[0].value; };
const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call('Runtime.enable'); await call('Profiler.enable'); await call('Emulation.setCPUThrottlingRate', { rate: +rate });
await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.ReactNativeWebView={postMessage(s){if(s.includes('"ready"'))console.log('READY '+Math.round(performance.now()))}}` });
await call('Profiler.setSamplingInterval', { interval: 500 });
await call('Profiler.start');
await call('Page.navigate', { url });
for (let i = 0; i < 240 && !ready; i++) await new Promise((r) => setTimeout(r, 500));
const { profile } = await call('Profiler.stop');
console.log(ready ?? 'no ready');
const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; const counts = new Map();
profile.samples.forEach((s, i) => counts.set(s, (counts.get(s) ?? 0) + (dt[i] ?? 0)));
for (const [nid, us] of counts) { const n = byId.get(nid); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + us); }
// 포함 시간: 부모 사슬
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map();
for (const [nid, us] of counts) { const seen = new Set(); let p = nid; while (p) { const n = byId.get(p); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; if (!seen.has(k)) { incl.set(k, (incl.get(k) ?? 0) + us); seen.add(k); } p = parent.get(p); } }
console.log('-- self ms'); [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(Math.round(v / 1000), k));
console.log('-- inclusive ms'); [...incl].filter(([k]) => !k.startsWith('(')).sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) => console.log(Math.round(v / 1000), k));
chrome.kill(); process.exit(0);
