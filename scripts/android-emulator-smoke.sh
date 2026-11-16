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
# Android 15's package shell does not expose the old check-permission subcommand.
# Verify the runtime grant from PackageManager's package dump instead.
package_dump="$(adb_call shell dumpsys package com.vow.app)"
if ! grep -Fq 'android.permission.RECORD_AUDIO: granted=true' <<< "$package_dump"; then
  echo "RECORD_AUDIO runtime permission was not granted" >&2
  grep -F 'android.permission.RECORD_AUDIO' <<< "$package_dump" >&2 || true
  exit 1
fi
echo "RECORD_AUDIO permission: granted"
appops_state="$(adb_call shell appops get com.vow.app RECORD_AUDIO)"
printf '%s\n' "$appops_state"
# Android may report "foreground" rather than "allow" for a granted runtime
# microphone permission. Foreground is the expected privacy-preserving mode.
if ! grep -Eq 'RECORD_AUDIO: (allow|foreground)([[:space:];]|$)' <<< "$appops_state"; then
  echo "RECORD_AUDIO app-op is neither allow nor foreground" >&2
  exit 1
fi

# Resolve and launch the app directly; monkey unnecessarily stresses low-resource CI emulators.
launcher_activity="$(adb_call shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.vow.app | tr -d '\r' | tail -n 1)"
if [[ "$launcher_activity" != *"/"* ]]; then
  echo "Unable to resolve Vow launcher activity: $launcher_activity" >&2
  exit 1
fi
echo "Launching Vow activity: $launcher_activity"
# Do not use am start -W here: on resource-constrained API 35 emulators its
# fixed wait can expire while system_server is still scheduling the launch.
# Start asynchronously, then verify the actual foreground activity with a
# bounded poll. This avoids treating a slow launch as an app failure.
launch_result="$(adb_call shell am start -n "$launcher_activity")"
printf '%s\n' "$launch_result"
grep -q "Starting:" <<< "$launch_result"

activity_ready=0
for attempt in $(seq 1 45); do
  activity_state="$(adb shell dumpsys activity activities 2>&1 || true)"
  if grep -E 'ResumedActivity|topResumedActivity|mResumedActivity' <<< "$activity_state" | grep -Fq com.vow.app; then
    grep -E 'ResumedActivity|topResumedActivity|mResumedActivity' <<< "$activity_state" | grep -F com.vow.app
    activity_ready=1
    break
  fi
  sleep 2
done
if [[ "$activity_ready" -ne 1 ]]; then
  echo "Vow did not reach the resumed foreground state within 90 seconds" >&2
  adb shell dumpsys activity activities >&2 || true
  exit 1
fi

capture_logcat
if grep -A 8 -E 'FATAL EXCEPTION|Fatal signal' "$LOG_FILE" | grep -F com.vow.app; then
  echo "Vow crashed on Android Emulator" >&2
  exit 1
fi
