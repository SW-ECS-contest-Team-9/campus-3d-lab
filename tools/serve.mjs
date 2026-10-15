// 정적 서버 + /api 프록시(시험 백엔드). 사용: node tools/serve.mjs <dist 폴더> [포트=5291] [백엔드=http://127.0.0.1:3210]
// 요청마다 크기·시간을 out/serve.log 에 남김(에뮬레이터가 무엇을 받았는지 확인용). gzip 은 하지 않음(운영과 다를 수 있음, 추정).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [root, port = '5291', backend = 'http://127.0.0.1:3210'] = process.argv.slice(2);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
fs.mkdirSync('out', { recursive: true });
const log = fs.createWriteStream('out/serve.log', { flags: 'a' });
http.createServer((req, res) => {
  const t = Date.now();
  res.on('finish', () => log.write(`${new Date().toISOString()} ${res.statusCode} ${req.url} ${res.getHeader('content-length') ?? ''} ${Date.now() - t}ms\n`));
  if (req.url.startsWith('/api/')) {
    const p = http.request(backend + req.url, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
    return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(path.resolve(root))) { res.writeHead(403); return res.end(); }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(+port, '0.0.0.0', () => console.log(`serve ${root} :${port} -> ${backend}`));
