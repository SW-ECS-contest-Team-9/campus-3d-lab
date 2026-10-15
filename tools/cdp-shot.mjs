// CDP 로 페이지 갈무리(합성기 출력). 사용: node tools/cdp-shot.mjs <출력.png> [webview|chrome]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const ADB = 'C:/Users/ssant/AppData/Local/Android/Sdk/platform-tools/adb.exe -s ' + (process.env.DEV ?? 'emulator-5580');
const [out, kind = 'webview'] = process.argv.slice(2);
const socks = execSync(`${ADB} shell cat /proc/net/unix`).toString().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((s) => s?.startsWith('@') && s.includes(kind === 'chrome' ? 'chrome_devtools_remote' : 'webview_devtools_remote'));
let sock = socks[socks.length - 1].slice(1);
if (kind !== 'chrome') { const pid = execSync(`${ADB} shell pidof ${process.env.PKG ?? 'kr.campus.lab'}`).toString().trim().split(/\s+/)[0]; const own = socks.find((s) => s.endsWith('_' + pid)); if (own) sock = own.slice(1); }
execSync(`${ADB} forward tcp:9333 localabstract:${sock}`);
const pages = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('about')) ?? pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { if (d.result) fs.writeFileSync(out, Buffer.from(d.result.data, 'base64')); console.log(d.result ? `saved ${out}` : JSON.stringify(d.error)); process.exit(0); } };
ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
