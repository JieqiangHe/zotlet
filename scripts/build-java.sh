#!/bin/sh
# Build the Java version of zotlet into java/build:
#   java/build/lib/zotlet.jar          zotlet itself (java/src)
#   java/build/lib/rhino-1.7.15.1.jar  Rhino, the JavaScript engine that runs citeproc-js
#   java/build/citeproc/               citeproc-js (from node_modules, else from the npm registry)
# Needs a JDK 11+ (javac, jar). Rhino and citeproc are downloaded once and checked by SHA-256.
set -eu
cd "$(dirname "$0")/.."

RHINO_VERSION=1.7.15.1
RHINO_SHA256=f3520a0e2e22d550f1216a456be233eb5385bf08e3219407dece7a16369eb38f
CITEPROC_VERSION=2.4.63
CITEPROC_SHA256=7f2b7714bfd1f4480aad9c34972eb5d48dc1b85876ba21b5aa9aee74156e2ccf
BUILD=java/build

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch() { # url file sha256
  if [ -f "$2" ] && [ "$(sha256 "$2")" = "$3" ]; then return 0; fi
  echo "Downloading $1"
  curl -fsSL --retry 3 -o "$2.part" "$1"
  if [ "$(sha256 "$2.part")" != "$3" ]; then rm -f "$2.part"; echo "Checksum mismatch for $1" >&2; exit 1; fi
  mv "$2.part" "$2"
}

command -v javac >/dev/null 2>&1 || { echo "javac not found: install a JDK 11 or newer" >&2; exit 1; }
mkdir -p "$BUILD/lib" "$BUILD/citeproc" "$BUILD/download"

fetch "https://repo1.maven.org/maven2/org/mozilla/rhino/$RHINO_VERSION/rhino-$RHINO_VERSION.jar" "$BUILD/lib/rhino-$RHINO_VERSION.jar" "$RHINO_SHA256"

if [ -f node_modules/citeproc/citeproc_commonjs.js ] && grep -q "\"version\": \"$CITEPROC_VERSION\"" node_modules/citeproc/package.json; then
  cp node_modules/citeproc/citeproc_commonjs.js node_modules/citeproc/LICENSE "$BUILD/citeproc/"
elif [ ! -f "$BUILD/citeproc/citeproc_commonjs.js" ]; then
  fetch "https://registry.npmjs.org/citeproc/-/citeproc-$CITEPROC_VERSION.tgz" "$BUILD/download/citeproc.tgz" "$CITEPROC_SHA256"
  tar -xzf "$BUILD/download/citeproc.tgz" -C "$BUILD/download"
  cp "$BUILD/download/package/citeproc_commonjs.js" "$BUILD/download/package/LICENSE" "$BUILD/citeproc/"
fi

rm -rf "$BUILD/classes"
mkdir -p "$BUILD/classes/zotlet"
# shellcheck disable=SC2046
javac -encoding UTF-8 --release 11 -Xlint:-options -cp "$BUILD/lib/rhino-$RHINO_VERSION.jar" -d "$BUILD/classes" $(find java/src -name '*.java')
cp java/src/zotlet/engine.js "$BUILD/classes/zotlet/"
printf 'Main-Class: zotlet.Main\nClass-Path: rhino-%s.jar\n' "$RHINO_VERSION" > "$BUILD/manifest.txt"
jar --create --file "$BUILD/lib/zotlet.jar" --manifest "$BUILD/manifest.txt" -C "$BUILD/classes" .
echo "Built $BUILD/lib/zotlet.jar"
