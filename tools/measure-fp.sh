#!/bin/sh
# 사용: DEV=<serial> tools/measure-fp.sh <이름> [apk]
# 네이티브 실험 앱에서 '1인칭'(정문 → 북악관 6층, 2배속)을 눌러 25 s 걷는 동안 프레임 간격(FRAMES, 3 s 묶음)·메모리·갈무리 → out/<이름>.*
export MSYS_NO_PATHCONV=1
export PATH=/c/Users/ssant/AppData/Local/Android/Sdk/platform-tools:$PATH
A="adb -s ${DEV:-emulator-5580}"; N=$1; APK=${2:-native/android/app/build/outputs/apk/release/app-release.apk}
mkdir -p out
$A install -r "$APK" >/dev/null || exit 1
$A shell am force-stop kr.campus.lab3d; $A logcat -c
$A shell am start -W -n kr.campus.lab3d/.MainActivity | grep -E "TotalTime"
for i in $(seq 1 120); do sleep 1; $A logcat -d -s ReactNativeJS:* | grep -q FIRST_FRAME && break; done
$A logcat -d -s ReactNativeJS:* | grep -E "LOAD3D|FIRST_FRAME|rror" | sed 's/.*ReactNativeJS: //' | cut -c1-200
sleep 2
DEV=${DEV:-emulator-5580} sh tools/tap-text.sh "1인칭" || exit 1
for k in 1 2 3 4 5; do sleep 5; $A exec-out screencap -p > out/$N.$k.png; done
$A logcat -d -s ReactNativeJS:* | grep FRAMES | sed 's/.*ReactNativeJS: //' | tee out/$N.frames.txt
$A shell dumpsys meminfo kr.campus.lab3d | grep -E "TOTAL PSS|TOTAL RSS|Graphics:|GL mtrack|Native Heap:" | sort -u | tee out/$N.mem.txt
$A shell dumpsys gfxinfo kr.campus.lab3d | grep -E "Total frames|Janky|percentile" | tee out/$N.gfx.txt
$A logcat -d > out/$N.logcat.txt
grep -E "FATAL|AndroidRuntime: |SIGSEGV" out/$N.logcat.txt | head -5
