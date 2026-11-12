---
name: zotlet-package
description: Set up the tools, build, test, package and distribute zotlet — the stand-alone Java app (zotlet-java-X.Y.Z.zip), the TBtools-II plugin (zotlet.plugin) and the Word integration files — and publish a GitHub release. Use whenever the user asks to build, package, rebuild the plugin, make a TBtools plugin, test the plugin, release, publish, ship or distribute zotlet, or to set up a machine or agent to do so — even without saying "package".
---

# Packaging and distributing zotlet

zotlet is a Java 11 app (`java/src/zotlet/`) with a static page (`public/`). It is distributed three
ways, all built by one script:

| What | File | Who uses it |
|---|---|---|
| Stand-alone app | `dist/zotlet-java-X.Y.Z.zip` (also: a plain copy of the repository) | anyone with Java 11+: double-click `start-java.command` / run `start-java.sh` |
| TBtools-II plugin | `dist/zotlet-X.Y.Z.plugin`, copied to `./zotlet.plugin` (committed, linked from the README) | TBtools users: *Install Plugin* |
| Word integration | inside both: `word/` (Zotero's templates + zotlet's helpers) | installed into Word by zotlet itself |

Nothing bundles a Java runtime. Node is only a test tool.

## 1. Set up the machine (once per machine or agent)

```bash
sh .claude/skills/zotlet-package/scripts/check-env.sh
```

It lists what is missing and how to get it. Needed: a **JDK 11+** (`javac`, `jar`; a JRE is not
enough), `curl`, `zip`, `unzip`. For the tests: **Node 18+**; Playwright with Chromium is optional
(browser tests skip themselves without it). Examples:

- macOS: `brew install openjdk node` (or a micromamba env with `openjdk`; then put its `bin` first on `PATH`).
- Debian/Ubuntu: `sudo apt install openjdk-21-jdk zip unzip nodejs`.
- Cloud sandboxes usually have a JDK and Node already; Rhino and citeproc-js come from Maven Central
  and the npm registry, which package-registry network policies allow.

Optional: TBtools' main jar, to compile the plugin against the real TBtools class instead of the stub
(`java/plugin-stub/`; the bytecode is the same, it only calls `WebGuiJPanel(String, boolean)` and one
static method by reflection). On macOS it is
`/Applications/TBtools-II.app/Contents/java/app/TBtools_JRE1.6.jar`; export it as `TBTOOLS_JAR`.

## 2. Build and test

```bash
sh scripts/build-java.sh      # java/build/lib/zotlet.jar + rhino jar + java/build/citeproc/ (SHA-256 pinned downloads)
npm test                      # everything below; about 3 minutes
```

`npm test` runs, against the real jar:

- `test/app.test.js` — API, exports, PDFs, styles, GenOffice / LibreOffice / HTTP / Zotero-Word document
  sessions, compared with `test/fixtures/golden.json` (recorded from the original implementation).
- `test/word.test.js` — Microsoft Word: the Mac template's HTTP call and the Windows window event, through
  `test/fake-word.mjs` standing in for the Word helpers; `zotlet word-install`.
- `test/plugin.test.js` — **packages the plugin** (`package-java.sh --no-repo-copy`), unpacks it like
  *Install Plugin*, and loads it as TBtools does (`java/test/VerifyPlugin.java` with stand-ins for
  TBtools in `java/test/tbtools/`): one top-level jar; zotlet starts and keeps working after TBtools
  closes the plugin's class loader; a citation is formatted; a second tab reuses the server;
  reinstalling while TBtools runs takes over; the Intel-build licence work-around; the fallback panel.
  With `TBTOOLS_JAR` set it also loads the plugin through TBtools' own loader.
- `test/ui.test.js` — the page in Chromium (skipped without Playwright).
- `test/unit.test.js` — `java/test/UnitTest.java` and syntax checks.

Run the plugin checks alone, several times when touching the plugin: `node --test test/plugin.test.js`.
All tests must pass before packaging for release. The Word helpers' AppleScript (`java/word/word-mac.js`)
and COM (`java/word/word-win.ps1`) parts only run with Word: on a machine with PowerShell 7
(`dotnet tool install -g PowerShell`), the parse + C# compile check in "Word helpers" below still applies.

## 3. Package

```bash
TBTOOLS_JAR=/path/to/TBtools_JRE1.6.jar sh scripts/package-java.sh   # or without TBTOOLS_JAR (stub)
```

Outputs `dist/zotlet-X.Y.Z.plugin`, `dist/zotlet-java-X.Y.Z.zip`, and replaces `./zotlet.plugin`
(the version comes from `package.json`). Check before committing:

```bash
unzip -Z1 zotlet.plugin | grep -E '^zotlet/[^/]+\.jar$'   # exactly zotlet/zotlet-plugin.jar
unzip -Z1 zotlet.plugin | grep -c '^zotlet/word/'         # the Word files are inside
```

