# CLAUDE.md

Guidance for Claude (and other agents) working on zotlet. First the product requirements, then
how the code meets them, the conventions to keep, and what was done in the 2026-11 rebuild.

## Requirements

A minimal, personal reference manager inspired by Zotero.
Focus: compact UI, project-centric organization, reliable DOI import, and clean citation export.

### Core Features

- **Projects**: Treat each paper / task as a separate project.
  References can belong to zero or more projects.
  Left pane shows the project list (keep it simple).

- **Library**: Central list of references.
  Support search, and filter by active project.

- **DOI / PMID import**:
  Paste one or more DOIs or PMIDs and import.
  Must correctly normalize author objects (drop `sequence`, `affiliation`, `role`, etc.) so validation never fails on extra fields.

- **Chinese literature** (13 Nov 2026, the user: what Zotero needs the Jasminum / 茉莉花 plugin for should
  be built in, "nobody needs a plugin"): import what CNKI (知网), Wanfang and VIP export, Chinese names,
  the language field, GB/T 7714 with 等 / et al. See "Chinese literature" below.

- **Citations**:
  Generate in-text citations and bibliographies using citeproc-js.
  Built in: Nature, Science and Cell, plus the two bilingual GB/T 7714—2015 styles (13 Nov 2026, for Chinese
  literature). Every other style is downloaded under Styles.

- **Word processor citations**:
  Insert and refresh live citations and bibliographies in GenOffice and LibreOffice through the
  Zotero word-processor plugin protocol (TCP 23116, HTTP 23119), and in Microsoft Word on macOS and
  Windows through Zotero's Word template, without Zotero installed (2026-11, the user's request).
  Documents must stay usable with Zotero itself, in Word and in GenOffice (Zotero field codes,
  embedded item data, field type kept).

- **Export**:
  One click downloads the current selection (or project / whole library) as a zip with
  CSL JSON, BibTeX and RIS (importable into Zotero). CSL JSON from Zotero can be imported back.

### UI

- Two-pane layout only:
  - Left: Projects (compact)
  - Center: Reference list
  - No right-hand detail pane.

- Visual style:
  Restrained and compact (thin borders, small radius, 12 px font, short toolbar), with colors
  inspired by Claude's interface: warm neutral canvas and a clay/terracotta accent, in light and dark.
  No logo or app name anywhere.

- Density:
  Compact enough for personal daily use, but not so small that text becomes hard to read.
  Medium-compact sizing is preferred.

- Dark mode: toggle in the top bar, persisted in localStorage.

- Top bar: clean and ordered (Add references, Search, Styles, Export, theme toggle), aligned with
  the panes below. Keep the UI minimal: writing happens in the word processor, zotlet only collects,
  cites and exports.

- List columns (Title, Authors, Year, Journal, Added) sort by clicking the header; Added = import time.

- Project actions:
  Direct buttons at the bottom of the left pane (`+ New`, `Rename`, `Delete`).
  Do not hide them behind a menu that can be clipped.

- Empty states and list rows should align cleanly with the window.

### Technical Constraints

