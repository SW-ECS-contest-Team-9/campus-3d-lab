// 실험 앱: Campus3DView 를 화면 가득 띄우고 시험 명령 단추(경로·위치·층). 사건은 console.log('EVENT …') 로 logcat 에.
import { useRef, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Campus3DView, type Campus3DHandle } from './src/Campus3DView';

// 시험 경로(EPSG:5186): 정문 쪽 → 북악관 쪽(대략, 모양 확인용)
const ROUTE = { v: 1, type: 'setRoute', points: [[201020, 556720, 0], [201060, 556800, 0], [201120, 556880, 0], [201150, 556960, 0], [201190, 557040, 0]], floorChanges: [{ at: [201150, 556960, 0], label: '→ 2F' }] };
const HERE = { v: 1, type: 'setLocation', lon: 127.01262, lat: 37.61522, z: null, accuracyM: 6, floor: null, building: null, state: 'ok', markerUrl: null };

export default function App() {
  const map = useRef<Campus3DHandle>(null);
  const [last, setLast] = useState('불러오는 중…');
  const [buildings, setBuildings] = useState<{ id: string; name: string }[]>([]);
  const [bi, setBi] = useState(0);
  const send = (m: unknown) => map.current?.post(m);
  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" />
      <Campus3DView
        ref={map}
        logFrames
        onEvent={(e) => {
          console.log('EVENT ' + JSON.stringify(e).slice(0, 300));
          if (e.type === 'ready') setBuildings(e.buildings);
          setLast(`${e.type}${'name' in e && e.name ? ' ' + e.name : ''}${'floor' in e && e.floor ? ' ' + e.floor : ''}`);
        }}
      />
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
  bar: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
  last: { backgroundColor: '#142235E0', color: '#fff', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, marginBottom: 8, fontSize: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  btn: { backgroundColor: '#fff', minHeight: 48, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center', borderWidth: 1, borderColor: '#cbd5e1' },
  btnT: { color: '#142235', fontWeight: '600' },
});