Commit `zotlet.plugin` whenever `java/`, `public/`, `styles/` or `locales/` changed; never commit `dist/`
or `java/build/`.

Plugin layout (what TBtools sees): `zotlet/zotlet-plugin.jar` (the shell, `java/plugin/Plugin/PluginInject.java`
— TBtools loads the first top-level jar and may close its class loader after `generatePanel()`),
`zotlet/lib/` (zotlet + Rhino, loaded by the shell in a class loader of its own), `public/`, `styles/`,
`locales/`, `citeproc/`, `word/`, `quickformat.jxa.js`, `LICENSE`, `THIRD-PARTY.txt`.

## 4. Try it by hand (the parts tests cannot reach)

On a Mac or Windows machine with TBtools-II and Word / GenOffice:

1. TBtools: *Plugin › Manage Plugins* › remove the old zotlet; *Install Plugin* › `zotlet.plugin`; open it.
   The tab shows the zotlet page (or a note + "Open zotlet in the web browser" if TBtools' browser fails;
   TBtools' debug log has lines starting with `zotlet:`).
2. Export downloads with a Save dialog; *Styles › Add .csl file* opens a file dialog.
3. GenOffice / LibreOffice (Zotero closed): Add/Edit Citation, Bibliography, Refresh, Document Preferences.
4. Word: zotlet installs Zotero's template at start (log line `Word: installed the Zotero tab…`; on macOS 15
   Finder may open the template and Word's startup folder to drag it once). Restart Word, then use the
   Zotero tab. macOS asks once to allow controlling Microsoft Word. Problems: `~/.zotlet/word.log`.
5. Stand-alone: unzip `zotlet-java-X.Y.Z.zip`, double-click `start-java.command`.

## 5. Release

Versions: bug fixes → patch, new features → minor. The version is only in `package.json` (+ lock file).

```bash
new=X.Y.Z
sed -i "s/\"version\": \"[0-9.]*\"/\"version\": \"$new\"/" package.json   # macOS: sed -i ''
npm install --package-lock-only
```

Write the `## X.Y.Z — YYYY-MM-DD` section of `CHANGELOG.md` (it becomes the release notes; user terms,
claims matching the app). Rebuild `zotlet.plugin` (step 3), run `npm test`, commit, push `main`.

Then publish with the **release** GitHub Actions workflow (`.github/workflows/release.yml`): it checks out
`main`, runs `npm test` with Java 17, runs `package-java.sh`, and creates the GitHub release `vX.Y.Z` with
`zotlet-X.Y.Z.plugin` and `zotlet-java-X.Y.Z.zip`, notes from the CHANGELOG section. Start it by pushing
the tag, or by hand (it creates the tag):

```bash
git tag vX.Y.Z && git push origin vX.Y.Z                    # or:
gh workflow run release.yml --ref main                       # or the GitHub MCP tool actions_run_trigger (run_workflow)
gh release view vX.Y.Z                                       # assets: the .plugin and the java zip
```

Some cloud sandboxes cannot push tags (the git proxy refuses): use the workflow by hand. Rerunning the
workflow for an existing version only updates the notes. The plugin in the release is built against the
stub (CI has no TBtools jar); the committed `./zotlet.plugin` may be built against the real jar — both
behave the same.

## Word helpers

- `java/word/mac/Zotero.dotm`, `mac/Zotero.scpt`, `win/Zotero.dotm` are Zotero's templates, unchanged
  (GPL 3+, see `java/word/NOTICE.md`). To update them, copy from zotero/zotero-word-for-mac-integration
  and …-for-windows-integration (`install/`) and record the commits in NOTICE.md.
- `word-mac.js` (osascript JavaScript + AppleScript) and `word-win.ps1` (Windows PowerShell 5.1 + C# via
  Add-Type, COM) are zotlet's. Check the PowerShell one where PowerShell 7 is available:

```bash
pwsh -NoProfile -Command '$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile("java/word/word-win.ps1",[ref]$t,[ref]$e);$e;
  Add-Type -TypeDefinition ($a.FindAll({$args[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $args[0].StringConstantType -eq "SingleQuotedHereString"},$true)|Select-Object -First 1).Value; "ok"'
```

## Troubleshooting

- `javac not found`: a JRE is installed, not a JDK. Install a JDK.
- `Checksum mismatch` in build-java.sh: a proxy changed the download; retry, or fetch the jar/tgz by hand
  and compare with the SHA-256 in the script. Never change a checksum without checking the file.
- TBtools says "no plugin menu could be registered": see CLAUDE.md › Java version and TBtools plugin
  (JxBrowser licence on the Intel build; the plugin now works around it).
- After reinstalling a plugin built before 0.2.1, restart TBtools once (older plugins cannot hand over).
