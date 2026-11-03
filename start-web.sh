#!/bin/bash
# Start zotlet with the Node.js already installed on this computer and open it in the browser.
# The server output stays in this window. Press Ctrl+C to stop zotlet.

cd "$(dirname "$0")" || exit 1

pause() {
  # Keep the window open so messages can be read (only when run interactively).
  if [ -t 0 ]; then
    echo
    read -r -p "$1" _
  fi
}

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  # Double-clicked launchers do not always load the shell profile; try the usual install locations.
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin" "$HOME/.asdf/shims" /opt/local/bin; do
    if [ -x "$dir/node" ]; then echo "$dir/node"; return 0; fi
  done
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
    if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  fi
  return 1
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo "zotlet needs Node.js 18.17 or newer, but 'node' was not found."
  echo "Install it from https://nodejs.org (or: brew install node), then double-click this file again."
  pause "Press Enter to close this window…"
  exit 1
fi

if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo "zotlet needs Node.js 18.17 or newer; found $("$NODE" --version) at $NODE."
  pause "Press Enter to close this window…"
  exit 1
fi

if [ ! -f node_modules/citeproc/package.json ]; then
  echo "Installing the citeproc dependency (one time)…"
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="npm"
  if ! PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund; then
    echo "Could not install dependencies. Check your internet connection and try again."
    pause "Press Enter to close this window…"
    exit 1
  fi
fi

echo "Starting zotlet with $("$NODE" --version) ($NODE)"
"$NODE" zotlet.js web --open "$@"
status=$?
pause "zotlet has stopped. Press Enter to close this window…"
exit $status
