#!/bin/bash
# Prism launcher for macOS. Double-click this file in Finder.
#
# Needs no administrator rights and installs nothing outside this folder:
#   * uses the portable Node runtime shipped inside the bundle, else a system
#     Node 22+ if there is one, else offers the portable download
#   * dependencies are vendored in node_modules/, so nothing is installed
#   * listens on an unprivileged port (3000 and up) and stores no state outside
#     this folder or the temp directory
#
# First launch after downloading: macOS may refuse the file once
# ("cannot be opened because it is from an unidentified developer").
# Right-click -> Open -> Open. That is a Gatekeeper prompt, not an admin one.

cd "$(dirname "$0")" || exit 1
BUNDLE_DIR="$(pwd)"

echo "Prism"
echo "-----"

# ---------------------------------------------------------------- node runtime
# Nothing is installed system-wide and nothing needs an administrator. If the
# bundle has no runtime yet (the download stays small so it can be served from
# prism-browser.vercel.app directly), a portable Node is unpacked into
# ./runtime on first launch. Everything lives inside this folder.
NODE_VERSION="${PRISM_NODE_VERSION:-22.20.0}"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) RUNTIME_ARCH="mac-arm64"; NODE_ARCH="arm64" ;;
  *)     RUNTIME_ARCH="mac-x64";   NODE_ARCH="x64" ;;
esac

node_major() {
  "$1" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

find_node() {
  local candidate
  for candidate in \
    "$BUNDLE_DIR/runtime/bin/node" \
    "$BUNDLE_DIR/runtime/node" \
    "$BUNDLE_DIR/runtime/$RUNTIME_ARCH/bin/node"; do
    if [ -x "$candidate" ]; then
      if [ "$(node_major "$candidate")" -ge 22 ]; then
        echo "$candidate"
        return 0
      fi
    fi
  done
  local system_node
  system_node="$(command -v node 2>/dev/null)"
  if [ -n "$system_node" ] && [ "$(node_major "$system_node")" -ge 22 ]; then
    echo "$system_node"
    return 0
  fi
  return 1
}

download_runtime() {
  local url pattern="$BUNDLE_DIR/runtime/.download"
  local tarball="$pattern/node.tar.gz" unpack="$pattern/unpack"
  url="${PRISM_NODE_URL:-https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz}"

  echo
  echo "Preparing Prism's own copy of Node.js (one time, about 50 MB)."
  echo "It is unpacked into this folder — your administrator is not involved."
  echo

  rm -rf "$pattern"
  mkdir -p "$unpack" || { echo "Cannot write to $BUNDLE_DIR"; return 1; }

  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar -o "$tarball" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$tarball" "$url"
  else
    echo "Neither curl nor wget is available to fetch it automatically."
    return 1
  fi || { echo; echo "Download failed. Check your connection and try again."; rm -rf "$pattern"; return 1; }

  tar -xzf "$tarball" -C "$unpack" 2>/dev/null || {
    echo "Could not unpack the runtime download."
    rm -rf "$pattern"
    return 1
  }

  local extracted
  extracted="$(find "$unpack" -maxdepth 1 -type d -name 'node-v*' | head -1)"
  if [ -z "$extracted" ]; then
    echo "The runtime download was incomplete."
    rm -rf "$pattern"
    return 1
  fi

  chmod -R u+w "$extracted" 2>/dev/null
  rm -rf "$BUNDLE_DIR/runtime/$RUNTIME_ARCH"
  mkdir -p "$BUNDLE_DIR/runtime/$RUNTIME_ARCH"
  # move the pieces of the extracted runtime into place
  for piece in bin lib share include; do
    [ -e "$extracted/$piece" ] && mv "$extracted/$piece" "$BUNDLE_DIR/runtime/$RUNTIME_ARCH/"
  done
  chmod +x "$BUNDLE_DIR/runtime/$RUNTIME_ARCH/bin/node" 2>/dev/null
  rm -rf "$pattern"
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  if download_runtime; then
    NODE_BIN="$(find_node || true)"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  cat <<'MSG'

Prism could not get its Node runtime.

Prism ships without one so the download stays small; it fetches a portable copy
on first launch. That download needs an internet connection.

Already have Node.js 22 or newer? Prism will use it. Otherwise reconnect and run
this launcher again.

MSG
  read -r -p "Press return to close… " _
  exit 1
fi
echo "Using Node $("$NODE_BIN" -v 2>/dev/null) ($NODE_BIN)"

if [ -n "${PRISM_LAUNCHER_CHECK:-}" ]; then
  # used by the release workflow to test the bootstrap without starting a server
  echo "Launcher check passed."
  exit 0
fi

# ---------------------------------------------------------------- dependencies
if [ ! -d "$BUNDLE_DIR/node_modules/express" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "Installing Prism's dependencies (one time)…"
    if ! npm install --no-audit --no-fund; then
      echo
      echo "npm install failed. Check your internet connection and try again."
      read -r -p "Press return to close… " _
      exit 1
    fi
  else
    echo
    echo "This bundle is missing its dependencies and there is no npm to fetch them."
    echo "Download Prism again."
    read -r -p "Press return to close… " _
    exit 1
  fi
fi

# ---------------------------------------------------------------- writability
if [ ! -w "$BUNDLE_DIR" ]; then
  echo
  echo "Note: $(dirname "$BUNDLE_DIR") is not writable by your account."
  echo "Prism can still run, but if anything needs to be written it will fail."
  echo "Moving the folder to Desktop or Documents avoids that — no admin needed."
fi

# ---------------------------------------------------------------- already running?
find_running_prism() {
  local port
  for port in $(seq 3000 3010); do
    if curl -fsS -m 1 "http://localhost:$port/healthz" 2>/dev/null | grep -q '"prism":true'; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

if PORT_FOUND="$(find_running_prism)"; then
  echo "Prism is already running — opening http://localhost:$PORT_FOUND"
  open "http://localhost:$PORT_FOUND"
  exit 0
fi

# ---------------------------------------------------------------- start
echo "Starting Prism…"
PRISM_OPEN=1 "$NODE_BIN" server.js &
PRISM_PID=$!

cleanup() {
  echo
  echo "Stopping Prism…"
  kill "$PRISM_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM HUP

echo
echo "Prism is running. Keep this window open; close it (or press Ctrl-C) to stop."
wait "$PRISM_PID"
