#!/bin/sh
# 사용: tools/measure-webview.sh <이름> <url> [inject.js]
# ready 까지 시간(앱이 주소를 연 때부터, 최대 150 s), 끌기 중 프레임(adb swipe 6번, rAF 간격), 렌더러 PSS, 갈무리 → out/<이름>.*
export PATH=/c/Users/ssant/AppData/Local/Android/Sdk/platform-tools:$PATH
A="adb -s ${DEV:-emulator-5580}"; N=$1; URL=$2; INJ=${3:-pages/inject-events.js}
mkdir -p out
$A shell am force-stop kr.campus.lab; $A logcat -c
$A shell am start -n kr.campus.lab/.MainActivity --es url "'$URL'" --es inject $(base64 -w0 "$INJ") >/dev/null
READY=""
for i in $(seq 1 150); do sleep 1; READY=$($A logcat -d -s LAB:I | grep -o 'MSG +[0-9]*ms {"v":1,"type":"ready\|MSG +[0-9]*ms {"type":"ready' | head -1 | grep -o '+[0-9]*'); [ -n "$READY" ] && break; done
echo "ready ${READY:-none}ms"
sleep 3
node tools/cdp-probe.mjs webview "window.__ft=[];(function f(t){window.__ft.push(t);if(window.__ft.length<2000)requestAnimationFrame(f)})(performance.now());'started'" >/dev/null
for k in 1 2 3; do $A shell input swipe 300 1400 800 1000 600; $A shell input swipe 800 1000 300 1400 600; done
node tools/cdp-probe.mjs webview "(()=>{const t=window.__ft,d=[];for(let i=1;i<t.length;i++)d.push(t[i]-t[i-1]);d.sort((a,b)=>a-b);const q=p=>Math.round(d[Math.floor(d.length*p)]||0);return JSON.stringify({frames:d.length,secs:Math.round((t[t.length-1]-t[0])/100)/10,p50:q(.5),p95:q(.95),max:Math.round(d[d.length-1]||0)})})()" | head -1 > out/$N.frames.json
cat out/$N.frames.json
PID=$($A shell pidof com.google.android.webview:sandboxed_process0 com.android.chrome:sandboxed_process0 | tr -d '\r' | awk '{print $1}')
$A shell dumpsys meminfo $PID | grep -E "TOTAL PSS|TOTAL RSS|Graphics:|GL mtrack" | sort -u | head -6 | tee out/$N.mem.txt
$A exec-out screencap -p > out/$N.png
$A logcat -d -s LAB:* chromium:* > out/$N.log
grep -E "RENDER_GONE|CONSOLE ERROR" out/$N.log | cut -c1-200 | head -5
