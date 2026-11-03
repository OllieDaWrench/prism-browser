#!/usr/bin/env bash
# Build the downloadable desktop bundles attached to a GitHub release.
#
#   ./scripts/package.sh [--platform macos|windows|source] [--runtime DIR] [--deps] [outdir]
#
# Produces, in <outdir> (default: dist):
#   Prism-macOS.zip    Prism/ + Open Prism.command
#   Prism-Windows.zip  Prism/ + Open Prism.bat
#
# The zip stays small (under a megabyte) on purpose: prism-browser.vercel.app
# serves it itself, and a Vercel function cannot send a response body bigger
# than 4.5 MB. On first launch the launcher unpacks a portable Node runtime into
# ./runtime — a plain download, no installer, so no administrator password.
#
# `--deps` vendors node_modules, so the first launch only needs the runtime and
# not npm. `--runtime DIR` is for offline bundles and testing: it copies an
# already-downloaded portable runtime in instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLATFORM=""
RUNTIME=""
WITH_DEPS=0
OUT_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:?--platform needs a value}"; shift 2 ;;
    --runtime) RUNTIME="${2:?--runtime needs a directory}"; shift 2 ;;
    --deps) WITH_DEPS=1; shift ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) OUT_ARG="$1"; shift ;;
  esac
done

mkdir -p "${OUT_ARG:-$ROOT/dist}"
OUT="$(cd "${OUT_ARG:-$ROOT/dist}" && pwd)"
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
  private
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
rm -rf "$STAGE/scripts/__pycache__" "$STAGE/dist" "$STAGE/node_modules"

# ---------------------------------------------------------------- runtime
# Copy a portable Node into the bundle as ./runtime. Layouts supported:
#   runtime/bin/node      (the macOS/linux tarball layout)
#   runtime/node[.exe]    (a flat directory, used by the Windows build)
# The directory may hold one runtime (bin/node, node, node.exe) or several,
# one per architecture (mac-arm64/bin/node, mac-x64/bin/node) so a single macOS
# download works on Intel and Apple Silicon alike.
if [ -n "$RUNTIME" ]; then
  found=""
  [ -x "$RUNTIME/bin/node" ] && found="$RUNTIME/bin/node"
  [ -z "$found" ] && [ -x "$RUNTIME/node" ] && found="$RUNTIME/node"
  [ -z "$found" ] && [ -x "$RUNTIME/node.exe" ] && found="$RUNTIME/node.exe"
  if [ -z "$found" ]; then
    for candidate in "$RUNTIME"/*/bin/node; do
      [ -x "$candidate" ] && found="$candidate" && break
    done
  fi
  [ -n "$found" ] || {
    echo "error: --runtime $RUNTIME does not contain a node binary" >&2
    exit 1
  }
  mkdir -p "$STAGE/runtime"
  cp -R "$RUNTIME"/. "$STAGE/runtime/"
  rm -rf "$STAGE/runtime/npm" "$STAGE/runtime/npx" "$STAGE/runtime/corepack" 2>/dev/null || true
fi

# ---------------------------------------------------------------- dependencies
# Vendored so the first launch needs no npm and no network.
if [ "$WITH_DEPS" = "1" ]; then
  ( cd "$ROOT" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || {
    echo "error: npm ci failed while vendoring dependencies" >&2
    exit 1
  }
  cp -R "$ROOT/node_modules" "$STAGE/node_modules"
fi

# ---------------------------------------------------------------- launchers
cp "$ROOT/Open Prism.command" "$STAGE/" && chmod +x "$STAGE/Open Prism.command"
cp "$ROOT/Open Prism.bat" "$STAGE/"

cat > "$STAGE/START HERE.txt" <<'TXT'
Prism
=====

No installer, no admin rights, nothing installed on this computer.

macOS: the easiest route is one line in Terminal (Spotlight -> "Terminal"):

    curl -fsSL https://prism-browser.vercel.app/install.sh | bash

That installs Prism to ~/Prism and puts "Prism" on your Desktop, which opens on
a plain double-click — no "cannot be verified" warning. Details in step 2.

Prism unpacks its own copy of Node.js (the engine it runs on) into this folder
the first time you start it. That is an ordinary download, roughly 50 MB, and it
never asks for an administrator password. Because of it the zip you downloaded
is small — Prism serves the zip itself rather than sending you to a website.

1. Unzip this folder somewhere you can write to — Desktop or Documents is
   ideal. (Program Files and /Applications are often read-only for normal
   users; Prism does not need to be there.)

2. Start Prism:
   Windows:  double-click "Open Prism.bat"
   macOS:    paste this into Terminal (Spotlight -> "Terminal"):

               curl -fsSL https://prism-browser.vercel.app/install.sh | bash

             It installs Prism to ~/Prism, keeps your downloaded engine across
             upgrades, and adds "Prism" to your Desktop — double-click that from
             then on. No administrator password, and no "cannot be verified"
             warning: Terminal downloads are never quarantined the way browser
             ones are.

             Prefer this folder? Double-click "Open Prism.command" instead, and
             use right-click -> Open the first time (that is Gatekeeper, not an
             admin prompt).

   Prism's own browser window opens at http://localhost:3000.
   The first start takes a moment while it unpacks its engine.

3. Use Prism there. Leave the engine on "Auto": pages that need a real
   browser (ChatGPT, Reddit, Spotify, Twitch, Cloudflare-protected sites)
   open in Live mode, which drives the Chrome or Edge already on this
   computer. If a site asks you to prove you are human, click the checkbox.

Stopping it: close the launcher window (Windows: the "Prism server" window).
Removing it: delete this folder. Nothing was written anywhere else.
TXT

# ---------------------------------------------------------------- bundles
cd "$OUT"

build() {
  local asset="$1" need_launcher="$2"
  [ -e "$STAGE/$need_launcher" ] || { echo "error: missing $need_launcher" >&2; exit 1; }
  rm -f "$asset"
  zip -q -r -X "$asset" Prism -x '*.DS_Store' -x '*/__pycache__/*'
  printf '  %-22s %s\n' "$asset" "$(du -h "$asset" | cut -f1)"
}

echo "built:"
case "$PLATFORM" in
  macos) build Prism-macOS.zip "Open Prism.command" ;;
  windows) build Prism-Windows.zip "Open Prism.bat" ;;
  source)
    rm -f Prism-Source.zip
    zip -q -r -X Prism-Source.zip Prism -x '*.DS_Store'
    printf '  %-22s %s\n' "Prism-Source.zip" "$(du -h Prism-Source.zip | cut -f1)" ;;
  *)
    [ -n "$PLATFORM" ] && { echo "error: unknown --platform $PLATFORM" >&2; exit 1; }
    build Prism-macOS.zip "Open Prism.command"
    build Prism-Windows.zip "Open Prism.bat" ;;
esac
