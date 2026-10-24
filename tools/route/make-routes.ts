// 시험 경로 만들기: 백엔드 꾸러미(최신 skuniv-v*.json)를 앱의 기기 경로 계산(campus-client src/route, 그대로 복사)으로 풀어
// native/fixtures/fp-*.json 에 setRoute 명령 + 단계(steps)로 저장. 사용: tsx tools/route/make-routes.ts <꾸러미.json>
import fs from 'node:fs';
import { buildGraph, findRoute } from './route';

const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const place = (name: string) => pkg.places.find((p: any) => p.name.startsWith(name))?.nodeKey;
const CASES: [string, string, string, string][] = [
  ['fp-gate-bukak6f', '정문', '북악관 6층', 'shortest'],
  ['fp-hallim-link', '한림관 입구', '한림관–은주1관 연결통로', 'shortest'],
];
const t0 = Date.now();
const g = buildGraph(pkg);
console.log('graph', Date.now() - t0, 'ms');
for (const [file, a, b, mode] of CASES) {
  const r = findRoute(g, place(a), place(b), mode as any);
  if (!r.ok) { console.log(file, 'no route', r); continue; }
  // 층이 바뀌는 단계의 시작점(경로 점 순서로 길이를 따라가 찾음)
  const steps = r.steps.map((s) => ({ kind: s.kind, lengthM: s.lengthM, fromFloor: s.fromFloor, toFloor: s.toFloor, floorChange: s.floorChange, text: s.text }));
  const out = { v: 1, type: 'setRoute', points: r.points.map((p: any) => [p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]]), floorChanges: [], steps, source: `${process.argv[2].split(/[\/]/).pop()} ${mode} ${a} → ${b}`, totalLengthM: r.totalLengthM, durationS: r.durationS };
  fs.writeFileSync(`native/fixtures/${file}.json`, JSON.stringify(out));
  console.log(file, r.points.length, 'pts', r.totalLengthM, 'm', steps.map((s) => `${s.kind}${s.floorChange ? '*' : ''}:${s.fromFloor ?? ''}>${s.toFloor ?? ''}`).join(' | '));
}
