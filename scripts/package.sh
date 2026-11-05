#!/bin/sh
# Build dist/zotlet-<version>.zip: the application source, launchers and the
# pure-JavaScript citeproc dependency. No Node binary is included, so the zip
# works on any architecture with a system `node` (>= 18.17).
set -eu
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
NAME="zotlet-$VERSION"
STAGE="dist/$NAME"

[ -f node_modules/citeproc/package.json ] || npm install --omit=dev --no-audit --no-fund

mkdir -p dist
if [ -e "$STAGE" ]; then rm -r "dist/$NAME"; fi
if [ -e "$STAGE.zip" ]; then rm "dist/$NAME.zip"; fi
mkdir -p "$STAGE/node_modules"

cp -R zotlet.js package.json package-lock.json README.md LICENSE start-web.command start-web.sh src public styles locales "$STAGE/"
cp -R node_modules/citeproc "$STAGE/node_modules/"
chmod +x "$STAGE/start-web.command" "$STAGE/start-web.sh" "$STAGE/zotlet.js"

(cd dist && zip -qrX "$NAME.zip" "$NAME")
rm -r "dist/$NAME"
echo "Built dist/$NAME.zip ($(du -h "dist/$NAME.zip" | cut -f1))"
