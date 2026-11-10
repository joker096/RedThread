#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE="android-emulator-logcat.txt"
capture_logcat() {
  adb logcat -d -t 5000 > "$LOG_FILE" 2>/dev/null || true
}
trap capture_logcat EXIT

adb wait-for-device

# Android can report sys.boot_completed before PackageManager is available.
package_ready=0
for attempt in $(seq 1 90); do
  if adb shell cmd package list packages >/dev/null 2>&1; then
    package_ready=1
    break
  fi
  sleep 5
done

if [[ "$package_ready" -ne 1 ]]; then
  echo "Android PackageManager did not become ready after emulator boot" >&2
  adb shell getprop sys.boot_completed || true
  adb shell service check package || true
  exit 1
fi

APK="android/app/build/outputs/apk/debug/app-debug.apk"
test -s "$APK"
adb install -r "$APK"
adb shell pm grant com.vow.app android.permission.RECORD_AUDIO
adb shell appops get com.vow.app RECORD_AUDIO
adb shell monkey -p com.vow.app -c android.intent.category.LAUNCHER 1
sleep 8
adb shell dumpsys activity activities | grep -E 'ResumedActivity|topResumedActivity' | grep -F com.vow.app

capture_logcat
if grep -A 8 -E 'FATAL EXCEPTION|Fatal signal' "$LOG_FILE" | grep -F com.vow.app; then
  echo "Vow crashed on Android Emulator" >&2
  exit 1
fi
