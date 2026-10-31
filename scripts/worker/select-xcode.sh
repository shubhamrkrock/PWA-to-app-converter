#!/usr/bin/env bash
# Selects the newest installed Xcode of the pinned major version (TOOLCHAIN.xcode).
set -euo pipefail
MAJOR="${G2A_XCODE_MAJOR:-26}"
XCODE="$(ls -d /Applications/Xcode_${MAJOR}*.app 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$XCODE" ]; then
  echo "No Xcode $MAJOR on this runner image" >&2
  ls -d /Applications/Xcode*.app >&2 || true
  exit 1
fi
sudo xcode-select -s "$XCODE/Contents/Developer"
xcodebuild -version
