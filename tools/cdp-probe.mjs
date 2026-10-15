// emulator-5580 의 WebView(또는 Chrome) 에 CDP 로 붙어 상태를 읽음. 사용: node tools/cdp-probe.mjs [webview|chrome] [js 식]
// 출력: 페이지 주소, 상태 글, 캔버스·WebGL 속성, 메모리, 기록된 사건(__c3dEvents), 콘솔(붙은 뒤 3초).
import { execSync } from 'node:child_process';
const ADB = 'C:/Users/ssant/AppData/Local/Android/Sdk/platform-tools/adb.exe -s ' + (process.env.DEV ?? 'emulator-5580');
const kind = process.argv[2] ?? 'webview';
const extra = process.argv[3];
const socks = execSync(`${ADB} shell cat /proc/net/unix`).toString().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((s) => s?.startsWith('@') && s.includes(kind === 'chrome' ? 'chrome_devtools_remote' : 'webview_devtools_remote'));
if (!socks.length) { console.log('devtools 소켓 없음'); process.exit(1); }
let sock = socks[socks.length - 1].slice(1);
if (kind !== 'chrome') { const pid = execSync(`${ADB} shell pidof ${process.env.PKG ?? 'kr.campus.lab'}`).toString().trim().split(/\s+/)[0]; const own = socks.find((s) => s.endsWith('_' + pid)); if (own) sock = own.slice(1); }
execSync(`${ADB} forward tcp:9333 localabstract:${sock}`);
const pages = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('about')) ?? pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled') logs.push(`${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 300)); else if (d.method === 'Runtime.exceptionThrown') logs.push(`EXC: ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`.slice(0, 400)); else if (d.method === 'Log.entryAdded') logs.push(`log ${d.params.entry.level}: ${d.params.entry.text}`.slice(0, 300)); };
await new Promise((r) => (ws.onopen = r));
const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call('Runtime.enable'); await call('Log.enable');
const expr = extra ?? `(() => { const c = document.querySelector('canvas'); let gl = null; try { gl = c && (c.getContext('webgl2') || c.getContext('webgl')); } catch (e) {}
  const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return JSON.stringify({ url: location.href, status: document.getElementById('c3d-status')?.textContent, statusHidden: document.getElementById('c3d-status')?.hidden,
    canvas: c ? [c.width, c.height, c.clientWidth, c.clientHeight] : null, gl: gl ? { v: gl.getParameter(gl.VERSION), lost: gl.isContextLost(), attrs: gl.getContextAttributes(), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null } : null,
    mem: performance.memory ? { used: Math.round(performance.memory.usedJSHeapSize / 1e6), limit: Math.round(performance.memory.jsHeapSizeLimit / 1e6) } : null,
    events: (window.__c3dEvents || []).map((e) => e.type), cesium: !!window.Cesium, dpr: devicePixelRatio }); })()`;
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r.result ?? r.error));
await new Promise((r) => setTimeout(r, 3000));
for (const l of logs) console.log(l);
ws.close(); process.exit(0);
