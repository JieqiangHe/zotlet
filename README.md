# zotlet

A minimal, personal reference manager.

Collect references for a paper, cite them while you write, export everything when you are done. Everything runs locally.

**Run** — requires Node.js 18.17+: double-click `start-web.command` (macOS), or `npm install && npm start`. The app opens at <http://127.0.0.1:23121/>; `Ctrl+C` in the terminal stops it.

**1. Collect** — make a project per paper (left pane). Add references with **New** (DOI / PMID), or drag PDFs onto the list (zotlet reads the DOI inside; the PDF is not kept), or drag a CSL JSON file exported from Zotero.

**2. Cite** — quit Zotero, keep zotlet running, and use the Zotero buttons in GenOffice or LibreOffice: *Add/Edit Citation* opens a picker tab (search, click, Enter); *Add/Edit Bibliography*, *Refresh*, *Document Preferences* (style) work as in Zotero. **Styles** in the top bar downloads more styles (~10,000 journals, like Zotero).

**3. Export** — **Export** downloads the current project (or your selection) as one zip: RIS, CSL JSON and BibTeX, with a note on importing into Zotero.

**Moving to Zotero / Word** — documents use Zotero's own field codes and carry a full copy of each cited reference, so Zotero can open and refresh them; import the exported `.ris` into Zotero to have the references there too. Microsoft Word talks only to Zotero, not to zotlet. If a document will also be edited in Word with Zotero, tick *Also open in Microsoft Word with Zotero* in *Document Preferences* **before the first citation** (citations are then stored as bookmarks, which both Word and LibreOffice-type editors accept).

**Data** lives in `~/.zotlet/` (`library.json`: references as CSL-JSON; `web-state.json`: projects; `styles/`: downloaded styles). Start with `--no-word` to turn the word-processor service off.

**Develop**: `npm test` runs the tests, and `npm run package` builds a zip. [CLAUDE.md](CLAUDE.md) covers the requirements and design.
