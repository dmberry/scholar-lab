# PyInstaller spec — produces a self-contained Scholar Dashboard build that
# bundles Python, Flask, BeautifulSoup, requests, and the frontend assets, so
# end users need no Python install on the target machine.
#
# Cross-platform:
#   • macOS   → dist/Scholar Dashboard.app   (BUNDLE)
#   • Windows → dist/scholar-dashboard/scholar-dashboard.exe   (onedir COLLECT)
#   • Linux   → dist/scholar-dashboard/scholar-dashboard        (onedir COLLECT)
#
# Build:  pyinstaller --clean --noconfirm scholar-dashboard.spec
# (use build.sh on macOS, build.ps1 on Windows, build-linux.sh on Linux)
#
# Running from source still works unchanged — see app.py's path handling.

import re
import sys
from pathlib import Path

block_cipher = None
HERE = Path(SPECPATH)
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"

# Single source of truth for the version — read it from app.py so the bundle
# metadata never drifts from __version__.
_app_src = (HERE / "app.py").read_text(encoding="utf-8")
_m = re.search(r'__version__\s*=\s*"([^"]+)"', _app_src)
VERSION = _m.group(1) if _m else "0.0.0"

# Static files served by Flask + the data.example seed (copied to the user
# data dir on first launch). Tuples are (source, dest-in-bundle).
datas = [
    (str(HERE / "index.html"),  "."),
    (str(HERE / "style.css"),   "."),
    (str(HERE / "app.js"),      "."),
    (str(HERE / "data.example"), "data.example"),
]

a = Analysis(
    [str(HERE / "app.py")],
    pathex=[str(HERE)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="scholar-dashboard",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # GUI app on macOS/Windows (no terminal window); on Linux keep a console
    # so logs are visible (it's launched from a wrapper/.desktop anyway).
    console=(not IS_MAC and not IS_WIN),
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="scholar-dashboard",
)

# macOS only — wrap the COLLECT output in a double-clickable .app bundle.
if IS_MAC:
    app = BUNDLE(
        coll,
        name="Scholar Dashboard.app",
        icon=None,
        bundle_identifier="com.scholar-dashboard.launcher",
        version=VERSION,
        info_plist={
            "CFBundleName": "Scholar Dashboard",
            "CFBundleDisplayName": "Scholar Dashboard",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "LSMinimumSystemVersion": "10.13",
            "NSHighResolutionCapable": True,
            # Show a normal Dock icon + window so the user can Quit via the
            # in-app menu bar.
            "LSUIElement": False,
            "LSBackgroundOnly": False,
        },
    )
