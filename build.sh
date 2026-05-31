#!/usr/bin/env bash
# Build a standalone "Scholar Dashboard.app" from this source tree using
# PyInstaller. End users get a single zip they can double-click — no
# Python install required on the target machine.
#
# Usage:
#   ./build.sh              # builds dist/Scholar Dashboard.app + dist/Scholar-Dashboard-<version>-macos.zip
#   ./build.sh --no-zip     # skip the zip step (faster iteration)
#
# Requires a venv with PyInstaller installed; we create one on demand.

set -euo pipefail
cd "$(dirname "$0")"

NO_ZIP=0
for arg in "$@"; do
  case "$arg" in
    --no-zip) NO_ZIP=1 ;;
  esac
done

VERSION="$(grep '__version__' app.py | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
echo "→ building Scholar Dashboard $VERSION"

# Use a separate build venv so PyInstaller's deps don't pollute the
# user's regular .venv.
BUILD_VENV=".venv-build"
if [ ! -d "$BUILD_VENV" ]; then
  echo "→ creating $BUILD_VENV"
  python3 -m venv "$BUILD_VENV"
fi
# shellcheck disable=SC1091
source "$BUILD_VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
pip install --quiet pyinstaller

# Wipe previous build artifacts so we never ship stale state.
rm -rf build dist

pyinstaller --clean --noconfirm scholar-dashboard.spec

APP_PATH="dist/Scholar Dashboard.app"
if [ ! -d "$APP_PATH" ]; then
  echo "✗ build failed — $APP_PATH not produced"
  exit 1
fi

echo "→ built $APP_PATH"

if [ "$NO_ZIP" -eq 0 ]; then
  ZIP_NAME="Scholar-Dashboard-${VERSION}-macos.zip"
  ZIP_PATH="dist/$ZIP_NAME"
  rm -f "$ZIP_PATH"
  # Zip with `ditto` to preserve macOS bundle metadata (resource forks,
  # code-sign info, extended attributes). `zip` mangles these and the
  # resulting .app can fail to launch on the target machine.
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
  echo "→ packaged $ZIP_PATH"
  echo
  echo "Upload to GitHub Releases:"
  echo "  gh release create v$VERSION \"$ZIP_PATH\" --title \"v$VERSION\" --notes \"…\""
fi
