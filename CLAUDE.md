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

- **Citations**:
  Generate in-text citations and bibliographies using citeproc-js.
  Built in: Nature, Science and Cell only. Every other style is downloaded under Styles.

- **Word processor citations**:
  Insert and refresh live citations and bibliographies in GenOffice and LibreOffice through the
  Zotero word-processor plugin protocol (TCP 23116, HTTP 23119). Documents must stay usable with
  Zotero itself, in Word and in GenOffice (Zotero field codes, embedded item data, field type kept).

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

- **Runtime**: Node.js server + static frontend.
  Do **not** bundle a Node binary. The user will use their own system `node`.

- **Packaging**:
  Produce a plain zip that contains only the application source + a simple launcher script
  (`start-web.command` / `start-web.sh`).
  The launcher must call the system `node` and open the browser.

- **Platform**: macOS ARM is the primary target, but the package itself should be architecture-agnostic
  (no prebuilt Node).

- **Launcher behavior**:
  Do not force-close the Terminal window.
  Let the user see the server output.

- **Data**: Persist library and projects locally (file-based or equivalent).
  Preserve item IDs and unknown fields on write.

### Non-Goals

- No silent / background-only launcher.
- No bundled Node binary.
- No three-pane Zotero clone.
- No attempt to re-implement the full Zotero connector (web page saving, translators).

### Acceptance Checks

- DOI `10.1016/j.plaphy.2026.111729` (and similar Elsevier DOIs) imports without author-validation errors.
- Creating, renaming, and deleting a project works from the left-pane buttons.
- Citing from GenOffice/LibreOffice and the zip export work for both the whole library and a single project.
- Dark mode toggle persists across reloads.
- Double-clicking the launcher on a machine that already has `node` in `PATH` starts the server and opens the browser.

## What zotlet is

A minimal, personal reference manager: projects on the left, one reference list in the center
(no right-hand detail pane), DOI/PMID import, citeproc-js citations, CSL JSON / BibTeX / RIS export,
and live citations in GenOffice / LibreOffice through the Zotero plugin protocol (documents stay usable in Zotero + Word).
Runtime is the user's own system `node` (>= 18.17) + a static frontend. The only npm dependency is
`citeproc`. No build step, no framework, no bundled Node binary.

## Commands

```bash
npm install                      # citeproc only
npm test                         # node:test — unit, API and (if Playwright exists) browser tests
npm start                        # node zotlet.js web --open
npm run package                  # dist/zotlet-<version>.zip
sh scripts/package-java.sh       # Java version: dist/zotlet-<version>.plugin (TBtools) + dist/zotlet-java-<version>.zip
# release: add a "## <version>" section to CHANGELOG.md (= the release notes), then push tag v<version>
#   or run the "release" workflow by hand (creates the tag; rerun to update the notes) — .github/workflows/release.yml
ZOTLET_SCREENSHOTS=/some/dir node --test test/ui.test.js   # save UI screenshots for review
```

Use a throwaway data folder when running the app by hand: `ZOTLET_HOME=/tmp/x node zotlet.js web`.
Never point experiments at the real `~/.zotlet`.

## Layout

```text
zotlet.js          CLI: web | add | ls | help. `web` detects an already-running zotlet on the port.
src/server.js      http server on 127.0.0.1: static files from public/, JSON API under /api/.
src/store.js       library.json + web-state.json persistence (atomic, serialized, re-read per write).
src/metadata.js    identifier parsing, doi.org / Crossref / PubMed lookup, CSL normalization, citation keys.
src/citations.js   style discovery (styles/ + ~/.zotlet/styles) and citeproc formatting.
src/export.js      CSL JSON, BibTeX, RIS writers.
src/integration.js GenOffice/LibreOffice: Zotero plugin protocol on TCP 23116 + HTTP 23119, document session.
src/style-repo.js  "Get more styles": Zotero's style index (styles.json), download/install, add .csl file, remove.
src/pdf.js         extractDOI(): the article DOI from PDF bytes (for PDFs dropped on the list).
src/open.js        openBrowser().
public/            index.html, app.js (single ES module), style.css, theme.js (pre-paint theme),
                   pick.html + pick.js (citation/style picker opened by the word processor integration).
styles/            the built-in styles: nature, science, cell (official CSL repo, CC BY-SA 3.0).
src/quickformat.js + quickformat.jxa.js  the native macOS citation picker (Zotero-style quick format bar).
src/popup.js       browser-picker fallback as a pop-up app window (Chromium), and switching back to the word processor.
locales/           locales-en-US.xml (every style is rendered with en-US).
test/              *.test.js + helpers.js + fixtures/ (recorded Crossref and PubMed records; styles/ holds
                   APA and Elsevier Harvard, used by tests as user-installed / downloadable styles).
scripts/package.sh builds the zip (source + launchers + LICENSE + node_modules/citeproc).
CHANGELOG.md       release notes, one "## <version>" section per release.
LICENSE            MIT (styles/ and locales/ keep their CSL license, CC BY-SA 3.0).
start-web.sh       real launcher; start-web.command just execs it (macOS double-click).
java/src/zotlet/   the Java version (see "Java version and TBtools plugin"); java/plugin/ the TBtools plugin shell,
                   java/plugin-stub/ a compile-time stub of TBtools' WebGuiJPanel; java/build/ is generated.
start-java.sh      launcher of the stand-alone Java version; start-java.command execs it.
scripts/build-java.sh, scripts/package-java.sh   build java/build/lib, package dist/zotlet-<v>.plugin + zotlet-java-<v>.zip.
```

