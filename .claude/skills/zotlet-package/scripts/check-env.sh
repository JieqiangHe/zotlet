#!/bin/sh
# Check (and say how to get) what building, testing and packaging zotlet needs.
# Usage: sh .claude/skills/zotlet-package/scripts/check-env.sh
ok=0
say() { printf '%-10s %s\n' "$1" "$2"; }
need() { # name, command, hint
  if command -v "$2" >/dev/null 2>&1; then say "$1" "ok ($(command -v "$2"))"; else say "$1" "MISSING — $3"; ok=1; fi
}
need java java "a JDK 11+: macOS 'brew install openjdk' or micromamba 'openjdk'; Linux 'apt install openjdk-21-jdk'"
need javac javac "comes with the JDK (a JRE alone cannot build)"
need jar jar "comes with the JDK"
need curl curl "used once to download Rhino and citeproc-js"
need zip zip "macOS has it; Linux 'apt install zip'"
need unzip unzip "macOS has it; Linux 'apt install unzip'"
need node node "Node 18+ runs the tests only (the app does not need it): nodejs.org, 'brew install node'"
if command -v javac >/dev/null 2>&1; then
  v=$(javac -version 2>&1 | sed -n 's/^javac \([0-9]*\).*/\1/p' | head -1)
  if [ -n "$v" ] && [ "$v" -lt 11 ]; then say javac "TOO OLD (javac $v) — need 11 or newer"; ok=1; fi
fi
if command -v node >/dev/null 2>&1; then
  if node -e "require('playwright')" >/dev/null 2>&1; then say playwright ok; else say playwright "optional — browser tests are skipped (npm i -g playwright && npx playwright install chromium)"; fi
fi
tb="${TBTOOLS_JAR:-/Applications/TBtools-II.app/Contents/java/app/TBtools_JRE1.6.jar}"
if [ -f "$tb" ]; then say TBtools "ok ($tb) — export TBTOOLS_JAR=\"$tb\" to compile the plugin against it"
else say TBtools "optional — not found; the plugin is compiled against java/plugin-stub (works the same)"; fi
exit $ok
