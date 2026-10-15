// 3D 캠퍼스 지도: campus-tracker 의 client3d.html 을 앱 전체에서 하나만 띄워 둔다(웹 <iframe>, 네이티브 react-native-webview).
// 화면은 <MapSlot> 으로 자리만 잡고, 초점을 받은 화면의 자리로 그 하나를 옮겨 보여 준다(화면 바꿀 때 다시 불러오지 않음).
// 명령은 페이지가 ready 를 보낸 뒤 보내고, 자리·명령이 바뀔 때마다 다시 보낸다. 못 불러오면 각 자리에 평면 지도 + 알림.
import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { BlurTargetView } from 'expo-blur';
import { BlurTargetCtx } from './look';
import { Character } from './v3';
import { parseEvent, type Map3dCommand, type Map3dEvent } from '../map3d/embed';
import { CHARACTER_OK, CHARACTER_UNCERTAIN } from './characterImages';
import { color } from './components';

const READY_TIMEOUT_MS = 25_000;
type Status = 'loading' | 'ready' | 'failed';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Slot {
  id: string;
  rect: Rect | null;
  commands: Map3dCommand[];
  minimal: boolean;
  onEvent?: (e: Map3dEvent) => void;
  overlay?: ReactNode;
}
interface Api {
  put: (s: Slot) => void;
  focus: (id: string, on: boolean) => void;
}

const ApiCtx = createContext<Api | null>(null);

const StatusCtx = createContext<Status>('loading');