## Invariants — do not break these

1. **Item IDs are never changed** after creation, and **unknown item fields are preserved** on every
   write. `store.updateItem` merges a patch; the edit form only sends fields the user changed, so
   data the form cannot represent (name particles, extra CSL fields, Zotero leftovers) survives.
2. **Unknown keys in web-state.json are preserved** (older versions stored `roots`, `files`, `links`,
   `activeProject`, …). Projects are `{ id, name, itemIds, created }` plus whatever else was there.
3. **All incoming metadata goes through `normalizeItem`** (`src/metadata.js`), manual entry included
   (`validateFields` in `src/server.js` reuses it). Names keep only `family`, `given`, `literal`,
   `suffix`, `dropping-particle`, `non-dropping-particle` as strings. This is what makes Elsevier
   DOIs (authors with `sequence`, `affiliation`, `ORCID`, `authenticated-orcid`, `role`) import cleanly.
   Existing library items are never re-normalized.
4. **Writes are atomic and serialized**: `mutate()` re-reads both files, applies the change, writes
   temp + rename only for files that changed. A corrupt JSON file raises an error; it is never overwritten.
5. **Security**: bind to 127.0.0.1, reject foreign `Host` headers (DNS rebinding), and require the
   per-process token from `<meta name="zotlet-token">` in the `X-Zotlet-Token` header on every
   `/api/*` call except `/api/ping`. Strict CSP: no inline scripts (that is why theme.js is a file).
6. **Launcher**: uses the system `node` (also probes Homebrew/Volta/nvm paths, since double-clicked
   `.command` files don't always load the shell profile), installs citeproc only if missing, never
   closes the Terminal window, and waits for Enter after the server stops.
7. **Two panes only.** Do not add a right-hand detail pane; editing happens in a dialog.

## Word processor integration

`zotlet.js web` starts `src/integration.js` next to the web app (`startServer({ integration: {} })`;
`--no-word` or `ZOTLET_NO_WORD=1` turns it off; tests pass ports 0). It is the protocol of Zotero's
plugins, ported from the pre-rebuild `session.js` / `tcp.js` / `http.js`, which the user relies on:

- **TCP 23116** is Zotero's *LibreOffice* plugin protocol (checked against
  zotero-libreoffice-integration: primaryFieldType ReferenceMark, secondary Bookmark, RTF): used by
  LibreOffice and GenOffice. 8-byte header (transaction id, length) + JSON; a command arrives as id 0,
  then zotlet issues `Document_getFields`-style RPCs. LibreOffice is detected from the peer process
  (`/proc` on Linux, `lsof` on macOS) and gets the newer data format; other clients (GenOffice) get
  the older one that worked for the user. Microsoft Word talks to Zotero through its own plugin
  channel (a pipe), not this port — zotlet cannot serve Word directly.
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
  `server.pick(spec)` on macOS runs `src/quickformat.jxa.js` with `/usr/bin/osascript -l JavaScript`
  (Cocoa via the JXA bridge, nothing to install): a floating panel over the word processor with a
  search field and a result list; Enter adds the highlighted reference, Enter on an empty search
  (or ⌘Enter) inserts, ⌫ on an empty search removes the last one, Esc cancels; a style menu only for
  a new document's first citation; style mode lists styles (+ the bookmarks checkbox). The request /
  answer is JSON (`src/quickformat.js`: `nativeSpec`, `parseResult`, both tested); the Cocoa part can
  only be run on a Mac (tests syntax-check it). Any failure falls back to the browser picker
  (`/pick.html?id=…`, answered by `POST /api/pick/done`, closing it cancels, 30 min timeout), which
  `openPicker` (src/popup.js) shows as a Chromium `--app` window when possible, else a tab.
  `ZOTLET_PICKER=web` forces the browser picker. Before picking, `frontApp()` records the app in front
  (`lsappinfo`, no permission prompt); `activateApp()` brings it back (`open -b`) afterwards.
