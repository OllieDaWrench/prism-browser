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
#   PRISM_NUMBER=482913 PRISM_PASSWORD=...   answer the sign-in prompt without typing

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

# ------------------------------------------------------------------ sign in
# The site is private while it is under construction: the bundle is only handed
# to an account. The password is typed here and exchanged for a short-lived
# token, so it never appears in a URL, a log or the shell history.
ask_details() {
  if [ -n "\${PRISM_NUMBER:-}" ] && [ -n "\${PRISM_PASSWORD:-}" ]; then
    return 0
  fi

  if [ ! -r /dev/tty ]; then
    printf 'Prism: this install needs a six-digit number and a password.\\n' >&2
    printf 'Run it in a terminal, or set PRISM_NUMBER and PRISM_PASSWORD.\\n' >&2
    exit 1
  fi

  printf '\\nPrism is private right now. Sign in with the number and password you were given.\\n\\n' > /dev/tty
  while [ -z "\${PRISM_NUMBER:-}" ]; do
    printf 'Six-digit number: ' > /dev/tty
    read -r PRISM_NUMBER < /dev/tty || exit 1
  done
  while [ -z "\${PRISM_PASSWORD:-}" ]; do
    printf 'Password: ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    read -r PRISM_PASSWORD < /dev/tty || { stty echo < /dev/tty 2>/dev/null || true; exit 1; }
    stty echo < /dev/tty 2>/dev/null || true
    printf '\\n' > /dev/tty
  done
  return 0
}

get_token() {
  local response token
  # Form-encoded, so a password with spaces, quotes or symbols needs no escaping.
  response="$(curl -fsS -m 20 -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "number=$PRISM_NUMBER" \
    --data-urlencode "password=$PRISM_PASSWORD" \
    "$ORIGIN/api/auth/token" 2>/dev/null)" || response=""

  token="$(printf '%s' "$response" | tr -d ' ' | sed 's/.*"token":"//; s/".*//')"
  case "$token" in
    ""|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s' "$token"
}

# A copy with no PRISM_AUTH_SECRET is not gated; only ask when the site says it
# is. The download itself stays the real guard either way.
if curl -fsS -m 15 "$ORIGIN/api/auth/status" 2>/dev/null | grep -q '"configured":true'; then
  say "Signing in..."
  ask_details
  TOKEN="$(get_token)" || die "That number and password were not accepted. Check them, then run this again."
  BUNDLE_URL="$BUNDLE_URL?token=$TOKEN"
fi

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

# Keep the browser profile too: the cookies in there (including the ones sites
# hand out after a bot check) are what stop every site challenging you again.
if [ -d "$DEST/.chrome-profile" ]; then
  mv "$DEST/.chrome-profile" "$APP/.chrome-profile"
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
