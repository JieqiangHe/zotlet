# zotlet

A tiny, local reference manager. If Zotero is more than you need, zotlet covers the basics in a
~300 KB app, built on Zotero's word-processor plugins and open formats (CSL), so your documents and
references move freely between the two. It runs on the [Node.js](https://nodejs.org) or the Java you
already have, and brings no runtime of its own.
Collect references for a project, cite them from your word processor, and export everything when you are done.

[TBtools-II](https://github.com/CJ-Chen/TBtools-II) users can use [`zotlet.plugin`](zotlet.plugin) directly:
install it with *Install Plugin* in TBtools, and zotlet runs inside TBtools as a tab, on TBtools' own Java.
Nothing else to install.

- Import by DOI or PMID, by dropping PDFs (the DOI is read from the file), or from a Zotero CSL JSON export
- Live citations and bibliographies in **GenOffice** and **LibreOffice** through the Zotero word-processor plugins
- Documents stay compatible with Zotero, so they can be refreshed in Zotero later
- Thousands of citation styles from the official CSL repository (Nature, Science and Cell are built in)
- One-click export of a project as RIS, CSL JSON and BibTeX

Everything runs on your own computer. Your library is plain JSON in `~/.zotlet/`.

> **Status:** zotlet has been tested in depth only with **GenOffice** so far.
> LibreOffice uses the same protocol but has had less real-world use.

## Getting started

You need [Node.js](https://nodejs.org) 18.17 or newer, or Java 11 or newer (see below).

- **macOS:** double-click `start-web.command`.
- **Any platform:** run `npm install`, then `npm start`.

### In TBtools (no Node needed)

Install [`zotlet.plugin`](zotlet.plugin) (also attached to each release) with *Install Plugin* in TBtools-II. Everything then happens inside
TBtools: zotlet runs on TBtools' own Java, its page opens as a TBtools tab, and GenOffice / LibreOffice cite
from it while TBtools is open. Nothing else to install.

### With your own Java

Java 11 or newer (a JDK; e.g. `brew install openjdk`) is enough, without Node:

- download the repository (or the `zotlet-java-<version>.zip` release) and double-click
  `start-java.command` on macOS, or run `./start-java.sh`. In a copy of the repository the first start
  builds zotlet (it downloads the Rhino JavaScript engine and citeproc-js once), so it needs `javac`
  and an internet connection the first time.

Citations are formatted by the same citeproc-js as in the Node version, run by Rhino. Build the plugin
and the zip with `sh scripts/package-java.sh` (set `TBTOOLS_JAR` to TBtools' main jar to compile the
plugin against it).

## Writing a paper with zotlet

1. **Make a project** for the paper in the left pane.
2. **Add references** to it:
   - click **Add references** and paste DOIs or PMIDs, or
   - drag PDFs onto the list (only the DOI is read; the PDF is not stored), or
   - drag in a CSL JSON file exported from Zotero.
3. **Cite while you write.** Quit Zotero first, keep zotlet running, and use the Zotero toolbar in GenOffice:
   - *Add/Edit Citation* pops up a search bar over your document, like Zotero's: type, press Enter to
     add a reference (repeat for more), press Enter again to insert. Esc cancels; ⌫ removes the last one.
   - *Add/Edit Bibliography* inserts the reference list; *Refresh* updates it.
   - *Document Preferences* changes the citation style.
4. **Export** when the paper is done: **Export** downloads the project (or the selected references) as one
   zip with RIS, CSL JSON and BibTeX.

Click a column header to sort the list; **Added** sorts by import time.

## Citation styles

Nature, Science and Cell are built in. To add a journal's style, click **Styles**, search for the journal and
click **Install**, or add a `.csl` file you already have. If you open a document that uses a style you
don't have, zotlet downloads it automatically.

## Moving a document to Zotero or Word

Citations are stored as standard Zotero fields with a full copy of each reference, so Zotero can open and
refresh a zotlet document. To have the references in your Zotero library too, import the exported `.ris`
file (Zotero: *File → Import…*).

Microsoft Word only talks to Zotero, not to zotlet. If the document will also be edited in Word with Zotero,
open *Document Preferences* **before inserting the first citation** and tick
*Also open in Microsoft Word with Zotero*. This stores citations as bookmarks, which both Word and
LibreOffice-style editors accept.

## Troubleshooting

- **A DOI cannot be imported.** zotlet asks doi.org first, then Crossref and PubMed. If all three fail,
  check your connection and try again; the error message names the problem.
- **The citation buttons do nothing.** Make sure zotlet is running and Zotero is closed: both use the same
  ports (23116 and 23119), and zotlet prints a warning if they are taken.
- **The citation picker opens in the browser instead of as a pop-up.** The pop-up is native on macOS;
  if it cannot start, zotlet falls back to the browser (the terminal says why). Set `ZOTLET_PICKER=web`
  to always use the browser picker.

## Command line

```bash
node zotlet.js web [--port N] [--open] [--no-word]   # start zotlet (--no-word: no word-processor service)
node zotlet.js add <DOI|PMID>...                     # import references
node zotlet.js ls [words]                            # list or search the library
```

Data lives in `~/.zotlet/`: `library.json` (references, CSL JSON), `web-state.json` (projects) and `styles/`
(downloaded styles). To keep it elsewhere, set `ZOTLET_HOME` (data then goes to `$ZOTLET_HOME/.zotlet/`).

## Development

`npm test` runs the unit, API and browser tests; `npm run package` builds a distributable zip.
With a JDK installed, `npm test` also builds the Java version (`java/src`) and checks that it answers every
API request and word-processor session exactly like the Node version (`test/java.test.js`).
The `release` GitHub Actions workflow (run by hand, or by pushing a tag `v<version>`) publishes that zip as a GitHub release,
with the version's section of [CHANGELOG.md](CHANGELOG.md) as its notes.
[CLAUDE.md](CLAUDE.md) describes the requirements and design.

## License

zotlet is an independent project, not affiliated with Zotero. It owes a lot to the
[Zotero](https://www.zotero.org) project and the [CSL](https://citationstyles.org) community, whose
plugins, styles and formats it uses — thank you.

zotlet is released under the [MIT License](LICENSE). The bundled citation styles in `styles/` and the
locale in `locales/` come from the CSL project and keep their own license (CC BY-SA 3.0).
