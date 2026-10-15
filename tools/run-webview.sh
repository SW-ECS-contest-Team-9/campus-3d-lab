#!/bin/sh
# 사용: tools/run-webview.sh <이름> <url> [layer] [inject.js] [기다릴초]
# emulator-5580 에서 시험 앱으로 띄우고 logcat(LAB·chromium) 과 갈무리를 out/<이름>.* 에 남김.
export PATH=/c/Users/ssant/AppData/Local/Android/Sdk/platform-tools:$PATH
A="adb -s emulator-5580"; N=$1; URL=$2; LAYER=${3:-none}; INJ=$4; W=${5:-40}
mkdir -p out
$A shell am force-stop kr.campus.lab; $A logcat -c
EXTRA=""; [ -n "$INJ" ] && EXTRA="--es inject $(base64 -w0 "$INJ")"
$A shell am start -n kr.campus.lab/.MainActivity --es url "'$URL'" --es layer $LAYER $EXTRA >/dev/null
sleep $W
$A exec-out screencap -p > out/$N.png
$A shell dumpsys meminfo | grep -i -E "sandboxed_process|kr.campus.lab|gpu" | head -5 > out/$N.mem.txt
$A logcat -d -s LAB:* chromium:* cr_*:* AndroidRuntime:* libc:* DEBUG:* ActivityManager:E > out/$N.log
grep -c . out/$N.log; grep -E "MSG|RENDER_GONE|CONSOLE ERROR|WEBGL|Fatal|crash" out/$N.log | cut -c1-300 | head -15; cat out/$N.mem.txt
