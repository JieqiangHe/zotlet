# Changelog

The release workflow publishes the section of the released version as its GitHub release notes.

## 0.5.0 — 2026-11-14

- Word on a Mac now uses plain AppleScript, with the document session handled in Java. It no longer
  starts the JavaScript for Automation (JXA) Word helper that stopped with `exit 139` on the reported Mac.
  Windows continues to use its PowerShell helper; Zotero's Word templates and document format are unchanged.
- Each Mac command keeps the document and insertion position chosen before the citation pop-up opens.
  Switching to another document while choosing references cannot redirect the insertion there. If the
  original document is closed or renamed, the command stops and asks you to click the Word button again.
- Rich-text paste saves the clipboard first and restores it on both success and a Word error, along with
  Word's smart-paste setting. Track Changes and field/revision display settings are restored when a command
  finishes or fails. Unlinking several citations keeps the remaining field positions correct.
- The Mac adapter has automated checks for AppleScript result parsing, fields/bookmarks, document binding,
  state recovery, and the Word toolbar's complete citation/bibliography flow through a stand-in for osascript.
  These checks ran on Linux; the new AppleScript still needs verification with Word on a Mac.

## 0.4.1 — 2026-11-13

- The citation pop-up: no grey see-through frame around it, no bottom bar (an Insert button next to the chosen references), more compact, and references can be chosen with
  the mouse: a click adds one (click again to take it out), a double click inserts.
- Citing is quicker on a Mac: the pop-up opens at once (zotlet no longer tries the older macOS pop-up first,
  which did not start on some Macs, and prepares the window when it starts).
- Word on a Mac: when the helper that controls Word stops, the message and `~/.zotlet/word.log` now say why.

## 0.4.0 — 2026-11-13

- **Chinese literature without a plugin** (what Zotero needs Jasminum / 茉莉花 for): paste the GB/T 7714
  reference text that CNKI (知网), Wanfang or VIP show, or drop their EndNote / RefWorks / NoteExpress export
  (also RIS and BibTeX files from anywhere). Chinese names are split into family and given name, references
  with a Chinese title are marked `zh-CN`, and ids use pinyin (`zhang2020`).
- **GB/T 7714—2015 is built in** (numeric and author-date, the bilingual styles of the Zotero Chinese
  community): 等 after Chinese authors, et al. after English ones.
- **A real pop-up for choosing references on Windows and Linux** (and as the second choice on macOS, if the
  macOS one cannot start): a launcher-style window over Word, LibreOffice or GenOffice, light or dark like
  the system, with the same keys as on the Mac, instead of a browser window. The browser picker is only used
  when no window can be shown.
- Word on a Mac: when a button cannot be carried out, zotlet now says so in a message (before, nothing
  happened), and explains what to do when it runs inside TBtools, which macOS does not let control Word.
- New and not yet in daily use: the pop-up was checked on Linux only (on Windows it may need one click before
  it takes the keyboard), and the CNKI formats were checked against samples written by hand. If an export
  of yours is not read correctly, please send the file with a report.

## 0.3.0 — 2026-11-12

- **Microsoft Word** (macOS and Windows) without Zotero: zotlet puts Zotero's Word template into Word and
  answers its Zotero tab — Add/Edit Citation, Bibliography, Refresh, Document Preferences, Unlink — through
  Word's own scripting (AppleScript on macOS, COM via the PowerShell that comes with Windows). Documents stay
  Zotero documents (Word fields), so Zotero can open them too. New command: `zotlet word-install`.
- Word support is new: it was checked against a stand-in for Word, not yet in daily use. If something goes
  wrong, `~/.zotlet/word.log` has the details — please send it with a report.
- The TBtools plugin is now packaged and loaded the way TBtools does in the tests (start, closed class
  loader, second tab, reinstall, licence work-around, fallback panel).
- Building, testing and releasing are written down as a skill (`.claude/skills/zotlet-package`).

## 0.2.1 — 2026-11-12

- zotlet is now Java only: the Node version (`zotlet.js`, `src/`, `start-web.command`) is removed. Its
  behaviour is kept as recorded answers that the tests check the Java version against.
- TBtools plugin: removing or reinstalling the plugin while TBtools is open no longer leaves a broken zotlet
  behind; opening the new plugin takes over. `start-java` no longer opens a broken zotlet that is still
  running in TBtools; it says to quit TBtools first.

