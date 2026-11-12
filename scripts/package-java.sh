#!/bin/sh
# Package the Java version of zotlet (no Node needed; a Java 11+ runtime runs it):
#   dist/zotlet-<version>.plugin     TBtools plugin (Install Plugin in TBtools), copied to ./zotlet.plugin
#   dist/zotlet-java-<version>.zip   stand-alone: double-click start-java.command (macOS) or run start-java.sh
# The plugin shell is compiled against TBtools' main jar when TBTOOLS_JAR points to it
# (e.g. /Applications/TBtools-II.app/Contents/java/app/TBtools_JRE1.6.jar), else against a stub
# of the one TBtools class it uses.
set -eu
cd "$(dirname "$0")/.."

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
sh scripts/build-java.sh

BUILD=java/build
APP="$BUILD/app"
rm -rf "$APP" "$BUILD/plugin-classes" "$BUILD/stub-classes"
mkdir -p "$APP/lib" "$APP/citeproc" dist

# The application folder, shared by the plugin and the stand-alone zip.
cp -R public styles locales "$APP/"
cp java/quickformat.jxa.js LICENSE "$APP/"
cp "$BUILD/lib/zotlet.jar" "$BUILD"/lib/rhino-*.jar "$APP/lib/"
cp "$BUILD/citeproc/citeproc_commonjs.js" "$BUILD/citeproc/LICENSE" "$APP/citeproc/"
cat > "$APP/THIRD-PARTY.txt" <<'EOF'
citeproc/   citeproc-js by Frank Bennett, CPAL 1.0 / AGPL 3.0 (citeproc/LICENSE)
lib/rhino-*.jar   Rhino JavaScript engine, Mozilla Public License 2.0 (https://github.com/mozilla/rhino)
styles/, locales/   Citation Style Language styles and locale, CC BY-SA 3.0
EOF

# ---------- TBtools plugin ----------
TB="${TBTOOLS_JAR:-}"
if [ -z "$TB" ]; then
  mkdir -p "$BUILD/stub-classes"
  javac -encoding UTF-8 --release 11 -Xlint:-options -d "$BUILD/stub-classes" java/plugin-stub/biocjava/GUIexcutors/WebGuiApp/WebGuiJPanel.java
  TB="$BUILD/stub-classes"
  echo "(plugin compiled against a stub of TBtools' WebGuiJPanel; set TBTOOLS_JAR to use the real jar)"
fi
mkdir -p "$BUILD/plugin-classes"
javac -encoding UTF-8 --release 11 -Xlint:-options -cp "$TB" -d "$BUILD/plugin-classes" java/plugin/Plugin/PluginInject.java

STAGE="$BUILD/plugin/zotlet"
rm -rf "$BUILD/plugin"
mkdir -p "$STAGE"
cp -R "$APP"/. "$STAGE/"
# TBtools loads the first top-level *.jar; zotlet itself stays in lib/.
jar --create --no-manifest --file "$STAGE/zotlet-plugin.jar" -C "$BUILD/plugin-classes" .
find "$STAGE" -name '.*' -prune -exec rm -rf {} +
rm -f "dist/zotlet-$VERSION.plugin"
(cd "$BUILD/plugin" && zip -qrX "../../../dist/zotlet-$VERSION.plugin" zotlet)

# ---------- stand-alone zip ----------
NAME="zotlet-java-$VERSION"
rm -rf "$BUILD/$NAME" "dist/$NAME.zip"
mkdir -p "$BUILD/$NAME"
cp -R "$APP"/. "$BUILD/$NAME/"
cp start-java.sh start-java.command README.md "$BUILD/$NAME/"
chmod +x "$BUILD/$NAME/start-java.sh" "$BUILD/$NAME/start-java.command"
(cd "$BUILD" && zip -qrX "../../dist/$NAME.zip" "$NAME")

# The plugin is also kept at the top of the repository, like svguest.plugin (README links to it).
cp "dist/zotlet-$VERSION.plugin" zotlet.plugin

echo "Built dist/zotlet-$VERSION.plugin ($(du -h "dist/zotlet-$VERSION.plugin" | cut -f1)) and dist/$NAME.zip ($(du -h "dist/$NAME.zip" | cut -f1))"