- **Runtime** (changed 2026-11, the user's request): a Java 11+ server + static frontend. No Node.
  Do **not** bundle a Java runtime: the user's own `java` runs it, or TBtools' Java when zotlet is
  installed as a TBtools plugin (one way to run it, like the user's svguest).

- **Packaging**:
  A plain zip with the application + a simple launcher script (`start-java.command` / `start-java.sh`),
  and `zotlet.plugin` for TBtools-II. The launcher calls the system `java` and opens the browser.

- **Platform**: macOS ARM is the primary target, but the package itself should be architecture-agnostic
  (no prebuilt runtime).

- **Launcher behavior**:
  Do not force-close the Terminal window.
  Let the user see the server output.

- **Data**: Persist library and projects locally (file-based or equivalent).
  Preserve item IDs and unknown fields on write.

### Non-Goals

- No silent / background-only launcher.
- No bundled Java or Node runtime.
- No three-pane Zotero clone.
- No attempt to re-implement the full Zotero connector (web page saving, translators).

### Acceptance Checks

- DOI `10.1016/j.plaphy.2026.111729` (and similar Elsevier DOIs) imports without author-validation errors.
- Creating, renaming, and deleting a project works from the left-pane buttons.
- Citing from GenOffice/LibreOffice and the zip export work for both the whole library and a single project.
- Dark mode toggle persists across reloads.
- Double-clicking the launcher on a machine that already has a JDK starts the server and opens the browser.
- Installing `zotlet.plugin` in TBtools-II opens zotlet as a TBtools tab.

## What zotlet is

A minimal, personal reference manager: projects on the left, one reference list in the center
(no right-hand detail pane), DOI/PMID import, citeproc-js citations, CSL JSON / BibTeX / RIS export,
and live citations in GenOffice / LibreOffice through the Zotero plugin protocol (documents stay usable in Zotero + Word).
It is a Java 11 app (`java/src/zotlet/`) + a static frontend (`public/`); citeproc-js runs inside it on
Rhino. Its only dependencies are Rhino and citeproc-js, downloaded by `scripts/build-java.sh`. No
framework, no bundled runtime. TBtools-II users can run it as a plugin (`zotlet.plugin`).

Until 0.2.0 zotlet was a Node app (`zotlet.js`, `src/*.js`); it was ported to Java and then removed at the
user's request ("delete what is not needed"). Its behaviour is preserved in `test/fixtures/golden.json`
(see Testing notes); the code is in git history before that removal.

## Commands

```bash
./start-java.sh                  # build (first time / after changes) and start: java -jar java/build/lib/zotlet.jar web --open
sh scripts/build-java.sh         # java/build/lib/zotlet.jar (+ Rhino, citeproc-js)
sh scripts/package-java.sh       # dist/zotlet-<version>.plugin (TBtools, also copied to ./zotlet.plugin) + dist/zotlet-java-<version>.zip
npm test                         # node:test (Node is a test tool only): end-to-end, unit and (if Playwright exists) browser tests
# release: add a "## <version>" section to CHANGELOG.md (= the release notes), bump package.json, then run
#   the "release" workflow by hand (it creates the tag; this sandbox cannot push tags) — .github/workflows/release.yml
ZOTLET_SCREENSHOTS=/some/dir node --test test/ui.test.js   # save UI screenshots for review
```

Use a throwaway data folder when running the app by hand:
`ZOTLET_HOME=/tmp/x java -jar java/build/lib/zotlet.jar web`. Never point experiments at the real `~/.zotlet`.

## Layout

```text
java/src/zotlet/   the app (Java 11, java.base + java.desktop only):
  Main.java          CLI: web | add | ls | help; `web` detects an already-running zotlet; startEmbedded() for TBtools.
  Server.java        http server on 127.0.0.1 (own HTTP parsing, HttpLite.java): public/ + JSON API under /api/.
  Store.java         library.json + web-state.json persistence (atomic, serialized, re-read per write).
  Metadata.java      identifier parsing, doi.org / Crossref / PubMed lookup (Net.java), CSL normalization, citation keys.
  Citations.java     style discovery (styles/ + ~/.zotlet/styles) and citeproc formatting (Js.java + engine.js on Rhino).
  Export.java        CSL JSON, BibTeX, RIS writers and the zip.
  Integration.java   GenOffice/LibreOffice: Zotero plugin protocol on TCP 23116 + HTTP 23119, document session.
  StyleRepo.java     "Get more styles": Zotero's style index, download/install, add .csl file, remove.
  Refs.java          reference files and text → CSL records: EndNote, RefWorks, NoteExpress (CNKI exports), RIS, BibTeX, GB/T 7714 text.
  Pdf.java           extractDOI(): the article DOI from PDF bytes (for PDFs dropped on the list).
  Picker.java        native macOS picker (runs java/quickformat.jxa.js), browser-picker window, frontApp/activateApp.
  QuickPick.java     the pop-up drawn by Java (Swing): Windows, Linux, and macOS when the native one fails.
  Json.java, Text.java  JSON and string handling with JavaScript semantics; Home.java finds the app's files.
java/quickformat.jxa.js  the native macOS citation picker (Zotero-style quick format bar), run by osascript.
java/word/         Microsoft Word: Zotero's templates (mac/, win/), word-mac.applescript and word-win.ps1, NOTICE.md;
                   Word.java routes the sessions; WordMac.java runs the Mac AppleScript.
java/plugin/       the TBtools plugin shell (Plugin/PluginInject.java); java/plugin-stub/ a compile stub of
                   TBtools' WebGuiJPanel; java/test/UnitTest.java unit checks, VerifyPlugin.java + tbtools/
                   (TBtools stand-ins) for the plugin test; java/build/ is generated.
.claude/skills/zotlet-package/  how to set up a machine, build, test, package and release (SKILL.md, check-env.sh).
public/            index.html, app.js (single ES module), style.css, theme.js (pre-paint theme),
                   pick.html + pick.js (citation/style picker opened by the word processor integration).
styles/            the built-in styles: nature, science, cell (official CSL repo) and gb-t-7714-2015-{numeric,author-date}-bilingual
                   (zotero-chinese/styles, unchanged); all CC BY-SA 3.0.
locales/           locales-en-US.xml (every style is rendered with en-US) and locales-zh-CN.xml (for styles with
                   default-locale="zh-CN").
test/              app.test.js (end to end against golden.json), ui.test.js (Playwright), unit.test.js,
                   word.test.js + fake-word.mjs, plugin.test.js, zotlet.js (starts the jar, fake internet,
                   fake word processor), helpers.js, fixtures/.
scripts/           build-java.sh, package-java.sh.
start-java.sh      the launcher; start-java.command just execs it (macOS double-click).
zotlet.plugin      the TBtools plugin, committed (README links to it).
package.json       version (read by the scripts and the release workflow) and the test script only.
CHANGELOG.md       release notes, one "## <version>" section per release.
LICENSE            MIT (styles/ and locales/ keep their CSL license, CC BY-SA 3.0).
```

## Invariants — do not break these

1. **Item IDs are never changed** after creation, and **unknown item fields are preserved** on every
   write. `store.updateItem` merges a patch; the edit form only sends fields the user changed, so
   data the form cannot represent (name particles, extra CSL fields, Zotero leftovers) survives.
2. **Unknown keys in web-state.json are preserved** (older versions stored `roots`, `files`, `links`,
   `activeProject`, …). Projects are `{ id, name, itemIds, created }` plus whatever else was there.
3. **All incoming metadata goes through `normalizeItem`** (`Metadata.java`), manual entry included
   (`Server.validateFields` reuses it). Names keep only `family`, `given`, `literal`,
   `suffix`, `dropping-particle`, `non-dropping-particle` as strings. This is what makes Elsevier
   DOIs (authors with `sequence`, `affiliation`, `ORCID`, `authenticated-orcid`, `role`) import cleanly.
   Existing library items are never re-normalized.
4. **Writes are atomic and serialized**: `mutate()` re-reads both files, applies the change, writes
   temp + rename only for files that changed. A corrupt JSON file raises an error; it is never overwritten.
5. **Security**: bind to 127.0.0.1, reject foreign `Host` headers (DNS rebinding), and require the
   per-process token from `<meta name="zotlet-token">` in the `X-Zotlet-Token` header on every
   `/api/*` call except `/api/ping`. Strict CSP: no inline scripts (that is why theme.js is a file).
6. **Launcher**: uses the system `java` (JAVA_HOME, `/usr/libexec/java_home`, PATH, then Homebrew /
   SDKMAN / micromamba paths, since double-clicked `.command` files don't always load the shell
   profile), builds the jar in a copy of the repository when needed, never closes the Terminal
   window, and waits for Enter after the server stops.
7. **Two panes only.** Do not add a right-hand detail pane; editing happens in a dialog.

## Word processor integration

`zotlet web` starts `Integration.java` next to the web app (`--no-word` or `ZOTLET_NO_WORD=1` turns it
off; `--tcp-port` / `--http-port` change the ports, tests pass 0). It is the protocol of Zotero's
plugins, ported from the pre-rebuild `session.js` / `tcp.js` / `http.js`, which the user relies on:

- **TCP 23116** is Zotero's *LibreOffice* plugin protocol (checked against
  zotero-libreoffice-integration: primaryFieldType ReferenceMark, secondary Bookmark, RTF): used by
  LibreOffice and GenOffice. 8-byte header (transaction id, length) + JSON; a command arrives as id 0,
  then zotlet issues `Document_getFields`-style RPCs. LibreOffice is detected from the peer process
  (`/proc` on Linux, `lsof` on macOS) and gets the newer data format; other clients (GenOffice) get
  the older one that worked for the user. Microsoft Word is served differently (see "Microsoft Word").
- **HTTP 23119** (`/connector/document/execCommand` + `respond`): each response carries the next RPC.
- Commands: `addEditCitation`, `addEditBibliography`, `refresh`, `setDocPrefs`, `removeCodes`.
  Field codes are Zotero's (`ITEM CSL_CITATION {…}`, `BIBL … CSL_BIBLIOGRAPHY`) with full `itemData`,
  so Zotero refreshes zotlet documents from the embedded data. `itemURI()` must not change.
- Zotero round trip (checked against zotero/xpcom/integration.js): Zotero rejects a document whose
  stored `fieldType` is not the app's primary/secondary type (Word: Field/Bookmark; LibreOffice:
  ReferenceMark/Bookmark; HTTP: Http). So zotlet **never rewrites the stored fieldType** (and keeps
  other prefs). New documents default to ReferenceMark; Document Preferences offers Bookmark
  ("Also open in Microsoft Word with Zotero") until the first citation exists (no conversion).
  Citation items not in the library by id are matched by DOI; their existing URIs (Zotero's) stay
  first and the zotlet URI is appended, so both Zotero and zotlet find the item.
- The picker shows the style menu only for the first citation of a new document (like Zotero);
  later the style is changed through Document Preferences.
- Picking: the user wants a **native pop-up like Zotero's quick format bar, not the browser**.
  `Server.pick(spec)` on macOS runs `java/quickformat.jxa.js` with `/usr/bin/osascript -l JavaScript`
  (Cocoa via the JXA bridge, nothing to install): a floating panel over the word processor with a
  search field and a result list; Enter adds the highlighted reference, Enter on an empty search
  (or ⌘Enter) inserts, ⌫ on an empty search removes the last one, Esc cancels; a style menu only for
  a new document's first citation; style mode lists styles (+ the bookmarks checkbox). The request /
  answer is JSON (`Picker.nativeSpec`, `Picker.parseResult`, both in java/test/UnitTest.java); the Cocoa part can
  only be run on a Mac (tests syntax-check it).
  **Since 13 Nov 2026 (evening) Java's pop-up is the default everywhere, macOS included**: on the user's Mac the
  Cocoa one never appeared (zotlet fell back to Java's every time, after a failed osascript start that made
  each citation slow); `ZOTLET_PICKER=cocoa` still tries the Cocoa one first.
  **Java's pop-up** (13 Nov 2026, the user: "a real pop-up, not back to
  the browser", in Word, LibreOffice and GenOffice): `QuickPick.java`, a Swing window in zotlet's own JVM
  (undecorated, always on top, same request / answer / keys; `Picker.windowPick`). Its look (the user:
  "prettier, like Raycast"): a rounded card, a large search line without a box, chips for the chosen
  references (click removes), rows with a rounded highlight (mark, title, journal, authors + year), a bottom
  bar with the keys as clickable hints; light or dark like the system (`systemDark()`: defaults / reg /
  gsettings; `ZOTLET_PICKER_THEME`), fonts with Chinese glyphs (PingFang SC, Microsoft YaHei UI, else Sans
  Serif; `fit()` falls back per string). The user (13 Nov 2026, macOS, screenshot): no see-through frame around
  the card (the painted 22px shadow showed as one), more compact, several references must be choosable. So:
  the window is exactly the card (transparent corners with translucency, macOS' own `Window.shadow`; else
  `setShape`), 600×380, 32px rows, 16px search line; **a click puts a reference into the citation or takes it
  out** (`Model.toggle`), a double click inserts, Enter as before. No bottom bar in citation mode (the user: "still ugly, the bottom"): an
  accent **Insert** pill at the right end of the chips row (shown once something is chosen; the window is 30px
  shorter until then); the style picker keeps a bottom bar with plain Cancel / Use style buttons + the checkbox. `QuickPick.warm()` (server start) reads the
  system colours and the font list once, so the first pop-up opens at once (`dark()` re-reads in the background). The macOS Cocoa pop-up was
  not restyled (it cannot be run here). `QuickPick.Model` holds
  the behaviour without AWT (UnitTest.java); `test/popup.test.js` opens the real window on Xvfb
  (`java/test/PickWindowTest.java`, screenshots with `ZOTLET_SCREENSHOTS`) and answers a TCP citation
  through it (`ZOTLET_PICK_KEYS="type:…;enter;enter"` presses keys in the window). It has only run on
  Linux/Xvfb: keyboard focus on Windows (a background program may be refused it; a WScript `AppActivate`
  is tried once) and on macOS (`Desktop.requestForeground`; `apple.awt.UIElement` keeps the stand-alone
  JVM out of the Dock) was confirmed by the user's screenshot (the pop-up had the keyboard).
  Only when no window can be shown (headless) or it throws, zotlet falls back to the browser picker
  (`/pick.html?id=…`, answered by `POST /api/pick/done`, closing it cancels, 30 min timeout), which
  `Picker.openPicker` shows as a Chromium `--app` window when possible, else a tab.
  `ZOTLET_PICKER=web` forces the browser picker. Before picking, `frontApp()` records the app in front
  (`lsappinfo`, no permission prompt); `activateApp()` brings it back (`open -b`) afterwards.
- A document whose style is not installed (e.g. APA after the built-in set shrank to three) is never
  silently switched: `ctx.installStyle(uri)` downloads it from the style repository; if that fails
  the user gets an alert and the document is left unchanged (Document Preferences still works).
- A busy port (Zotero running) only prints a warning; the web app still starts.

## Microsoft Word

The user wanted Word to work on computers without Zotero (macOS 15, Word 16.9x first; Windows too).
How Zotero's Word plugins reach Zotero, read from zotero-word-for-mac-integration and
…-for-windows-integration (their templates are in `java/word/`, unchanged, GPL; `java/word/NOTICE.md`):

- **macOS**: `Zotero.dotm` (in Word's startup folder
  `~/Library/Group Containers/UBF8T346G9.Office/User Content.localized/Startup.localized/Word`) runs, per
  button, `curl http://127.0.0.1:23119/integration/macWordCommand?agent=MacWord16&command=…&document=<Word.app>`
  (through `~/Library/Application Scripts/com.microsoft.Word/Zotero.scpt` when needed) and expects 200
  within 2 s. Zotero then drives Word with Apple Events (its ObjC dylib). zotlet answers that URL on its
  HTTP integration port (`Integration.HttpIntegration`). Since 0.5.0, `WordMac.java` handles the
  document RPCs in Java and runs `java/word/word-mac.applescript` handlers with ordinary
  `osascript -l AppleScript -s s` (source on stdin). The JXA helper was removed after the user's Mac
  reported exit 139 before it wrote anything. No Foundation/AppKit bridge is used in the Word path;
  the optional Cocoa picker is separate and remains opt-in. AppleScript variables start with `z`
  so they never clash with Word's terms. The operations follow Zotero's `build/src/*.m`: fields are
  PRINTDATE fields re-found by position, codes ` ADDIN ZOTERO_<code> `, rich text pasted from the
  clipboard (Word is sandboxed), clipboard restored, document data in custom properties `ZOTERO_PREF_n`
  (255-unit chunks, never split a surrogate pair), unlink = raw event `«event sWRD2489»`, Track Changes off
  during a command. `zInit` captures the document name/full path, view settings and selection before the
  picker; every handler checks that same document (no active-document fallback), and insertion uses the
  original story/start/end. Closed/renamed/ambiguous documents fail safely. Java parses osascript's
  source-form strings/lists as data, never evaluates them. Rich paste saves the clipboard as an AppleScript
  record and restores it plus smart-paste settings within the same invocation, including on Word errors.
  Completion/close restores Track Changes and view settings, even when initialization partially fails.
  After unlink/delete, session handles account for shifted field indices. `WordMacTest.java` tests the
  adapter at its script boundary; `test/fake-osascript.mjs` tests the production process path with the
  HTTP toolbar flow. These tests do not execute Word's dictionary or the native clipboard: Mac validation
  is still required. `ZOTLET_WORD_OSASCRIPT` is an executable-path override for process-boundary tests.
- **Windows**: `Zotero.dotm` (in `%APPDATA%\Microsoft\Word\STARTUP`) looks for a window of class
  `ZoteroMessageWindow` and sends `zotero.exe … -ZoteroIntegrationCommand X -ZoteroIntegrationDocument "path"`
  as WM_COPYDATA (UTF-8, dwData 1). `java/word/word-win.ps1` (Windows PowerShell 5.1, always present;
  C# via Add-Type for the hidden window and message boxes) opens that window, reports commands as
  `{"event":"command"}` lines, and does the document RPCs through COM, ported from Zotero's
  `document.cpp` / `field.cpp`: QUOTE fields (type 35) whose code is then replaced, rich text by
  `Range.InsertFile` of a temporary RTF, bookmarks re-added after text changes.
- `Word.java`: the helper process (one JSON line per request/answer, `{ id, method, args }` →
  `{ id, result | error }`), the session (`Integration.runSession` with Word's options: Field/Bookmark,
  RTF, `trackBibliographyStyle` so the Bibliography paragraph style is set once, as Zotero does),
  button presses run one at a time, and `install()`: copy the template (and the Mac script) unless a
  `Zotero.dotm` is already there; on macOS 15 the copy into Office's container may be refused, then
  (once, marker `~/.zotlet/.word-install-asked`) Finder shows the file and the folder to drag.
  `zotlet word-install` runs it by hand; the server runs it at start (`ZOTLET_WORD_INSTALL=0` turns it off).
- Unsupported buttons (Add Note, annotations, citation explorer) get an alert.
- **Word on a Mac from the TBtools plugin** (the user, Intel Mac, 13 Nov 2026: the Zotero tab is there, Add
  Citation shows nothing). Not reproduced (no Mac here); the likely cause: macOS attributes the helper's
  Apple events to the application zotlet was started from, and refuses them without asking (-1743) when
  that application's Info.plist has no `NSAppleEventsUsageDescription` (TBtools; Terminal has one). Errors
  of a Mac Word session used to go to the log only, so nothing was seen. Now `Word.runMac` shows
  `Picker.alert` (osascript's own `display alert`, no permission needed) with `Word.failure(...)`: inside
  TBtools (`Main.isEmbedded()`) it says to quit TBtools and start zotlet with start-java.command (the plugin
  tab then reuses that zotlet); the error also goes to `~/.zotlet/word.log`. If the user's word.log shows
  another error, this diagnosis was wrong. Not tried: running the helper outside TBtools' responsibility
  (a launchd job or an osacompile'd applet).
- Tests: `test/word.test.js` drives the whole path with `test/fake-word.mjs` standing in for the helper
  (`ZOTLET_WORD_HELPER`, `ZOTLET_WORD_MODE=mac|windows`). The AppleScript and COM parts are checked
  only on real machines: PowerShell 7 parses the script and compiles its C#, and its JSON shapes were
  checked with fake COM objects; nothing here has run against Word yet. `~/.zotlet/word.log`
  (`ZOTLET_WORD_LOG`) records the Mac helper's AppleScript errors with the failing snippet.

## Chinese literature

What Jasminum does for Zotero, as far as citing needs it; no CNKI scraping (no public interface, captchas;
the sandbox could not test it either), so references come in through what CNKI / Wanfang / VIP export.

- `Refs.java`: `detect()` + `parse()` for EndNote tagged (`%0`), RefWorks (`RT`; CNKI writes some tags in
  lower case), NoteExpress (`{Reference Type}:`), RIS, BibTeX and GB/T 7714 reference lines
  (`[1]张三,李四.题名[J].刊名,2020,47(3):12-18.`; J, D, M, N and the other type letters). Every record then
  goes through `normalizeItem`. Details: several authors in one field split at `;`, issue "03" → "3", the
  database's own page (cnki.net, wanfangdata, cqvip) is not kept as URL (GB/T would print `[J/OL]` + link),
  thesis degree → `genre` (博士学位论文). The samples in `test/fixtures/cnki/` were written from the formats
  as remembered, not downloaded from CNKI: check against a real export when the user reports one.
- `POST /api/import-refs` `{ text, name?, projectId? }` → `{ format, added, duplicates, skipped, ids, results }`;
  `POST /api/import` (the paste box) hands text that `Refs.detect` recognises to the same code. A record
  without DOI/PMID is a duplicate of a library item with the same title + year (only on this path; DOI/PMID
  matching in `Store.findDuplicate` is unchanged). The page reads dropped `.txt/.enw/.net/.ris/.bib` files as
  UTF-8, else GB18030 (`readText` in app.js).
- Names: `Metadata.hanName` splits 张三 / 欧阳修 / 王小明 (2–4 Han characters, compound surnames) into family +
  given; longer Han strings stay literal (organisations). Only `Refs` uses it; `cleanName` is unchanged.
  The list, the pickers (app.js, pick.js, `Picker.java`) show 张三、李四 / 张三 等.
- `normalizeItem` sets `language` to `zh-CN` (kana: `ja`) when the title has Han characters and none is
  given. At render time `engine.js` gives items without a language one (Han title → zh-CN, else en-US) on
  the copy it renders, never in the library or in a document's embedded data.
- Citation keys / ids: `Metadata.surnamePinyin` (a table of common surnames) → `zhang2020`; unknown → `ref2020`.
- Styles: a style with `default-locale="zh-CN"` is built with `locales-zh-CN.xml` (`zlNew` in engine.js);
  every other style still gets en-US whatever its default-locale (the recorded answers depend on that).
  The built-in GB/T 7714 styles are CSL-M (`<layout locale="en">` next to the default layout), which
  citeproc-js handles: English items get et al., Chinese ones 等. Their ids in documents are their
  zotero-chinese.com URIs, so Zotero with the same style installed opens the document.

## PDFs dropped on the list

- Dropping PDFs on the list imports them by DOI; that is all. The user explicitly does **not** want
  PDF paths, linking, opening or storage — don't add them back. The page POSTs the bytes to
  `/api/pdf/import` (raw `application/pdf`); the server reads them in memory only.
- `extractDOI`: XMP / document-info metadata first, else the most frequent DOI in the inflated page
  text (headers/footers repeat the article's own DOI; reference-list DOIs appear once), earliest first
  on ties. Checked on real BMC/Hindawi PDFs; tests use synthetic PDFs (`makePdf` in helpers).
- No DOI found, or the lookup failed → the result row lets the user type the DOI.

## Citation styles

- `Citations.listStyles()` returns bundled styles, then `~/.zotlet/styles`. A dependent (journal) style is listed
  with `file` = its parent's file (what to render with), `path` = its own file and `parent` = parent id;
  one whose parent is missing is left out. Always render from `style.file`.
- The style menu ends with "Get more styles…", which opens the styles dialog (search, Installed tab,
  Add .csl file). The index comes from `https://www.zotero.org/styles-files/styles.json`, cached in
  memory and in `~/.zotlet/style-index.json` (used when offline). Downloads try zotero.org first,
  then raw.githubusercontent.com (`<name>.csl`, `dependent/<name>.csl`). Installing a journal style
  installs its parent if needed; a parent still used by a journal style cannot be removed; bundled
  styles cannot be removed or replaced. Styles are checked with citeproc before they are saved.
- No logo and no app name in the UI (no favicon, no brand in the top bar).

## UI conventions

- Look: warm neutral canvas (`--bg`), warm off-white panels, clay accent (`--accent`, #b05430 light /
  #d97757 dark), 1px borders, 4px radius (6px panels/menus), 12px base font, 28px controls, 30px rows,
  44px top bar. Text colors keep ≥ 4.5:1 contrast (muted ≈ 4.5). Every color is a CSS variable in
  `:root` and overridden in `:root[data-theme="dark"]` (toast and on-danger colors included) —
  never hard-code colors in rules.
- Top bar = a grid matching the layout: a 220px column above the sidebar holding **Add references**
  (`#btn-new`, full width), then Search starting at the list panel's left edge, a spacer, and
  Styles · Export · | · theme ending at the panel's right edge. `test/ui.test.js` asserts the order
  and the alignment. Keep `.topbar` and `.layout` column widths in sync (220px; 180px ≤ 860px).
  Removed on purpose (2026-11): the style menu and Bibliography dialog (citing happens in the word
  processor), the status bar, the export format menu, the Edit/Clear selection buttons
  (double-click / Enter edits, Esc clears). Don't bring them back unless the user asks.
- Search box: soft filled field (`--hover` background, no border at rest), accent border + ring and
  accent icon on focus, `/` hint, a clear (×) button while it has text (`clearSearch()` is shared
  with Esc and the no-match empty state). Its placeholder names the scope: `Search in “<project>”…`
  or `Search all references…`.
- Sorting: header buttons Title / Authors / Year / Journal / Added; first click A→Z (Year and Added:
  newest first), second reverses, third returns to the default (newest import first). Saved in
  `localStorage['zotlet-sort']`. Added sorts by library order (= import order, so it works for old
  references too); the time shown (local, to the second: `YYYY-MM-DD HH:MM:SS`) comes from `web-state.json` `added: { itemId: ISO time }`, recorded
  by `store.addItems` (older references show no date). Only main-list rows (`.table .row`) have the
  sixth column; picker rows keep five.
- Project actions are three direct buttons at the bottom of the sidebar; Rename/Delete are disabled
  when no project is selected. No overflow menus for them (they can get clipped).
- Buttons are uniform: every toolbar / sidebar button is a full 28px control (`.btn`; `.btn.sm` only
  inside the list's selection bar and dialogs). The project buttons are text-only, equal width, in a
  44px bar that mirrors the top bar; Styles and Export share a min width.
- Export scope: the selection if any, else everything currently visible (library, project, or
  search results); shown in the Export button's tooltip and the toast. Export is one zip
  (`Export.toZip`: RIS + CSL JSON + BibTeX + README). Dropping a CSL JSON file imports it
  (`POST /api/import-csl`, every item through `normalizeItem`).
- Empty states (empty library, empty project, no search matches) are centered in the list panel,
  hide the column header, and offer one action.
- Rich text in titles: only `<i> <b> <sub> <sup>` are rendered (`richTitle()` in app.js builds DOM
  nodes — never assign item data to `innerHTML`). citeproc output is the only HTML set via innerHTML.
- Dialog structure is always head → (tabs) → `.dialog-body` (the only scrolling part) → `.dialog-foot`.
  A form that spans body + foot is a flex column (`.dialog-panel` or `.dialog > form`). Flex items
  in dialogs use `flex: 1 1 auto`, never `flex: 1`: a 0% basis collapsed the body to 0px in Safari
  (the user saw only the tabs and a clipped footer). Do not reintroduce sticky footers with negative
  margins. `test/ui.test.js` checks every dialog's body height and that its controls stay inside the box.
- The toast is a `popover="manual"` so it shows above modal dialogs (top layer).
- Theme: `theme.js` sets `data-theme` before first paint from `localStorage['zotlet-theme']`,
  falling back to `prefers-color-scheme`. The selected project and style are also in localStorage.

## Testing notes

- Node (and Playwright) are test tools only. `npm test` builds the jar and runs:
  - `test/app.test.js`: API requests, every export format, PDFs, style installs and word-processor sessions
    (GenOffice TCP, LibreOffice TCP, HTTP 23119, Word documents written by Zotero, a document whose style
    is missing) against a real zotlet process; every answer and document, after normalizing random ids,
    times and paths, must equal `test/fixtures/golden.json`. That file was recorded from the Node
    implementation the user had used with GenOffice, before it was removed. When behaviour changes on
    purpose, update the golden entries by hand (or record them again from the jar: `ZOTLET_RECORD=1 node --test
    test/app.test.js`, then read `git diff test/fixtures/golden.json`) and say so in the commit.
    It also checks data-file invariants and the PubMed fallback directly.
  - `test/ui.test.js`: the page in Chromium against the jar (pickers are opened through a TCP command).
  - `test/unit.test.js`: `java/test/UnitTest.java` (picker request/answer, lsof parsing, JSON numbers)
    and a syntax check of `java/quickformat.jxa.js`.
  - `test/word.test.js`: Microsoft Word (see that section).
  - `test/popup.test.js`: Java's own citation pop-up on a virtual screen (skipped without Xvfb).
  - `test/chinese.test.js`: CNKI-style files and GB/T 7714 text in, names / language / ids, the GB/T 7714 styles out.
  - `test/plugin.test.js`: packages the plugin and loads it as TBtools does (`java/test/VerifyPlugin.java`,
    TBtools stand-ins in `java/test/tbtools/`): start, closed class loader, second tab, reinstall, the
    Intel-build licence work-around, the fallback panel; with `TBTOOLS_JAR`, TBtools' own loader too.
- Packaging and releasing, step by step for people and agents: `.claude/skills/zotlet-package/SKILL.md`.
- The sandbox has no route to doi.org / Crossref / NCBI / zotero.org: zotlet reads `ZOTLET_FETCH_BASE`
  (https://host/path → <base>/host/path) and the tests serve a fake internet there (`startInternet` +
  `fakeFetch` + fixtures). `test/fixtures/elsevier-crossref.json` mirrors what doi.org returns for the
  acceptance-check DOI `10.1016/j.plaphy.2026.111729`.
- DOI lookup order (`Metadata.lookupDOI`): doi.org; if that fails, Crossref's API and PubMed in parallel
  (Crossref wins). PubMed = NCBI E-utilities `esearch` (`<doi>[doi]`, then `[aid]`) → PMID → the ctxp CSL
  record, accepted only if its DOI matches.
- `fetch()` cannot override `Host`; the Host-header test uses `http.get`.
- After any UI change, run the browser tests with `ZOTLET_SCREENSHOTS` and look at the PNGs (light, dark,
  dialogs, 700px-wide window). The narrow test asserts there is no horizontal overflow.

## Java version and TBtools plugin (2026-11)

The user asked for zotlet without Node, as a TBtools-II plugin like their svguest (TBtools ships Java and
JxBrowser, no Node). `java/src/zotlet/` was ported line by line from the Node app to Java 11
(`--release 11`, java.base + java.desktop only: no `java.net.http`, no `jdk.httpserver`, in case TBtools'
runtime lacks them), checked against it request by request, and then the Node app was removed
(its answers live on in `test/fixtures/golden.json`).

- `Json.java` writes exactly like `JSON.stringify` (key order, number format, 2-space pretty print);
  `Text.java` has JavaScript's `\s`, `trim`, `encodeURIComponent` / `decodeURIComponent` (Java's differ).
- **citeproc-js runs in Rhino 1.7.15.1** (pure Java, MPL 2.0; `lib/rhino-*.jar`), loaded from
  `citeproc/citeproc_commonjs.js` with `java/src/zotlet/engine.js` as glue (JSON strings in and out).
  Rhino is ~20x slower than V8 at building an engine (APA: ~5 s), so engines are cached per style file
  (+ mtime/size) and reused; `engine.js` also short-cuts citeproc's macro lookup (a full-tree walk per
  macro). Two citeproc instances (`Citations.js` and `plainJs`) render the formatted and the plain-text
  pass of a refresh at the same time. `Citations.warm()` prepares Nature and the two newest user styles at start.
- TCP frames are written in one `write` with `TCP_NODELAY`: a separate header write cost ~40 ms per
  document RPC (Nagle + delayed ACK; an 80-citation refresh took 9 s instead of 2 s).
- Test hooks (env): `ZOTLET_FETCH_BASE` (https://host/path → <base>/host/path, a local mock),
  `ZOTLET_OPEN_LOG=stdout` (print picker URLs), `ZOTLET_TEST_CLIENT=soffice` (treat TCP clients as
  LibreOffice), `--tcp-port` / `--http-port`.
- Build: `scripts/build-java.sh` (javac, Rhino from Maven Central and citeproc from the npm registry,
  both SHA-256 pinned) → `java/build/lib/`. `scripts/package-java.sh` → `dist/zotlet-<v>.plugin`
  and `dist/zotlet-java-<v>.zip` (+ `start-java.command` / `start-java.sh`, which find a JDK incl. Homebrew,
  SDKMAN and micromamba envs). Set `TBTOOLS_JAR` to compile the plugin against TBtools' real jar
  (`/Applications/TBtools-II.app/Contents/java/app/TBtools_JRE1.6.jar`); otherwise a stub of `WebGuiJPanel` is used.
- **Plugin** (`java/plugin/Plugin/PluginInject.java`, adapted from svguest's `jh-html-to-tbtools-plugin`
  skill): TBtools loads the first top-level `*.jar` (`zotlet-plugin.jar`) and may close its class loader
  after `generatePanel()`, so zotlet runs from `lib/` in its own never-closed `URLClassLoader` (parent: the
  platform loader). `Main.startEmbedded(home)` starts the server once per JVM on 23121 with the
  integration on (or reuses a zotlet already answering there); later tabs reuse it via the system
  property `zotlet.plugin.url`. The tab is `WebGuiJPanel(url, false)`; the JxBrowser hooks give native
  Open/Save dialogs (file input, downloads) and the macOS full-width punctuation fix. Checked here only by
  loading the plugin through its own class loader with a stub panel (no JxBrowser in the sandbox);
  drag-and-drop of files onto the list inside JxBrowser is unverified.
- **Positioning (the user, 12 Nov 2026): zotlet is a Java app; TBtools is just one way to run it, as a
  plugin.** The README is written for the Java version: start it with your own Java
  (`start-java.command` / `start-java.sh`, which builds `java/build/lib/zotlet.jar` on first start or when
  `java/src` changed); TBtools-II users can also use `zotlet.plugin` (repository root; releases attach
  `zotlet-<v>.plugin`), where the whole workflow happens inside TBtools.
- **Plugin removed or reinstalled while TBtools runs** (seen 12 Nov 2026: the old in-TBtools server kept
  port 23121 and answered `{"error":"…/.Plugin/zotlet/public/index.html"}`, and start-java opened that
  broken page). Now the plugin remembers its folder and class loader in system properties and, when
  opened from a different or emptied folder, calls `Main.stopEmbedded()` on the old one and starts
  again; the server answers a clear text when its files are gone; and `zotlet web` refuses to reuse a
  zotlet on its port whose page does not load (`Main.pageWorks`), telling the user to quit TBtools.
- First run in TBtools-II 2.568 **Intel build on a Mac** (12 Nov 2026): `new WebGuiJPanel(...)` threw
  JxBrowser's `InvalidLicenseException` and TBtools said "no plugin menu could be registered". Decompiled
  (classes the user sent): `WebGuiJPanel(url, b)` sets `jxbrowser.license.key` from
  `toolsKit.LicenseHub.GetLicense.getJxBroswerLicense()`, which returns the key of JxBrowser 7.22 (the
  Apple-silicon build) whenever `os.name` contains "mac", whatever the build; `getEngine()` keeps one
  static Engine and checks the license when creating it. So `browserPanel()` on a license error asks
  GetLicense for its other key (with `os.name` briefly set to Linux), creates the shared engine with it
  through `WebGuiJPanel.getEngine()`, and builds the panel again; TBtools' keys are never copied into
  zotlet. If the browser still fails, `fallbackPanel()` registers the plugin anyway (URL + button, page in
  the system browser; the server and the word-processor ports keep running inside TBtools).

## History: the 2026-11 rebuild

The previous tree (`web/`, `session.js`, `tcp.js`, `http.js`, …) mixed this app with unrelated
subsystems and was unreliable. What was found and what was done:

- **Removed** (dead code or non-goals): the Zotero Connector endpoints for saving web pages, the `docx` command, a `picker.jxa` integration whose script did
  not exist in the repo, PDF folder scanning/linking, a style editor/repository browser, and worker
  files. The Word/LibreOffice/GenOffice bridge was removed too, which broke citing for the user; it was
  restored right after as `src/integration.js` (see above). `package.json` referenced 16 test files that did not exist; `web/server.js` imported
  modules that were never served; the error text referred to a `zotlet-macos-arm64` folder.
- **Problems fixed along the way**: abstracts were stored with raw JATS markup; the launcher opened
  the browser after a fixed 1.5s sleep and gave no guidance when `node` was missing or not on the
  double-click PATH; a second launch failed with "port in use" instead of opening the running
  instance; project rename/delete used native `prompt()`/`confirm()`; export ignored the selection;
  the bibliography had no in-text citation and no rich-text copy; the theme was applied after load
  (light flash in dark mode); duplicate detection only looked at DOIs.
- **Rebuilt** as `src/` + `public/` with the invariants above, 13 bundled styles (latest versions
  from the CSL repo), server-side BibTeX/RIS export (escaping, `--` page ranges, unique keys,
  `\textit{}` for italics, CRLF RIS), and tests (unit, API, browser).
- Existing user data is read as-is: same paths (`~/.zotlet/library.json`, `web-state.json`), same
  env vars (`ZOTLET_HOME`, `ZOTLET_LIB`), and same project shape.

## Working style for future changes

- Keep it small: no frameworks, no bundler, no new runtime dependencies without a strong reason.
- Put behavior in `java/src/zotlet/` where it is testable; keep `public/app.js` to UI wiring.
- Add or update a test with every fix; run `npm test` before committing.
- Don't commit `dist/`, `java/build/`, `node_modules/` or anything from a real `~/.zotlet`. The exception is
  `zotlet.plugin` at the top of the repository (the user's request, like svguest.plugin): after changing
  `java/`, `public/`, `styles/` or `locales/`, rebuild it with
  `TBTOOLS_JAR=<TBtools main jar or its classes> sh scripts/package-java.sh` and commit it.
- When a change is done and `npm test` passes, push it straight to `main` (the user's standing
  request); a working branch, if any, is kept in sync with `main`.
