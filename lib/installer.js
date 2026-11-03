"use strict";

/**
 * The macOS installer you run in Terminal.
 *
 * Why this exists: macOS puts a quarantine flag on anything downloaded in a
 * browser, and Gatekeeper then refuses to run it unless the developer has paid
 * Apple for a Developer ID certificate and notarisation. A `.command` file is a
 * shell script, so it cannot be code-signed at all — no amount of packaging
 * makes the double-clicked zip open without that warning.
 *
 * Files written by `curl` carry no quarantine flag. So this one-liner:
 *
 *     curl -fsSL https://prism-browser.vercel.app/install.sh | bash
 *
 * downloads the same bundle, unpacks it into ~/Prism, and leaves a launcher you
 * can double-click from then on. No warning, no password, no Apple account, and
 * nothing installed outside your home folder.
 */

const REPO = "OllieDaWrench/prism-browser";
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest/download/Prism-macOS.zip`;

/** Where the app ends up when the user does not choose. */
const DEFAULT_DIR = "$HOME/Prism";

/**
 * The install script, with `origin` baked in so it fetches the bundle from
 * whichever copy of Prism served it (local app, or the hosted deployment).
 */
function installerScript(origin) {
  const base = String(origin || "https://prism-browser.vercel.app").replace(/\/+$/, "");
  return `#!/bin/bash
# Prism installer — macOS
#
#   curl -fsSL ${base}/install.sh | bash
#
# No administrator password, no Apple Developer account, no Gatekeeper warning:
# the files are fetched by curl, so macOS never marks them as "downloaded from
# the internet". Everything goes into ~/Prism. Delete that folder to remove it.
#
# Options (environment variables):
#   PRISM_INSTALL_DIR=~/Applications/Prism   install somewhere else
#   PRISM_QUIET=1                            less output

set -eu

ORIGIN="${base}"
BUNDLE_URL="\${PRISM_BUNDLE_URL:-$ORIGIN/download/mac}"
FALLBACK_URL="${FALLBACK_URL}"
DEST="\${PRISM_INSTALL_DIR:-$HOME/Prism}"

say() { [ "\${PRISM_QUIET:-0}" = "1" ] || printf '%s\\n' "$*"; }
die() { printf 'Prism: %s\\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) ;;
  *) die "this installer is for macOS; on other systems use the release zip" ;;
esac

# Refuse to work on anything that could delete more than the app folder.
case "$DEST" in
  ""|"/"|"$HOME"|"$HOME/"|"~") die "refusing to install into '$DEST'" ;;
esac
DEST="\${DEST%/}"

command -v curl >/dev/null 2>&1 || die "curl is missing from this Mac"
command -v unzip >/dev/null 2>&1 || die "unzip is missing from this Mac"

WORK="$(mktemp -d "\${TMPDIR:-/tmp}/prism-install.XXXXXX")" || die "could not create a temp folder"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM HUP

say "Prism"
say "-----"
say "Installing into $DEST"

fetch() { # url, destination
  curl -fL --progress-bar --retry 3 --connect-timeout 20 -o "$2" "$1"
}

say "Downloading Prism..."
if ! fetch "$BUNDLE_URL" "$WORK/Prism.zip" 2>/dev/null; then
  say "That copy of Prism did not have the file; trying the release download..."
  fetch "$FALLBACK_URL" "$WORK/Prism.zip" || die "download failed — check your connection and try again"
fi

[ -s "$WORK/Prism.zip" ] || die "the download was empty"
if [ "$(head -c 2 "$WORK/Prism.zip")" != "PK" ]; then
  die "the download was not a zip — the server may be misconfigured"
fi

say "Unpacking..."
mkdir -p "$WORK/unpack"
unzip -q "$WORK/Prism.zip" -d "$WORK/unpack" || die "could not unpack the download"
APP="$(find "$WORK/unpack" -maxdepth 1 -type d -name 'Prism*' | head -1)"
[ -n "$APP" ] || die "the download did not contain Prism"

# Keep the Node runtime across upgrades: it is the big part of a first launch.
if [ -d "$DEST/runtime" ] && [ ! -d "$APP/runtime" ]; then
  say "Keeping the existing Node runtime."
  mv "$DEST/runtime" "$APP/runtime"
fi

say "Installing..."
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$APP" "$DEST"
chmod +x "$DEST/Open Prism.command" 2>/dev/null || true

# Belt and braces: anything that did pick up a quarantine flag gets cleared,
# for this folder only. Harmless when there is nothing to clear.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
fi

# A launcher on the Desktop, because the whole point is a double-click that
# works. This file is created by the script, so it is never quarantined.
if [ -d "$HOME/Desktop" ] && [ -w "$HOME/Desktop" ]; then
  cat > "$HOME/Desktop/Prism.command" <<LAUNCHER
#!/bin/bash
exec "$DEST/Open Prism.command"
LAUNCHER
  chmod +x "$HOME/Desktop/Prism.command"
  say "Added Prism to your Desktop."
fi

say ""
say "Done. Double-click Prism on your Desktop, or:"
say "  $DEST/Open Prism.command"
say ""
say "The first start unpacks Prism's own copy of Node.js (about 50 MB)."
say "To remove Prism: delete $DEST and the Desktop launcher."

if [ "\${PRISM_NO_START:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Start Prism now? [Y/n] '
  read -r answer || answer="n"
  case "$answer" in
    ""|y|Y|yes|YES) exec "$DEST/Open Prism.command" ;;
  esac
fi
`;
}

module.exports = { installerScript, DEFAULT_DIR, FALLBACK_URL, REPO };
