#!/bin/sh
# 사용: DEV=<serial> tools/measure-native.sh <이름> [apk]
# 네이티브 실험 앱(kr.campus.lab3d)을 깔고 띄워: 불러오기(LOAD3D·FIRST_FRAME), 끌기 6번 중 프레임(FRAMES), 메모리(PSS), 갈무리 → out/<이름>.*
export PATH=/c/Users/ssant/AppData/Local/Android/Sdk/platform-tools:$PATH
A="adb -s ${DEV:-emulator-5580}"; N=$1; APK=${2:-native/android/app/build/outputs/apk/release/app-release.apk}
mkdir -p out
$A install -r "$APK" >/dev/null || exit 1
$A shell am force-stop kr.campus.lab3d; $A logcat -c
T0=$(date +%s%3N)
$A shell am start -W -n kr.campus.lab3d/.MainActivity | grep -E "TotalTime|WaitTime"
for i in $(seq 1 120); do sleep 1; $A logcat -d -s ReactNativeJS:* | grep -q FIRST_FRAME && break; done
$A logcat -d -s ReactNativeJS:* | grep -E "LOAD3D|FIRST_FRAME|EVENT .*ready|rror" | sed 's/.*ReactNativeJS: //' | cut -c1-200
sleep 2
for k in 1 2 3; do $A shell input swipe 300 1400 800 1000 600; $A shell input swipe 800 1000 300 1400 600; done
sleep 3.5
$A logcat -d -s ReactNativeJS:* | grep FRAMES | sed 's/.*ReactNativeJS: //' | tee out/$N.frames.txt
$A shell dumpsys meminfo kr.campus.lab3d | grep -E "TOTAL PSS|TOTAL RSS|Graphics:|GL mtrack|Native Heap:" | sort -u | tee out/$N.mem.txt
$A exec-out screencap -p > out/$N.png
$A logcat -d > out/$N.logcat.txt
grep -E "FATAL|AndroidRuntime: |SIGSEGV" out/$N.logcat.txt | head -5
