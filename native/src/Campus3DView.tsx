// 네이티브 3D 캠퍼스 지도(expo-gl + three.js). client3d 페이지(WebView)를 대신하는 끼워 넣기 부품.
// 같은 메시지 형식 v1: ref.post(명령) 으로 보내고 onEvent(사건) 으로 받음 — 앱 화면 코드는 바꾸지 않아도 됨.
// 자료는 앱에 묶인 assets/campus.glb(웹 모델링을 구운 것, export/build-glb.mjs). 서버·인터넷 없이 뜸.
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Image, PanResponder, PixelRatio, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as THREE from 'three';
import { createCampusScene, type CampusScene } from './campusScene';
import type { PageEvent } from './protocol';

// Hermes 에 없을 수 있는 것(GLTFLoader 가 JSON 덩어리를 읽을 때 씀)
if (typeof (globalThis as any).TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = class {
    decode(b: Uint8Array) {
      let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      try { return decodeURIComponent(escape(s)); } catch { return s; }
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CAMPUS_GLB = require('../assets/campus.glb');

export interface Campus3DHandle {
  /** client3d 와 같은 명령(객체 또는 JSON 문자열) */
  post: (msg: unknown) => void;
}
export interface Campus3DProps {
  onEvent?: (e: PageEvent) => void;
  /** 가벼운 모드: 선 끔 + 해상도 2/3 (tier 2) */
  light?: boolean;
  style?: StyleProp<ViewStyle>;
  /** 측정용: 손으로 움직이는 동안 프레임 간격을 3 s 마다 console.log('FRAMES …') */
  logFrames?: boolean;
}

async function loadGlb(): Promise<ArrayBuffer> {
  // 묶은 자산을 캐시 파일로 꺼낸 뒤(expo-asset) 통째로 읽음(expo-file-system). 지도 꾸러미에 넣을 땐 그 파일 경로를 바로 File 로.
  const asset = Asset.fromModule(CAMPUS_GLB);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  try {
    return await new File(uri).arrayBuffer();
  } catch (err) {
    throw new Error(`campus.glb 를 읽지 못함(${uri}): ${String((err as Error)?.message ?? err)}`);
  }
}

export const Campus3DView = forwardRef<Campus3DHandle, Campus3DProps>(function Campus3DView({ onEvent, light = false, style, logFrames = false }, ref) {
  const sceneRef = useRef<CampusScene | null>(null);
  const queue = useRef<unknown[]>([]);
  const handler = useRef(onEvent);
  useEffect(() => { handler.current = onEvent; });
  const [markers, setMarkers] = useState<{ ok: string | null; uncertain: string | null }>({ ok: null, uncertain: null });
  const [markerState, setMarkerState] = useState<'ok' | 'uncertain' | null>(null);
  const markerPos = useRef(new Animated.ValueXY({ x: -999, y: -999 })).current;
  const scale = useRef(1);

  const post = useCallback((msg: unknown) => {
    let m: any = msg;
    if (typeof msg === 'string') { try { m = JSON.parse(msg); } catch { /* scene 이 오류 사건을 보냄 */ } }
    if (m && m.type === 'setMarkerImages') setMarkers({ ok: m.ok ?? null, uncertain: m.uncertain ?? null });
    if (sceneRef.current) sceneRef.current.command(msg);
    else queue.current.push(msg);
  }, []);
  useImperativeHandle(ref, () => ({ post }), [post]);

  const onContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
    const t0 = Date.now();
    try {
      const k = light ? 2 / 3 : 1;
      const w = Math.round(gl.drawingBufferWidth * k), h = Math.round(gl.drawingBufferHeight * k);
      scale.current = (PixelRatio.get() * k);
      const canvas: any = { width: w, height: h, style: {}, clientWidth: w, clientHeight: h, addEventListener: () => {}, removeEventListener: () => {}, getContext: () => gl };
      // expo-gl 의 문맥은 GLES 3(WebGL2 함수 있음)이지만 WebGLRenderingContext 의 인스턴스라 three(r163+)가 WebGL1 로 보고 거절함 → 만들 때만 전역을 숨김
      const G = globalThis as any, saved = G.WebGLRenderingContext;
      G.WebGLRenderingContext = undefined;
      let renderer: THREE.WebGLRenderer;
      try { renderer = new THREE.WebGLRenderer({ canvas, context: gl as any, antialias: false, powerPreference: 'high-performance' }); } finally { G.WebGLRenderingContext = saved; }
      renderer.setPixelRatio(1);
      const glb = await loadGlb();
      const tAsset = Date.now();
      const scene = await createCampusScene({ renderer, width: w, height: h, glb, light, emit: (e) => handler.current?.(e) });
      sceneRef.current = scene;
      for (const m of queue.current.splice(0)) scene.command(m);
      console.log(`LOAD3D asset ${tAsset - t0} ms, scene ${Date.now() - tAsset} ms, total ${Date.now() - t0} ms, buffer ${w}x${h}`);
      let first = true;
      const frames: number[] = [];
      let lastLog = Date.now();
      const loop = () => {
        const drew = scene.frameTick();
        if (drew) {
          gl.endFrameEXP();
          if (first) { first = false; console.log(`FIRST_FRAME ${Date.now() - t0} ms`, JSON.stringify(scene.info())); }
          if (logFrames) frames.push(Date.now());
        }
        const p = scene.markerScreen();
        if (p) { markerPos.setValue({ x: p.x / scale.current, y: p.y / scale.current }); setMarkerState((s) => (s === p.state ? s : p.state)); }
        else setMarkerState((s) => (s === null ? s : null));
        if (logFrames && Date.now() - lastLog > 3000 && frames.length > 10) {
          const d = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
          const q = (x: number) => d[Math.min(d.length - 1, Math.floor(d.length * x))];
          console.log(`FRAMES n=${d.length} p50=${q(0.5)} p95=${q(0.95)} max=${d[d.length - 1]} ms`);
          frames.length = 0; lastLog = Date.now();
        }
        requestAnimationFrame(loop);
      };
      loop();
    } catch (err) {
      console.error('3D 실패', err);
      handler.current?.({ v: 1, type: 'error', error: `native3d: ${String((err as Error)?.message ?? err)}` });
    }
  }, [light, logFrames, markerPos]);

  // 손 조작: 한 손가락 끌기 = 이동, 두 손가락 = 확대·회전(함께 위아래로 = 기울이기), 짧게 누름 = 고르기
  const g = useRef({ x: 0, y: 0, d: 0, a: 0, my: 0, n: 0, moved: 0, t: 0 }).current;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => { const t = e.nativeEvent.touches; g.n = t.length; g.x = t[0].pageX; g.y = t[0].pageY; g.moved = 0; g.t = Date.now(); if (t.length > 1) two(t); },
    onPanResponderMove: (e) => {
      const s = sceneRef.current; const t = e.nativeEvent.touches;
      if (!s || !t.length) return;
      const k = scale.current;
      if (t.length === 1) {
        if (g.n !== 1) { g.n = 1; g.x = t[0].pageX; g.y = t[0].pageY; return; }
        const dx = t[0].pageX - g.x, dy = t[0].pageY - g.y; g.moved += Math.abs(dx) + Math.abs(dy);
        s.pan(dx * k, dy * k); g.x = t[0].pageX; g.y = t[0].pageY;
      } else {
        if (g.n < 2) { g.n = 2; two(t); return; }
        const dxp = t[1].pageX - t[0].pageX, dyp = t[1].pageY - t[0].pageY;
        const d = Math.hypot(dxp, dyp), a = Math.atan2(dyp, dxp), my = (t[0].pageY + t[1].pageY) / 2;
        const zoom = d / (g.d || d);
        if (Math.abs(zoom - 1) > 0.002) s.zoom(zoom);
        let da = a - g.a; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        s.rotate(-da);
        if (Math.abs(zoom - 1) < 0.01 && Math.abs(da) < 0.01) s.tilt(-(my - g.my));
        g.d = d; g.a = a; g.my = my; g.moved += 10;
      }
    },
    onPanResponderRelease: (e) => {
      if (g.moved < 8 && Date.now() - g.t < 350 && sceneRef.current) sceneRef.current.tap(e.nativeEvent.locationX * scale.current, e.nativeEvent.locationY * scale.current);
    },
  })).current;
  function two(t: any) { g.d = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY); g.a = Math.atan2(t[1].pageY - t[0].pageY, t[1].pageX - t[0].pageX); g.my = (t[0].pageY + t[1].pageY) / 2; }

  const img = markerState === 'ok' ? markers.ok : markerState === 'uncertain' ? markers.uncertain : null;
  return (
    <View style={[s.fill, style]} {...pan.panHandlers}>
      <GLView style={s.fill} onContextCreate={onContextCreate} />
      {markerState ? (
        <Animated.View pointerEvents="none" style={[s.marker, { transform: [{ translateX: Animated.subtract(markerPos.x, 32) }, { translateY: Animated.subtract(markerPos.y, 64) }] }]}>
          {img ? <Image source={{ uri: img }} style={s.markerImg} /> : <View style={[s.dot, markerState === 'uncertain' && s.dotU]} />}
        </Animated.View>
      ) : null}
    </View>
  );
});

const s = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  marker: { position: 'absolute', left: 0, top: 0, width: 64, height: 64, alignItems: 'center', justifyContent: 'flex-end' },
  markerImg: { width: 64, height: 64, resizeMode: 'contain' },
  dot: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#0F766E', borderWidth: 4, borderColor: '#fff', marginBottom: 4 },
  dotU: { backgroundColor: '#B45309' },
});
