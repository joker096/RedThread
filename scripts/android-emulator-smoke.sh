#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE="android-emulator-logcat.txt"
capture_logcat() {
  adb logcat -d -t 5000 > "$LOG_FILE" 2>/dev/null || true
}
finish() {
  local status=$?
  trap - EXIT
  capture_logcat
  if [[ "$status" -ne 0 ]]; then
    echo "Android smoke test failed (exit $status); collecting device diagnostics." >&2
    adb devices -l >&2 || true
    adb shell getprop sys.boot_completed >&2 || true
    adb shell service check package >&2 || true
    adb shell service check activity >&2 || true
    tail -n 180 "$LOG_FILE" >&2 || true
  fi
  exit "$status"
}
trap finish EXIT

adb wait-for-device

# Retry transient ADB transport failures. Real command failures still fail after
# bounded retries and are reported with the command and its output.
adb_call() {
  local attempt output status
  for attempt in 1 2 3; do
    if output="$(adb "$@" 2>&1)"; then
      [[ -z "$output" ]] || printf '%s\n' "$output"
      return 0
    else
      status=$?
      printf 'ADB attempt %s/3 failed: adb %s (exit %s): %s\n' "$attempt" "$*" "$status" "$output" >&2
      adb reconnect offline >/dev/null 2>&1 || true
      sleep 3
      adb wait-for-device || true
    fi
  done
  return "$status"
}

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
  exit 1
fi

APK="android/app/build/outputs/apk/debug/app-debug.apk"
test -s "$APK"
echo "Installing Vow APK"
adb_call install -r "$APK"

# Installing the package can briefly overload PackageManager on cold AVD boots.
app_package_ready=0
for attempt in $(seq 1 30); do
  package_path="$(adb shell cmd package path com.vow.app 2>&1 || true)"
  if grep -q "^package:" <<< "$package_path"; then
    app_package_ready=1
    break
  fi
  sleep 2
done
if [[ "$app_package_ready" -ne 1 ]]; then
  echo "PackageManager did not return the installed Vow package path" >&2
  exit 1
fi

echo "Granting and verifying microphone permission"
adb_call shell pm grant com.vow.app android.permission.RECORD_AUDIO
permission_state="$(adb_call shell cmd package check-permission android.permission.RECORD_AUDIO com.vow.app)"
printf 'RECORD_AUDIO permission: %s\n' "$permission_state"
test "$permission_state" = "granted"
adb_call shell appops get com.vow.app RECORD_AUDIO || true

# Resolve and launch the app directly; monkey unnecessarily stresses low-resource CI emulators.
launcher_activity="$(adb_call shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.vow.app | tr -d '\r' | tail -n 1)"
if [[ "$launcher_activity" != *"/"* ]]; then
  echo "Unable to resolve Vow launcher activity: $launcher_activity" >&2
  exit 1
fi
echo "Launching Vow activity: $launcher_activity"
launch_result="$(adb_call shell am start -W -n "$launcher_activity")"
printf '%s\n' "$launch_result"
grep -q "Status: ok" <<< "$launch_result"
sleep 5
activity_state="$(adb_call shell dumpsys activity activities)"
grep -E 'ResumedActivity|topResumedActivity|mResumedActivity' <<< "$activity_state" | grep -F com.vow.app

capture_logcat
if grep -A 8 -E 'FATAL EXCEPTION|Fatal signal' "$LOG_FILE" | grep -F com.vow.app; then
  echo "Vow crashed on Android Emulator" >&2
  exit 1
fi
