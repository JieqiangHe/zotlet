# zotlet

A minimal, personal reference manager.

Collect references for a paper, cite them while you write, export everything when you are done. Everything runs locally.

**Run** — requires Node.js 18.17+: double-click `start-web.command` (macOS), or `npm install && npm start`. The app opens at <http://127.0.0.1:23121/>; `Ctrl+C` in the terminal stops it.

**1. Collect** — make a project per paper (left pane). Use **Add references** (DOI / PMID), drag PDFs onto the list (zotlet reads the DOI inside; the PDF is not kept), or drag in a CSL JSON file exported from Zotero. If doi.org / Crossref cannot be reached, zotlet looks the DOI up in PubMed. Click a column header to sort, including **Added** (import time).

**2. Cite** — quit Zotero, keep zotlet running, and use the Zotero buttons in GenOffice or LibreOffice: *Add/Edit Citation* pops up a picker window (search, click, Enter) and returns you to your document; *Add/Edit Bibliography*, *Refresh*, *Document Preferences* (style) work as in Zotero. The picker is a separate pop-up window when Chrome, Edge, Brave, Chromium or Vivaldi is installed; otherwise it opens as a browser tab. Nature, Science and Cell are built in; **Styles** in the top bar downloads any other style (~10,000 journals, like Zotero). A document that uses a style you don't have gets it downloaded automatically.

So far zotlet has only been tested in depth with **GenOffice**. LibreOffice uses the same Zotero plugin protocol but has had less real-world testing.

**3. Export** — **Export** downloads the current project (or your selection) as one zip: RIS, CSL JSON and BibTeX, with a note on importing into Zotero.

**Moving to Zotero / Word** — documents use Zotero's own field codes and carry a full copy of each cited reference, so Zotero can open and refresh them; import the exported `.ris` into Zotero to have the references there too. Microsoft Word talks only to Zotero, not to zotlet. If a document will also be edited in Word with Zotero, tick *Also open in Microsoft Word with Zotero* in *Document Preferences* **before the first citation** (citations are then stored as bookmarks, which both Word and LibreOffice-type editors accept).

**Data** lives in `~/.zotlet/` (`library.json`: references as CSL-JSON; `web-state.json`: projects; `styles/`: downloaded styles). Start with `--no-word` to turn the word-processor service off.

**Develop**: `npm test` runs the tests, and `npm run package` builds a zip. [CLAUDE.md](CLAUDE.md) covers the requirements and design.
