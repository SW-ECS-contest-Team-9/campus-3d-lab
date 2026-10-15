import { describe, expect, it } from 'vitest';
import fixture from '../map/fixture/campus-fixture.json';
import type { MapPackage } from '../map/package';
import { buildGraph, findRoute } from '../route/route';
import { floorCommand, locationCommand, packagePlaceKey, pageUrl, parseEvent, routeCommand, sceneBuildingId } from './embed';
import { toFix } from '../location/fix';

const pkg = fixture as unknown as MapPackage;

describe('3D 페이지 메시지', () => {
  it('경로: 길 모양 그대로 EPSG:5186 + z, 층 바뀜은 한 자리에 하나(도착 층)', () => {
    const g = buildGraph(pkg);
    const gate = pkg.places.find((p) => p.name === '정문')!.nodeKey!;
    const to = pkg.nodes.find((n) => n.floorKey === 'f:북악관:8F')!.key;
    const r = findRoute(g, gate, to, 'shortest');
    expect(r.ok).toBe(true);
    const c = routeCommand(g, r as Extract<typeof r, { ok: true }>);
    expect(c.type).toBe('setRoute');
    if (c.type !== 'setRoute') return;
    expect(c.points.length).toBeGreaterThan(r.ok ? r.nodeKeys.length : 0);
    for (const p of c.points) {
      expect(p[0]).toBeGreaterThan(150000);
      expect(p[1]).toBeGreaterThan(500000);
      expect(Number.isFinite(p[2])).toBe(true);
    }
    expect(c.points[0]).toEqual([
      pkg.nodes.find((n) => n.key === gate)!.x,
      pkg.nodes.find((n) => n.key === gate)!.y,
      pkg.nodes.find((n) => n.key === gate)!.z,
    ]);
    expect(c.floorChanges.map((f) => f.label)).toEqual(['→ 8F']);
  });

  it('위치: 확실하면 층·건물을 보내고, 불확실하면 보내지 않음', () => {
    const ok = toFix(127.0136, 37.6151, 6, 0, false);
    const c = locationCommand(ok, { buildingKey: 'b:북악관', floorCode: '7F', z: 149.2 });
    expect(c).toMatchObject({ type: 'setLocation', state: 'ok', building: '북악관', floor: '7F', z: 149.2 });
    if (c.type === 'setLocation') {
      expect(c.lon).toBeCloseTo(127.0136, 6);
      expect(c.lat).toBeCloseTo(37.6151, 6);
    }
    const bad = locationCommand(toFix(127.0136, 37.6151, 40, 0, false), { buildingKey: 'b:북악관', floorCode: '7F', z: 149.2 });
    expect(bad).toMatchObject({ state: 'uncertain', building: null, floor: null, z: null, accuracyM: 40 });
  });

  it('층 고르기·key 바꾸기·주소', () => {
    expect(floorCommand(pkg, 'b:북악관', 'f:북악관:5F')).toEqual({
      v: 1,
      type: 'setFloor',
      building: '북악관',
      floor: '5F',
      explode: false,
    });
    expect(floorCommand(pkg, 'b:북악관', 'all')).toMatchObject({ floor: null });
    expect(sceneBuildingId('b:은주관#2관')).toBe('은주관#2관');
    expect(packagePlaceKey('abc')).toBe('p:abc');
    expect(pageUrl('')).toBe('http://127.0.0.1:5273/client3d.html');
    expect(pageUrl('https://x/client3d.html', true)).toBe('https://x/client3d.html?light=1&msaa=1');
    expect(pageUrl('https://x/client3d.html?a=1', true, true)).toBe('https://x/client3d.html?a=1&light=1&msaa=1&ui=min');
  });

  it('받은 사건: v 1 과 모양만 받음', () => {
    expect(parseEvent(JSON.stringify({ v: 1, type: 'pick', kind: 'place', id: 'a', x: 1, y: 2, z: 3 }))).toMatchObject({ kind: 'place' });
    expect(parseEvent({ v: 2, type: 'ready', buildings: [] })).toBeNull();
    expect(parseEvent({ v: 1, type: 'pick', kind: 'room', x: 1, y: 2, z: 3 })).toBeNull();
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent({ v: 1, type: 'ready', buildings: [] })).toMatchObject({ type: 'ready' });
  });
});
