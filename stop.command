#!/usr/bin/env bash
# Scholar Dashboard — stop any server still listening on the port.
# Double-click in Finder, or run from a terminal: ./stop.command

set -e
cd "$(dirname "$0")"

PORT="${PORT:-5057}"

echo "── Scholar Dashboard ──────────────────────────────────────────────"
echo "Stopping any process listening on port ${PORT}…"

PIDS=$(lsof -ti ":${PORT}" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  sleep 0.5
  # If anything is still alive, force-kill.
  STILL=$(lsof -ti ":${PORT}" 2>/dev/null || true)
  if [ -n "$STILL" ]; then
    # shellcheck disable=SC2086
    kill -9 $STILL 2>/dev/null || true
  fi
  echo "  killed: ${PIDS}"
else
  echo "  (nothing running)"
fi

echo
read -n 1 -s -r -p "Press any key to close…"
echo
