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
for attempt in $(seq 1 120); do
  package_service="$(adb shell service check package 2>&1 || true)"
  activity_service="$(adb shell service check activity 2>&1 || true)"
  package_list="$(adb shell cmd package list packages 2>&1 || true)"
  if grep -q "Service package: found" <<< "$package_service" \
    && grep -q "Service activity: found" <<< "$activity_service" \
    && grep -q "^package:" <<< "$package_list"; then
    package_ready=1
    break
  fi
  sleep 5
done

if [[ "$package_ready" -ne 1 ]]; then
  echo "Android system services did not become ready after emulator boot" >&2
  adb shell getprop sys.boot_completed || true
  adb shell service check package || true
  adb shell service check activity || true
  adb shell cmd package list packages || true
  capture_logcat
  tail -n 250 "$LOG_FILE" >&2 || true
  exit 1
fi

APK="android/app/build/outputs/apk/debug/app-debug.apk"
test -s "$APK"
adb install -r "$APK"
adb shell pm grant com.vow.app android.permission.RECORD_AUDIO
permission_state="$(adb shell appops get com.vow.app RECORD_AUDIO)"
printf '%s\n' "$permission_state"
grep -qE 'RECORD_AUDIO: (allow|foreground)' <<< "$permission_state"

# Resolve and launch the app directly; monkey unnecessarily stresses low-resource CI emulators.
launcher_activity="$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.vow.app | tr -d '\r' | tail -n 1)"
if [[ "$launcher_activity" != *"/"* ]]; then
  echo "Unable to resolve Vow launcher activity: $launcher_activity" >&2
  exit 1
fi
launch_result="$(adb shell am start -W -n "$launcher_activity")"
printf '%s\n' "$launch_result"
grep -q "Status: ok" <<< "$launch_result"
sleep 5
activity_state="$(adb shell dumpsys activity activities)"
grep -E 'ResumedActivity|topResumedActivity|mResumedActivity' <<< "$activity_state" | grep -F com.vow.app

capture_logcat
if grep -A 8 -E 'FATAL EXCEPTION|Fatal signal' "$LOG_FILE" | grep -F com.vow.app; then
  echo "Vow crashed on Android Emulator" >&2
  exit 1
fi
