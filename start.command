#!/usr/bin/env bash
# Scholar Dashboard — one-click launcher (macOS / Linux).
# Double-click in Finder, or run from a terminal: ./start.command
#
# On first run this script:
#   1. Creates a Python venv in .venv/ and installs requirements
#   2. Seeds data/ from data.example/ if there is no data yet
#   3. Starts the Flask server and opens http://localhost:5057 in the
#      default browser
#
# Closing the terminal window (or Ctrl-C) stops the server. Run
# stop.command afterwards to make sure nothing is left listening.

set -e
cd "$(dirname "$0")"

PORT="${PORT:-5057}"
URL="http://localhost:${PORT}"

echo "── Scholar Dashboard ──────────────────────────────────────────────"
echo "Project: $(pwd)"
echo

# 1. Python — needs python3 on PATH.
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 isn't on your PATH."
  echo "Install Python 3 from https://www.python.org/downloads/  and try again."
  echo
  read -n 1 -s -r -p "Press any key to close…"
  exit 1
fi

# 2. Bootstrap the venv on first run.
if [ ! -d ".venv" ]; then
  echo "First run — creating Python venv and installing dependencies…"
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  python -m pip install --quiet --upgrade pip
  python -m pip install --quiet -r requirements.txt
  echo "  done."
  echo
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# 3. Seed data/ from data.example/ on first run.
if { [ ! -d "data" ] || [ -z "$(ls -A data 2>/dev/null || true)" ]; } && [ -d "data.example" ]; then
  echo "Seeding data/ from data.example/…"
  mkdir -p data
  cp -R data.example/* data/
  echo "  done. Use the Data editor (or hand-edit data/*.md) to add real staff."
  echo
fi

# 4. Open the browser shortly after the server starts.
(
  # Wait up to ~15s for the port to come up before opening the browser.
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "${URL}/api/version" 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then open "${URL}";
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open "${URL}";
      fi
      exit 0
    fi
    sleep 0.5
  done
) &

# 5. Start Flask in the foreground so logs are visible. Ctrl-C stops it.
echo "Starting server at ${URL}"
echo "Press Ctrl-C in this window to stop (or just close it)."
echo
exec python app.py