- A document whose style is not installed (e.g. APA after the built-in set shrank to three) is never
  silently switched: `ctx.installStyle(uri)` downloads it from the style repository; if that fails
  the user gets an alert and the document is left unchanged (Document Preferences still works).
- A busy port (Zotero running) only prints a warning; the web app still starts.

## PDFs dropped on the list

- Dropping PDFs on the list imports them by DOI; that is all. The user explicitly does **not** want
  PDF paths, linking, opening or storage — don't add them back. The page POSTs the bytes to
  `/api/pdf/import` (raw `application/pdf`); the server reads them in memory only.
- `extractDOI`: XMP / document-info metadata first, else the most frequent DOI in the inflated page
  text (headers/footers repeat the article's own DOI; reference-list DOIs appear once), earliest first
  on ties. Checked on real BMC/Hindawi PDFs; tests use synthetic PDFs (`makePdf` in helpers).
- No DOI found, or the lookup failed → the result row lets the user type the DOI.

## Citation styles

- `listStyles()` returns bundled styles, then `~/.zotlet/styles`. A dependent (journal) style is listed
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
  (`toZip` in src/export.js: RIS + CSL JSON + BibTeX + README). Dropping a CSL JSON file imports it
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

- The sandbox this was built in had no route to doi.org / api.crossref.org / NCBI, so lookups are
  tested with `fakeFetch` + fixtures. `startServer({ fetchImpl })` and `lookupDOI(doi, fetchImpl)`
  take an injectable fetch for exactly this reason. `test/fixtures/elsevier-crossref.json` mirrors the
  shape doi.org returns for Elsevier DOIs (the acceptance-check DOI `10.1016/j.plaphy.2026.111729`).
- DOI lookup order (`lookupDOI`): doi.org; if that fails, Crossref's API and PubMed in parallel
  (Crossref wins). PubMed = NCBI E-utilities `esearch` (`<doi>[doi]`, then `[aid]`) → PMID → the
  ctxp CSL record, accepted only if its DOI matches. Added because doi.org/Crossref are often slow or
  unreachable for the user. `fakeFetch` takes `pubmedSearch` and `unreachable` hosts to test this.
- `fetch()` cannot override `Host`; the Host-header test uses `http.get`.
- Playwright is loaded with `createRequire` and the browser tests skip themselves when it is absent.
  After any UI change, run them with `ZOTLET_SCREENSHOTS` and look at the PNGs (light, dark, dialogs,
  700px-wide window). The narrow test asserts there is no horizontal overflow.
- Every bundled style is rendered in `citations.test.js`; add a new style to `styles/` and that test
  covers it automatically.

## Java version and TBtools plugin (2026-11)

The user asked for zotlet without Node, as a TBtools-II plugin like their svguest (TBtools ships Java and
JxBrowser, no Node). `java/src/zotlet/` is a port of `src/` to Java 11 (`--release 11`, java.base +
java.desktop only: no `java.net.http`, no `jdk.httpserver`, in case TBtools' runtime lacks them). The
Node version stays; both serve the same `public/` and read/write the same `~/.zotlet` files.

- **Parity is the rule.** `test/java.test.js` builds the Java version (skipped without a JDK) and sends the
  same API requests, exports, PDFs, style installs and word-processor sessions (GenOffice TCP, LibreOffice
  TCP, HTTP 23119, Word documents written by Zotero) to a Node and a Java server, comparing the answers
  and the resulting documents after normalizing random ids. Change both versions together and extend that test.
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
- Build: `scripts/build-java.sh` (javac, Rhino from Maven Central and citeproc from node_modules or the
  npm registry, both SHA-256 pinned) → `java/build/lib/`. `scripts/package-java.sh` → `dist/zotlet-<v>.plugin`
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
- The user wants the whole workflow **inside TBtools** (the plugin); running from a downloaded copy of
  the repository with their own Java (`start-java.command` / `start-java.sh`, which builds
  `java/build/lib/zotlet.jar` on first start or when `java/src` changed) is the alternative.
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
- Put behavior in `src/` where it is testable; keep `public/app.js` to UI wiring.
- Add or update a test with every fix; run `npm test` before committing.
- Don't commit `dist/`, `node_modules/` or anything from a real `~/.zotlet`.
- When a change is done and `npm test` passes, push it straight to `main` (the user's standing
  request); a working branch, if any, is kept in sync with `main`.
