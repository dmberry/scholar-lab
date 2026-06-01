# Build a standalone Scholar Dashboard for Windows with PyInstaller.
#
# Produces:
#   dist\scholar-dashboard\scholar-dashboard.exe        (the app, onedir)
#   dist\Scholar-Dashboard-<version>-windows.zip        (portable zip)
#   dist\Scholar-Dashboard-<version>-setup.exe          (if Inno Setup is installed)
#
# Usage (PowerShell):
#   .\build.ps1
#   .\build.ps1 -NoZip
#
# Requires Python 3 on PATH. A separate build venv is created on demand so
# PyInstaller's deps don't pollute your dev environment.

param([switch]$NoZip)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Version straight from app.py.
$verLine = Select-String -Path "app.py" -Pattern '__version__\s*=\s*"([^"]+)"' | Select-Object -First 1
$VERSION = $verLine.Matches[0].Groups[1].Value
Write-Host "-> building Scholar Dashboard $VERSION (windows)"

$BUILD_VENV = ".venv-build"
if (-not (Test-Path $BUILD_VENV)) {
    Write-Host "-> creating $BUILD_VENV"
    python -m venv $BUILD_VENV
}
$py = Join-Path $BUILD_VENV "Scripts\python.exe"
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet -r requirements.txt
& $py -m pip install --quiet pyinstaller

# Wipe previous artifacts.
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue

& $py -m PyInstaller --clean --noconfirm scholar-dashboard.spec

$appDir = "dist\scholar-dashboard"
$exe = Join-Path $appDir "scholar-dashboard.exe"
if (-not (Test-Path $exe)) {
    Write-Error "build failed - $exe not produced"
    exit 1
}
Write-Host "-> built $appDir"

if (-not $NoZip) {
    $zip = "dist\Scholar-Dashboard-$VERSION-windows.zip"
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    Compress-Archive -Path $appDir -DestinationPath $zip
    Write-Host "-> packaged $zip"

    # Optional: a real Setup.exe via Inno Setup, if its compiler is present.
    $iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($iscc) {
        Write-Host "-> Inno Setup found; building installer"
        & $iscc.Source "/DMyAppVersion=$VERSION" "installer\scholar-dashboard.iss"
        Write-Host "-> installer written to dist\"
    } else {
        Write-Host "   (Inno Setup 'iscc.exe' not on PATH - skipping the .exe installer; the zip is portable)"
    }

    Write-Host ""
    Write-Host "Upload to GitHub Releases:"
    Write-Host "  gh release create v$VERSION `"$zip`" --title `"v$VERSION`" --notes `"...`""
}
