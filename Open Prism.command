#!/bin/bash
# Prism launcher for macOS. Double-click this file in Finder.
# The first time, macOS may block it: right-click -> Open, or run
#   chmod +x "Open Prism.command"
# in Terminal once.

cd "$(dirname "$0")" || exit 1

echo "Prism"
echo "-----"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Prism needs Node.js 22 or newer, which is not installed yet."
  echo
  echo "  1. Download it from https://nodejs.org (choose the macOS installer)"
  echo "  2. Install it, then double-click this file again."
  echo
  read -r -p "Press return to open the download page… " _
  open "https://nodejs.org/en/download" 2>/dev/null
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo
  echo "Prism needs Node.js 22 or newer; this Mac has $(node -v)."
  echo "Install the current version from https://nodejs.org and try again."
  echo
  read -r -p "Press return to close… " _
  exit 1
fi

if [ ! -d "node_modules/express" ]; then
  echo "Installing Prism's dependencies (one time)…"
  if ! npm install --no-audit --no-fund; then
    echo
    echo "npm install failed. Check your internet connection and try again."
    read -r -p "Press return to close… " _
    exit 1
  fi
fi

PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

# Reuse a running Prism instead of starting a second copy.
if curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1; then
  echo "Prism is already running — opening $URL"
  open "$URL"
  exit 0
fi

echo "Starting Prism on $URL"
node server.js &
PRISM_PID=$!

# Close Prism when this window is closed.
trap 'echo; echo "Stopping Prism…"; kill "$PRISM_PID" 2>/dev/null; exit 0' INT TERM HUP EXIT

for _ in $(seq 1 40); do
  if curl -fsS -m 1 "$URL/healthz" >/dev/null 2>&1; then
    open "$URL"
    break
  fi
  sleep 0.25
done

echo
echo "Prism is running. Keep this window open; close it (or press Ctrl-C) to stop."
wait "$PRISM_PID"