## 0.2.0 — 2026-11-12

zotlet without Node: it now also runs on Java, and as a plugin in TBtools.

### Use it in TBtools

- **TBtools-II plugin** (`zotlet.plugin`, also attached as `zotlet-0.2.0.plugin`): install it with
  *Install Plugin* and zotlet opens as a TBtools tab, running on TBtools' own Java. GenOffice and
  LibreOffice cite from it while TBtools is open. Export and *Add .csl file* use native Save / Open dialogs.
- Works around TBtools' browser license on Macs with the Intel build of TBtools (it picks the Apple-silicon
  key on every Mac, so the built-in browser refused to start); if TBtools' browser still cannot start,
  zotlet opens in your web browser and keeps running inside TBtools.

### Or with your own Java

- zotlet runs on **Java 11+** with the same page, data folder (`~/.zotlet`) and word-processor service
  (TCP 23116, HTTP 23119). Citations are formatted by the same citeproc-js, run by Rhino.
- Download the repository (or `zotlet-java-0.2.0.zip`) and double-click `start-java.command`, or run
  `./start-java.sh`; in a copy of the repository the first start builds zotlet.
- Every API answer, export file and word-processor session (GenOffice, LibreOffice, the HTTP protocol, and
  Word documents written by Zotero) is checked against the Node version by the test suite.

## 0.1.0 — 2026-11-05

The first release of zotlet: a tiny, local reference manager. If Zotero is more than you need, zotlet
covers the basics in a ~300 KB app, built on Zotero's word-processor plugins and open formats (CSL), so your
documents and references move freely between the two. It does need [Node.js](https://nodejs.org) (about
100 MB installed), which many people already have; zotlet uses that one and brings no runtime of its own.
Collect references for a project, cite them from your word processor, and export everything when you are done.

### Collect references

- **Projects** in the left pane (`+ New`, `Rename`, `Delete`), one per paper; a reference can be in any
  number of projects.
- **Import by DOI or PMID**: paste one or many at once. zotlet asks doi.org, then Crossref and PubMed,
  and cleans the author data, so Elsevier DOIs and similar import without validation errors.
- **Drop PDFs** on the list: the DOI is read from the file and the reference imported (the PDF itself
  is not stored).
- **Drop a CSL JSON file** exported from Zotero to bring an existing collection over.
- Search (`/`), sortable columns (Title, Authors, Year, Journal, Added), duplicate detection, and an
  edit dialog (double-click or Enter).

### Cite while you write

- Live citations and bibliographies in **GenOffice** and **LibreOffice** through the Zotero
  word-processor plugins: Add/Edit Citation, Add/Edit Bibliography, Refresh, Document Preferences.
  Quit Zotero first; zotlet uses the same ports (23116, 23119).
- On macOS the citation picker is a native pop-up over the document, like Zotero's quick format bar;
  elsewhere it opens in the browser.
- Documents stay **compatible with Zotero**: citations are Zotero fields with a full copy of each
  reference, so Zotero (also in Word, when *Also open in Microsoft Word with Zotero* is ticked before the
  first citation) can open and refresh them.

### Citation styles

- Nature, Science and Cell are built in. Under **Styles**, search and install any of the thousands of
  styles in the official CSL repository, or add your own `.csl` file.
- If a document uses a style you don't have, zotlet downloads it instead of silently switching styles.

### Export

- **Export** downloads the selection, project or whole library as one zip with **RIS**, **CSL JSON** and
  **BibTeX** (importable into Zotero).

### Look and running it

- Compact two-pane interface with light and dark themes (the choice is remembered).
- Runs on your own computer with your own Node.js (18.17 or newer, about 100 MB); nothing else to install. On macOS,
  double-click `start-web.command`; elsewhere run `start-web.sh` or `npm start`. zotlet opens in the browser
  at <http://127.0.0.1:23121/>.
- Your library is plain JSON in `~/.zotlet/`.

> zotlet has been tested in depth with GenOffice so far; LibreOffice uses the same protocol but has had
> less real-world use.

zotlet is an independent project, not affiliated with Zotero; thanks to the Zotero project and the CSL
community, whose plugins, styles and formats it uses. zotlet is MIT licensed; the bundled CSL styles and
locale stay CC BY-SA 3.0.
