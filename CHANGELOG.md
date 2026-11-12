# Changelog

The release workflow publishes the section of the released version as its GitHub release notes.

## Unreleased

### zotlet without Node: Java version and TBtools plugin

- zotlet now also runs on **Java 11+**, with the same page, data folder (`~/.zotlet`) and word-processor
  service (TCP 23116, HTTP 23119). Citations are formatted by the same citeproc-js, run by Rhino.
- **TBtools-II plugin** (`zotlet-<version>.plugin`): zotlet opens as a TBtools tab and runs on TBtools' own
  Java. The tab's file chooser and downloads use native Open / Save dialogs (Export, Add .csl file).
- **Stand-alone Java zip** (`zotlet-java-<version>.zip`) with `start-java.command` / `start-java.sh`.
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
