#!/bin/sh
# 사용: DEV=<serial> tools/tap-text.sh <글자> — 화면에서 그 글자를 가진 요소의 가운데를 누름(uiautomator)
export MSYS_NO_PATHCONV=1 PATH=/c/Users/ssant/AppData/Local/Android/Sdk/platform-tools:$PATH
A="adb -s ${DEV:-emulator-5580}"
$A shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
B=$($A shell cat /sdcard/ui.xml | grep -o "text=\"$1\"[^>]*bounds=\"[^\"]*\"" | head -1 | grep -o 'bounds="[^"]*"' | grep -o '[0-9]*' | tr '\n' ' ')
set -- $B
[ -z "$4" ] && { echo "못 찾음"; exit 1; }
$A shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
