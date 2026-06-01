# PyInstaller spec — produces a self-contained Scholar Dashboard.app
# bundling Python, Flask, BeautifulSoup, requests, and the frontend
# assets. End users download a .zip with this .app, unzip, double-click.
# No Python install needed on the target machine.
#
# Build:  pyinstaller --clean --noconfirm scholar-dashboard.spec
# Output: dist/Scholar Dashboard.app
#
# Run from source still works unchanged — see app.py path handling.

from pathlib import Path

block_cipher = None
HERE = Path(SPECPATH)

# Static files served by Flask + the data.example seed (copied to the
# user data dir on first launch). Tuples are (source, dest-in-bundle).
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
    console=False,            # GUI app — no terminal window
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

app = BUNDLE(
    coll,
    name="Scholar Dashboard.app",
    icon=None,
    bundle_identifier="com.scholar-dashboard.launcher",
    version="0.2.46",
    info_plist={
        "CFBundleName": "Scholar Dashboard",
        "CFBundleDisplayName": "Scholar Dashboard",
        "CFBundleShortVersionString": "0.2.46",
        "CFBundleVersion": "0.2.46",
        "LSMinimumSystemVersion": "10.13",
        "NSHighResolutionCapable": True,
        # We want a Dock icon + window while the app is running so the
        # user can Quit via the menu bar. LSUIElement=False means the
        # app shows up normally in the Dock.
        "LSUIElement": False,
        "LSBackgroundOnly": False,
    },
)
