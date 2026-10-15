// 실험 앱: Campus3DView 를 화면 가득 띄우고 시험 명령 단추(경로·위치·층). 사건은 console.log('EVENT …') 로 logcat 에.
import { useRef, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Campus3DView, type Campus3DHandle } from './src/Campus3DView';

// 시험 경로: 앱이 실제로 보내던 setRoute(정문 → 북악관 8층, 113점, 2026-10-15 갈무리 때 기록)
import ROUTE from './fixtures/route-gate-bukak8f.json';
// 위치: 북악관 7층(경로 끝 근처) — 실내 따라가기(그 건물 펼치고 7층)
const HERE = { v: 1, type: 'setLocation', lon: 127.0118928, lat: 37.6159927, z: 149.2, accuracyM: 5, floor: '7층', building: '북악관', state: 'ok', markerUrl: null };

export default function App() {
  const map = useRef<Campus3DHandle>(null);
  const [last, setLast] = useState('불러오는 중…');
  const [buildings, setBuildings] = useState<{ id: string; name: string }[]>([]);
  const [bi, setBi] = useState(0);
  const [stats, setStats] = useState<string[]>([]);
  const send = (m: unknown) => map.current?.post(m);
  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" />
      <Campus3DView
        ref={map}
        logFrames
        onStats={(t) => setStats((a) => [...a.slice(-5), t])}
        onEvent={(e) => {
          console.log('EVENT ' + JSON.stringify(e).slice(0, 300));
          if (e.type === 'ready') setBuildings(e.buildings);
          setLast(`${e.type}${'name' in e && e.name ? ' ' + e.name : ''}${'floor' in e && e.floor ? ' ' + e.floor : ''}`);
        }}
      />
      <View style={s.stats} pointerEvents="none">
        {stats.map((t, i) => (
          <Text key={i} style={s.statT} testID={`stat${i}`}>
            {t}
          </Text>
        ))}
      </View>
      <View style={s.bar} pointerEvents="box-none">
        <Text style={s.last}>{last}</Text>
        <View style={s.row}>
          <Btn t="경로" on={() => send(ROUTE)} />
          <Btn t="위치" on={() => send(HERE)} />
          <Btn t="층 펼치기" on={() => { const b = buildings[bi % Math.max(1, buildings.length)]; setBi(bi + 1); if (b) send({ v: 1, type: 'setFloor', building: b.id, floor: '3층', explode: true }); }} />
          <Btn t="한 층" on={() => { const b = buildings.find((x) => x.id === '북악관') ?? buildings[0]; if (b) send({ v: 1, type: 'setFloor', building: b.id, floor: '7층', explode: false }); }} />
          <Btn t="지움" on={() => { send({ v: 1, type: 'clearRoute' }); send({ v: 1, type: 'clearLocation' }); send({ v: 1, type: 'setFloor', building: '', floor: null, explode: false }); }} />
        </View>
      </View>
    </View>
  );
}

function Btn({ t, on }: { t: string; on: () => void }) {
  return (
    <Pressable onPress={on} style={s.btn} accessibilityRole="button">
      <Text style={s.btnT}>{t}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#dfe6e9' },
  stats: { position: 'absolute', left: 8, top: 40, right: 8 },
  statT: { color: '#142235', fontSize: 10, backgroundColor: '#ffffffc0' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 64, alignItems: 'center' },
  last: { backgroundColor: '#142235E0', color: '#fff', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, marginBottom: 8, fontSize: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  btn: { backgroundColor: '#fff', minHeight: 48, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center', borderWidth: 1, borderColor: '#cbd5e1' },
  btnT: { color: '#142235', fontWeight: '600' },
});
