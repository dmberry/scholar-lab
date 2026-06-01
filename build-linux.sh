#!/usr/bin/env bash
# Build a standalone Scholar Dashboard for Linux with PyInstaller.
#
# Produces:
#   dist/scholar-dashboard/scholar-dashboard            (the app, onedir)
#   dist/Scholar-Dashboard-<version>-linux.tar.gz       (portable tarball w/ launcher + .desktop)
#
# Usage:
#   ./build-linux.sh
#   ./build-linux.sh --no-tar
#
# Requires python3 + python3-venv. A separate build venv is created on demand.

set -euo pipefail
cd "$(dirname "$0")"

NO_TAR=0
for arg in "$@"; do
  case "$arg" in
    --no-tar) NO_TAR=1 ;;
  esac
done

VERSION="$(grep '__version__' app.py | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
echo "→ building Scholar Dashboard $VERSION (linux)"

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

rm -rf build dist
pyinstaller --clean --noconfirm scholar-dashboard.spec

APP_DIR="dist/scholar-dashboard"
if [ ! -x "$APP_DIR/scholar-dashboard" ]; then
  echo "✗ build failed — $APP_DIR/scholar-dashboard not produced"
  exit 1
fi
echo "→ built $APP_DIR"

# A friendly run script + .desktop entry so users get a launcher, not just a
# bare binary. Both go inside the tarball next to the app folder.
cat > "dist/scholar-dashboard/run.sh" <<'EOF'
#!/usr/bin/env bash
# Launch Scholar Dashboard and open it in the default browser.
cd "$(dirname "$0")"
exec ./scholar-dashboard
EOF
chmod +x "dist/scholar-dashboard/run.sh"

cat > "dist/scholar-dashboard.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scholar Dashboard
Comment=Google Scholar metrics + REF 2029 readiness
Exec=scholar-dashboard
Terminal=false
Categories=Office;Education;
EOF

if [ "$NO_TAR" -eq 0 ]; then
  TAR_NAME="Scholar-Dashboard-${VERSION}-linux.tar.gz"
  ( cd dist && tar -czf "$TAR_NAME" scholar-dashboard scholar-dashboard.desktop )
  echo "→ packaged dist/$TAR_NAME"
  echo
  echo "Upload to GitHub Releases:"
  echo "  gh release create v$VERSION \"dist/$TAR_NAME\" --title \"v$VERSION\" --notes \"…\""
fi
