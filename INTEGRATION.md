# campus-3d-lab — Android 3D 지도 실험·끼워 넣기 안내

작성: Claude, 2026-10-15. 로컬 저장소(푸시 안 함). 다른 저장소(campus-client, campus-tracker*, campus-backend)는 고치지 않았고, 아래 패치·부품을 사람이 적용한다.

## 무엇이 있나
| 경로 | 내용 |
|---|---|
| `testapp/` | WebView 시험 앱(Java, `kr.campus.lab`). 주소·레이어·문서 시작 스크립트(extra)로 띄우고 콘솔·렌더러 죽음을 logcat `LAB` 에 |
| `pages/` | WebGL 확인, Cesium 최소 페이지, 주입 스크립트(WebGL1·MSAA·시간 재기) |
| `tools/` | `serve.mjs`(정적+API 프록시), `run-webview.sh`·`measure-webview.sh`(ready·끌기 프레임·메모리), `cdp-probe.mjs`·`cdp-shot.mjs`(WebView CDP), `profile-desktop.mjs`, `preview-shot.mjs`, `measure-native.sh` |
| `patches/client3d-android.patch` | 3D 페이지(campus-tracker `feature/client3d` 47b5531 기준): `?msaa=1`(+FXAA), `?res=N`, ready 에 `gpu`·`loadMs`·`msaa` |
| `patches/campus-client-webview.patch` | 앱(campus-client 9236f19 기준): 렌더러 죽음 → 평면 지도, ready 60 s, 하드웨어 레이어, 디버깅(dev 만), 가벼운 = `light=1&msaa=1`, `src/map3d/tier.ts`(gpuTier)+시험 |
| `export/` | 웹 모델링 → `campus.glb` 내보내기(가로채기 → GLB, 크기 보고서 `out/size-report.json`), `test/` 변환 시험 |
| `native/` | 네이티브 3D: `src/campusScene.ts`(three.js 장면, 플랫폼 공용), `src/Campus3DView.tsx`(끼워 넣기 부품, expo-gl), `App.tsx`(실험 앱 `kr.campus.lab3d`), `assets/campus.glb` |
| `preview/` | 같은 장면을 PC 브라우저로(갈무리·검토용) |

## v1.0(오늘): WebView 3D 를 믿을 만하게
1. 3D 페이지는 **vite 개발 서버가 아닌 제품 빌드**로 내보낸다(`npm run build` → `frontend/dist`, 정적 서버). 개발 서버를 다른 가지로 바꾼 체크아웃에서 띄우면 `client3d.html` 이 없어져 SPA 대체로 미리보기 페이지가 나가고 ready 가 안 온다(오늘 실기기·에뮬레이터 둘 다 겪음).
2. campus-tracker `feature/client3d` 에 `git apply patches/client3d-android.patch`.
3. campus-client 에 `git apply patches/campus-client-webview.patch` → `npm test`.
4. 등급(tier): ready 사건의 `gpu` 를 `gpuTier()` 에 넣어 2 면 설정 "가벼운 3D 지도"를 켬(처음 한 번, 사용자가 바꾼 값이 있으면 그대로). 3D 실패(시간 초과·렌더러 죽음)를 저장해 두 번 이어지면 3(평면 지도). 이 연결(설정 저장)은 앱 상태 코드가 바뀌는 중이라 패치에 넣지 않음 — `_layout.tsx` 의 `Map3DHost onFirstReady` 옆에 붙이면 됨.
   - tier 1 전체 3D: S21 이상(Mali-G78·G710+, Xclipse, Adreno 66x·7xx·8xx)
   - tier 2 가벼운 3D: S10·S20·A5x(Mali-G76·G77·G68, Adreno 6xx) — 구조물·이름표 없음, MSAA 끔
   - tier 3 평면 지도: WebGL2 없음 또는 3D 연속 2번 실패

## v1.1: 네이티브 3D 로 바꾸기(Campus3DView)
1. 의존성(Expo SDK 57): `npx expo install expo-gl expo-asset`, `npm i three@0.186.1` (+ dev `@types/three@0.186.0`).
2. `native/src/{Campus3DView.tsx,campusScene.ts,geo.js,geo.d.ts,protocol.ts}` 를 `src/map3d/native/` 로, `native/assets/campus.glb` 를 `assets/3d/` 로 복사(부품 안 `require` 경로 맞춤). `metro.config.js` 에 `config.resolver.assetExts.push('glb')`.
3. `src/ui/Map3D.tsx` 의 `<WebView …/>` 자리를 바꿈:
   ```tsx
   const native = useRef<Campus3DHandle>(null);
   // post(): Platform.OS !== 'web' 이면 native.current?.post(msg)
   <Campus3DView ref={native} light={light} onEvent={(e) => receive(e)} />
   ```
   `receive` 는 객체도 받음(`parseEvent` 가 객체·문자열 둘 다 처리하는지 확인). 명령·사건 형식이 같아 화면(MapSlot) 코드는 그대로.
4. 자료 갱신: 모델링이 바뀌면 `node tools/serve.mjs vendor/tracker/frontend/dist 5291` → `node export/capture.mjs` → `python export/ground-rgba.py` → `node export/build-glb.mjs` → `node --test export/test`.
   지도 꾸러미와 함께 내려받게 하려면 `campus.glb` 를 꾸러미에 넣고 부품의 `loadGlb()` 를 꾸러미 파일 경로로 바꾸면 됨(지금은 앱에 묶음).

## 측정 다시 하기
- WebView: `DEV=<serial> tools/measure-webview.sh <이름> "http://127.0.0.1:5291/client3d.html"` (실기기는 `adb reverse tcp:5291 tcp:5291`)
- 네이티브: `cd native/android && gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64` → `DEV=<serial> tools/measure-native.sh <이름>`
