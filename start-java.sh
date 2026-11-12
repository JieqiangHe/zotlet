#!/bin/bash
# Start zotlet with the Java already installed on this computer (11 or newer) and open it in the browser.
# The server output stays in this window. Press Ctrl+C to stop zotlet.

cd "$(dirname "$0")" || exit 1

pause() {
  # Keep the window open so messages can be read (only when run interactively).
  if [ -t 0 ]; then
    echo
    read -r -p "$1" _
  fi
}

find_java() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then echo "$JAVA_HOME/bin/java"; return 0; fi
  # On macOS /usr/bin/java is only a stub when no JDK is installed; java_home finds a real one.
  if [ -x /usr/libexec/java_home ] && home="$(/usr/libexec/java_home 2>/dev/null)" && [ -x "$home/bin/java" ]; then echo "$home/bin/java"; return 0; fi
  if command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1; then command -v java; return 0; fi
  # Double-clicked launchers do not always load the shell profile; try the usual install locations.
  for java in /opt/homebrew/opt/openjdk/bin/java /usr/local/opt/openjdk/bin/java "$HOME"/.sdkman/candidates/java/current/bin/java \
    "$HOME"/micromamba/envs/*/bin/java "$HOME"/.local/share/mamba/envs/*/bin/java "$HOME"/miniforge3/bin/java "$HOME"/miniconda3/bin/java; do
    if [ -x "$java" ]; then echo "$java"; return 0; fi
  done
  return 1
}

JAVA="$(find_java)"
if [ -z "$JAVA" ]; then
  echo "zotlet needs Java 11 or newer, but 'java' was not found."
  echo "Install a JDK (for example: brew install openjdk), or set JAVA_HOME, then start this file again."
  pause "Press Enter to close this window…"
  exit 1
fi

if ! "$JAVA" -cp lib/zotlet.jar zotlet.Main help >/dev/null 2>&1; then
  echo "zotlet needs Java 11 or newer; this one does not run it:"
  "$JAVA" -version
  pause "Press Enter to close this window…"
  exit 1
fi

echo "Starting zotlet with $JAVA"
"$JAVA" -jar lib/zotlet.jar web --open "$@"
status=$?
pause "zotlet has stopped. Press Enter to close this window…"
exit $status
