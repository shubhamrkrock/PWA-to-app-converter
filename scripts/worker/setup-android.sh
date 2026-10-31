#!/usr/bin/env bash
# Installs the pinned Android SDK parts before any untrusted code runs, so Gradle never needs to
# write into the SDK (the sandbox user can only read it).
set -euo pipefail
BUILD_TOOLS="${G2A_BUILD_TOOLS:-36.0.0}"
PLATFORM="${G2A_ANDROID_PLATFORM:-android-36}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKMANAGER" --licenses >/dev/null || true
"$SDKMANAGER" --install "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "platform-tools" >/dev/null
{
  echo "ANDROID_HOME=$SDK"
  echo "ANDROID_SDK_ROOT=$SDK"
  echo "G2A_BUILD_TOOLS=$BUILD_TOOLS"
} >> "${GITHUB_ENV:-/dev/null}"
echo "Android SDK: $PLATFORM, build-tools $BUILD_TOOLS"
