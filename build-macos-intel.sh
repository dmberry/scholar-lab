#!/usr/bin/env bash
# Build the macOS *Intel* (x86_64) "Scholar Dashboard.app" locally, for when
# GitHub's hosted macos-13 (Intel) runner queue is unusable.
#
# PyInstaller can't cross-compile, so we build under an x86_64 CPython that
# runs through Rosetta 2. On an Apple Silicon Mac this produces a genuine
# x86_64 app; on an Intel Mac it's native. Requires `uv` (for the x86_64
# Python) and, on Apple Silicon, Rosetta 2 (`softwareupdate --install-rosetta`).
#
# Usage:
#   ./build-macos-intel.sh             # → dist/Scholar-Dashboard-<version>-macos-intel.zip
#   ./build-macos-intel.sh --upload    # also upload to the matching GitHub release (gh)

set -euo pipefail
cd "$(dirname "$0")"

UPLOAD=0
for arg in "$@"; do case "$arg" in --upload) UPLOAD=1 ;; esac; done

VERSION="$(grep '__version__' app.py | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
echo "→ building Scholar Dashboard $VERSION (macOS Intel / x86_64)"

# x86_64 CPython 3.12 via uv (downloaded once, cached). It's an x86_64-only
# build, so it always runs under Rosetta on Apple Silicon — guaranteeing
# x86_64 output.
command -v uv >/dev/null || { echo "✗ uv not found — install from https://astral.sh/uv"; exit 1; }
uv python install cpython-3.12-macos-x86_64 >/dev/null 2>&1 || true
PYX="$(uv python find cpython-3.12-macos-x86_64 2>/dev/null || true)"
[ -n "$PYX" ] || PYX="$HOME/.local/share/uv/python/cpython-3.12-macos-x86_64-none/bin/python3.12"
[ -x "$PYX" ] || { echo "✗ x86_64 python not found at $PYX"; exit 1; }
[ "$("$PYX" -c 'import platform;print(platform.machine())')" = "x86_64" ] \
  || { echo "✗ interpreter is not x86_64"; exit 1; }

BUILD_VENV=".venv-build-x86"
[ -d "$BUILD_VENV" ] || "$PYX" -m venv "$BUILD_VENV"
"$BUILD_VENV/bin/pip" install --quiet --upgrade pip
"$BUILD_VENV/bin/pip" install --quiet -r requirements.txt pyinstaller

rm -rf build dist
"$BUILD_VENV/bin/pyinstaller" --clean --noconfirm scholar-dashboard.spec

APP="dist/Scholar Dashboard.app"
[ -d "$APP" ] || { echo "✗ build failed — $APP not produced"; exit 1; }
ARCH="$(lipo -archs "$APP/Contents/MacOS/scholar-dashboard" 2>/dev/null || echo '?')"
echo "→ built $APP (arch: $ARCH)"
[ "$ARCH" = "x86_64" ] || { echo "✗ expected x86_64, got '$ARCH'"; exit 1; }

ZIP="dist/Scholar-Dashboard-${VERSION}-macos-intel.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "→ packaged $ZIP"

if [ "$UPLOAD" -eq 1 ]; then
  echo "→ uploading to release v$VERSION"
  gh release upload "v$VERSION" "$ZIP" --clobber
  echo "→ uploaded"
fi
