# CLAUDE.md

Guidance for Claude (and other agents) working on zotlet. The product requirements live in
[AGENTS.md](AGENTS.md) — read them first; this file explains how the code meets them, the
conventions to keep, and what was done in the 2026-11 rebuild.

## What zotlet is

A minimal, personal reference manager: projects on the left, one reference list in the center
(no right-hand detail pane), DOI/PMID import, citeproc-js citations, CSL JSON / BibTeX / RIS export,
and live citations in Word / LibreOffice / GenOffice through the Zotero plugin protocol.
Runtime is the user's own system `node` (>= 18.17) + a static frontend. The only npm dependency is
`citeproc`. No build step, no framework, no bundled Node binary.

## Commands

```bash
npm install                      # citeproc only
npm test                         # node:test — unit, API and (if Playwright exists) browser tests
npm start                        # node zotlet.js web --open
npm run package                  # dist/zotlet-<version>.zip
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
src/integration.js Word/LibreOffice/GenOffice: Zotero plugin protocol on TCP 23116 + HTTP 23119, document session.
src/open.js        openBrowser().
public/            index.html, app.js (single ES module), style.css, theme.js (pre-paint theme), favicon.svg,
                   pick.html + pick.js (citation/style picker opened by the word processor integration).
styles/            13 independent CSL styles from the official CSL repo (CC BY-SA 3.0).
locales/           locales-en-US.xml (every style is rendered with en-US).
test/              *.test.js + helpers.js + fixtures/ (recorded Crossref and PubMed records).
scripts/package.sh builds the zip (source + launchers + node_modules/citeproc).
start-web.sh       real launcher; start-web.command just execs it (macOS double-click).
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

- **TCP 23116** (Word, LibreOffice, GenOffice): 8-byte header (transaction id, length) + JSON. A command
  arrives as id 0; zotlet then issues `Document_getFields`-style RPCs. LibreOffice is detected from the
  peer process (`/proc` on Linux, `lsof` on macOS) and gets the newer data format.
- **HTTP 23119** (`/connector/document/execCommand` + `respond`): each response carries the next RPC.
- Commands: `addEditCitation`, `addEditBibliography`, `refresh`, `setDocPrefs`, `removeCodes`.
  Field codes are Zotero's (`ITEM CSL_CITATION {…}`, `BIBL … CSL_BIBLIOGRAPHY`), so documents stay
  compatible with Zotero. Refresh uses the library copy of an item when its id is in the library,
  else the embedded `itemData`. `itemURI()` must not change: existing documents contain those URIs.
- Picking happens in the browser: `server.pick(spec)` opens `/pick.html?id=…` and waits for
  `POST /api/pick/done` (closing the tab cancels; 30 min timeout). The old native `picker.jxa` never
  existed in the repo, so don't reintroduce it.
- A busy port (Zotero running) only prints a warning; the web app still starts.

## UI conventions

- Look: light gray canvas (`--bg`), white panels, 1px borders, 4px radius (6px panels/menus),
  12px base font, 28px controls, 30px rows, 44px top bar. Every color is a CSS variable in `:root`
  and overridden in `:root[data-theme="dark"]` — never hard-code colors in rules.
- Top bar order is fixed by the spec: brand, New, Search, Style selector, Bibliography, Export,
  (spacer), theme toggle. `test/ui.test.js` asserts this order.
- The brand block is 212px wide so **New** lines up with the left edge of the list panel
  (sidebar 220px + 12px gutter). Keep those numbers in sync if you change the sidebar width.
- Project actions are three direct buttons at the bottom of the sidebar; Rename/Delete are disabled
  when no project is selected. No overflow menus for them (they can get clipped).
- Bibliography/Export scope: the selection if any, else everything currently visible (library,
  project, or search results). Always label the scope in the UI.
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
- `fetch()` cannot override `Host`; the Host-header test uses `http.get`.
- Playwright is loaded with `createRequire` and the browser tests skip themselves when it is absent.
  After any UI change, run them with `ZOTLET_SCREENSHOTS` and look at the PNGs (light, dark, dialogs,
  700px-wide window). The narrow test asserts there is no horizontal overflow.
- Every bundled style is rendered in `citations.test.js`; add a new style to `styles/` and that test
  covers it automatically. Dependent styles are skipped by `listStyles`.

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