/** 앱 뿌리에 한 번. children(화면들) 위에 3D 지도 하나를 겹쳐 둠. */
export function Map3DHost({
  url,
  children,
  onFirstReady,
}: {
  url: string;
  children: ReactNode;
  /** 앱 켠 뒤 첫 ready 까지 걸린 시간(ms, 한 번) — 기기 등급 확인용 */
  onFirstReady?: (ms: number) => void;
}) {
  const [t0] = useState(() => Date.now());
  const firstReady = useRef(false);
  const blurTarget = useRef<View | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const [active, setActive] = useState<string | null>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const rootRef = useRef<View | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const web = useRef<WebView | null>(null);
  const ready = useRef(false);
  const lastUi = useRef<boolean | null>(null);
  const markersSent = useRef(false);

  const api = useMemo<Api>(
    () => ({
      put: (s) => setSlots((all) => ({ ...all, [s.id]: s })),
      // 초점 잃어도 자리 정보는 남김(뒤로 와서 다시 초점 받을 때 바로 씀)
      focus: (id, on) => setActive((cur) => (on ? id : cur === id ? null : cur)),
    }),
    [],
  );
  const slot = active ? slots[active] : undefined;

  const post = useCallback((msg: Map3dCommand | { v: 1; type: 'setMode'; light?: boolean; ui: 'min' | 'full' }) => {
    if (Platform.OS === 'web') frame.current?.contentWindow?.postMessage(msg, '*');
    else web.current?.injectJavaScript(`window.postMessage(${JSON.stringify(JSON.stringify(msg))}, '*'); true;`);
  }, []);

  // 보이는 자리의 명령 보내기(ready 뒤). 자리 바뀜·명령 바뀜마다.
  const cmdKey = slot ? `${slot.id}|${slot.minimal}|${JSON.stringify(slot.commands)}` : '';
  useEffect(() => {
    if (status !== 'ready' || !slot) return;
    if (!markersSent.current) {
      post({ v: 1, type: 'setMarkerImages', ok: CHARACTER_OK, uncertain: CHARACTER_UNCERTAIN });
      markersSent.current = true;
    }
    if (lastUi.current !== slot.minimal) {
      post({ v: 1, type: 'setMode', ui: slot.minimal ? 'min' : 'full' });
      lastUi.current = slot.minimal;
    }
    if (!slot.commands.some((c) => c.type === 'setRoute')) post({ v: 1, type: 'clearRoute' });
    if (!slot.commands.some((c) => c.type === 'setLocation')) post({ v: 1, type: 'clearLocation' });
    for (const c of slot.commands) post(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cmdKey 가 slot 의 내용
  }, [status, cmdKey, post]);

  const handler = useRef<Slot['onEvent']>(undefined);
  const firstReadyCb = useRef(onFirstReady);
  useEffect(() => {
    handler.current = slot?.onEvent;
    firstReadyCb.current = onFirstReady;
  });
  const receive = useCallback(
    (raw: unknown) => {
      const e = parseEvent(raw);
      if (!e) return;
      if (e.type === 'ready') {
        if (!firstReady.current) {
          firstReady.current = true;
          firstReadyCb.current?.(Date.now() - t0);
        }
        ready.current = true;
        lastUi.current = null;
        markersSent.current = false;
        setStatus('ready');
      }
      handler.current?.(e);
    },
    [t0],
  );

  // 주소가 바뀌면 다시 불러옴. 너무 오래 ready 가 안 오면 실패.
  const [loadedUrl, setLoadedUrl] = useState(url);
  if (loadedUrl !== url) {
    setLoadedUrl(url);
    setStatus('loading');
  }
  useEffect(() => {
    ready.current = false;
    const t = setTimeout(() => !ready.current && setStatus('failed'), READY_TIMEOUT_MS);
    if (Platform.OS === 'web') fetch(url, { mode: 'no-cors' }).catch(() => setStatus('failed'));
    return () => clearTimeout(t);
  }, [url]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const on = (e: MessageEvent) => {
      if (frame.current && e.source === frame.current.contentWindow) receive(e.data);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [receive]);

  const rect = slot?.rect;
  const shown = !!rect && status !== 'failed';
  // 숨길 때도 마지막 크기를 유지(지도 다시 그리기 비용 줄임)
  const [r, setR] = useState<Rect>({ x: 0, y: 0, w: 360, h: 400 });
  if (rect && (rect.x !== r.x || rect.y !== r.y || rect.w !== r.w || rect.h !== r.h)) setR(rect);
  return (
    <ApiCtx.Provider value={api}>
      <StatusCtx.Provider value={status}>
        <View ref={rootRef} style={s.root} onLayout={() => rootRef.current?.measureInWindow((x, y) => setOrigin({ x, y }))}>
          {children}
          <View
            pointerEvents={shown ? 'box-none' : 'none'}
            style={[s.host, { left: r.x - origin.x, top: r.y - origin.y, width: r.w, height: r.h, opacity: shown ? 1 : 0 }]}
            accessibilityElementsHidden={!shown}
            importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
          >
            {Platform.OS === 'web' ? (
              <iframe
                ref={frame}
                src={url}
                title="3D 캠퍼스 지도"
                style={{ border: 0, width: '100%', height: '100%', display: 'block', pointerEvents: shown ? 'auto' : 'none' }}
              />
            ) : (
              <BlurTargetView ref={blurTarget} style={s.fill}>
                <WebView
                  ref={web}
                  source={{ uri: url }}
                  style={s.fill}
                  originWhitelist={['*']}
                  javaScriptEnabled
                  onMessage={(e) => receive(e.nativeEvent.data)}
                  onError={() => setStatus('failed')}
                  onHttpError={() => setStatus('failed')}
                />
              </BlurTargetView>
            )}
            {status === 'loading' ? (
              <View style={s.loading} pointerEvents="none">
                <View style={s.loadingPill}>
                  <Character name="loading" size={30} />
                  <Text style={s.loadingT}>3D 지도를 불러오는 중…</Text>
                </View>
              </View>
            ) : null}
            <BlurTargetCtx.Provider value={blurTarget}>{shown ? slot?.overlay : null}</BlurTargetCtx.Provider>
          </View>
        </View>
      </StatusCtx.Provider>
    </ApiCtx.Provider>
  );
}

/** 화면 안 3D 지도 자리. 초점 받은 화면의 자리에 공용 3D 지도가 놓임. 3D 를 못 쓰면 fallback(평면 지도) + 알림. */
export function MapSlot({
  commands,
  onEvent,
  minimal = false,
  overlay,
  fallback,
  style,
}: {
  commands: (Map3dCommand | null)[];
  onEvent?: (e: Map3dEvent) => void;
  minimal?: boolean;
  /** 지도 위에 얹는 단추·배지(3D 위에도 보이게 공용 지도와 함께 그림) */
  overlay?: ReactNode;
  fallback: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const api = useContext(ApiCtx);
  const status = useContext(StatusCtx);
  const id = useId();
  const ref = useRef<View | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const list = useMemo(() => commands.filter((c): c is Map3dCommand => !!c), [commands]);
  const measure = useCallback(() => ref.current?.measureInWindow((x, y, w, h) => w > 0 && h > 0 && setRect({ x, y, w, h })), []);

  useEffect(() => {
    api?.put({ id, rect, commands: list, minimal, onEvent, overlay });
  });
  useFocusEffect(
    useCallback(() => {
      measure();
      api?.focus(id, true);
      return () => api?.focus(id, false);
    }, [api, id, measure]),
  );

  return (
    <View ref={ref} style={[s.fill, style]} onLayout={measure} collapsable={false}>
      {status === 'failed' ? (
        <>
          {/* 알림은 지도 위에 겹치지 않고 위쪽 줄로(짧은 경로가 가려지던 문제) */}
          <View style={s.notice}>
            <Text style={s.noticeT}>3D 지도를 불러오지 못해 평면 지도로 보여요</Text>
          </View>
          <View style={s.fill}>
            {fallback}
            {overlay}
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  host: { position: 'absolute', overflow: 'hidden', backgroundColor: color.canvas },
  fill: { flex: 1, backgroundColor: color.canvas, overflow: 'hidden' },
  notice: { backgroundColor: color.warningSoft, paddingHorizontal: 12, paddingVertical: 8 },
  noticeT: { color: color.warning, fontSize: 13, fontWeight: '600' },
  loading: { position: 'absolute', left: 0, right: 0, top: '40%', alignItems: 'center' },
  loadingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(20,27,58,0.84)',
    paddingLeft: 8,
    paddingRight: 14,
    paddingVertical: 4,
    borderRadius: 999,
  },
  loadingT: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
