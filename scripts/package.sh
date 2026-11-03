#!/usr/bin/env bash
# Build the downloadable desktop bundles attached to a GitHub release.
#
#   ./scripts/package.sh [outdir]      (default: dist)
#
# Produces, in <outdir>:
#   Prism-macOS.zip     Prism/ + Open Prism.command (executable bit preserved)
#   Prism-Windows.zip   Prism/ + Open Prism.bat
#
# Both contain the same application; only the double-click launcher differs.
# node_modules is deliberately excluded — the launchers run `npm install` on
# first use, so the bundles stay small and platform independent (express is
# pure JavaScript).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve the output directory to an absolute path immediately: the script
# changes into it to build the zips, and a relative path would then be applied
# twice ("dist/dist/Prism-macOS.zip") when reporting results.
mkdir -p "${1:-$ROOT/dist}"
OUT="$(cd "${1:-$ROOT/dist}" && pwd)"
STAGE="$OUT/Prism"

INCLUDE=(
  server.js
  package.json
  package-lock.json
  README.md
  Prism.html
  api
  lib
  public
  scripts
)

rm -rf "$STAGE"
mkdir -p "$STAGE"

for item in "${INCLUDE[@]}"; do
  [ -e "$ROOT/$item" ] || continue
  if [ -d "$ROOT/$item" ]; then
    cp -R "$ROOT/$item" "$STAGE/"
  else
    cp "$ROOT/$item" "$STAGE/"
  fi
done

# keep the bundles small: no test fixtures, no build output
rm -rf "$STAGE/scripts/__pycache__" "$STAGE/dist" "$STAGE/node_modules"

cp "$ROOT/Open Prism.command" "$STAGE/" && chmod +x "$STAGE/Open Prism.command"
cp "$ROOT/Open Prism.bat" "$STAGE/"

# A short readme that is the first thing someone double-clicking sees.
cat > "$STAGE/START HERE.txt" <<'TXT'
Prism
=====

1. Install Node.js 22 or newer (one time):  https://nodejs.org

2. Start Prism:
   - Windows:  double-click "Open Prism.bat"
   - macOS:    double-click "Open Prism.command"
               (first time only: right-click > Open, or in Terminal run
                chmod +x "Open Prism.command")

   Your browser opens at http://localhost:3000 — use Prism there.

3. In Prism, leave the engine on "Auto". Pages that need a real browser
   (ChatGPT, Reddit, Spotify, Twitch, Cloudflare-protected sites) open in
   Live mode, which drives the Chrome or Edge already installed on this
   computer. If a site asks you to prove you are human, click the checkbox.

Stopping it: close the launcher window (Windows: close the "Prism server"
window). Nothing is installed system-wide; delete the folder to remove it.
TXT

cd "$OUT"
rm -f Prism-macOS.zip Prism-Windows.zip

# macOS bundle: zip keeps the unix mode bits, so the .command stays executable
zip -q -r -X Prism-macOS.zip Prism -x '*.DS_Store'
# Windows bundle: same tree, launcher is the .bat; the .command is harmless
zip -q -r -X Prism-Windows.zip Prism -x '*.DS_Store'

echo "built:"
ls -lh "$OUT"/Prism-macOS.zip "$OUT"/Prism-Windows.zip | awk '{print "  " $9 "  " $5}'
