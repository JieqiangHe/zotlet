# zotlet

A tiny, local reference manager. If Zotero is more than you need, zotlet covers the basics: collect the
references for a paper, cite them from your word processor, and export everything when you are done.
It is built on Zotero's word-processor plugins and open formats (CSL), so your documents and references
move freely between the two. zotlet is a small Java app: it runs on the Java (11 or newer) already on your
computer and opens in your browser.

- Import by DOI or PMID, by dropping PDFs (the DOI is read from the file), or from a Zotero CSL JSON export
- Live citations and bibliographies in **GenOffice** and **LibreOffice** through the Zotero word-processor plugins
- Documents stay compatible with Zotero, so they can be refreshed in Zotero (also in Word) later
- Thousands of citation styles from the official CSL repository (Nature, Science and Cell are built in)
- One-click export of a project as RIS, CSL JSON and BibTeX

Everything runs on your own computer. Your library is plain JSON in `~/.zotlet/`, the same whether you
start zotlet yourself or in TBtools.

> **Status:** the Java version and the TBtools plugin are new in 0.2.0. Citing was first tested in depth
> with **GenOffice**; LibreOffice uses the same protocol but has had less real-world use.

## Getting started

You need Java 11 or newer (a JDK, e.g. `brew install openjdk` on macOS).

- Download this repository (or `zotlet-java-<version>.zip` from a
  [release](https://github.com/JieqiangHe/zotlet/releases)) and double-click `start-java.command` on macOS,
  or run `./start-java.sh`.
- In a copy of the repository the first start builds zotlet: it downloads the Rhino JavaScript engine and
  citeproc-js once, so it needs `javac` and an internet connection the first time.

zotlet opens in your browser at <http://127.0.0.1:23121/>. Keep the terminal window open while you work;
press `Ctrl+C` there to stop zotlet.

### As a TBtools plugin (optional)

[TBtools-II](https://github.com/CJ-Chen/TBtools-II) users can also run zotlet inside TBtools, as a tab,
on TBtools' own Java: choose *Install Plugin* and pick [`zotlet.plugin`](zotlet.plugin) (also attached to
every release), then open zotlet from TBtools' plugin menu. It runs while TBtools is open; GenOffice /
LibreOffice cite from it as usual. To update, remove the old zotlet under *Plugin → Manage Plugins*, then
install the new file.

## Writing a paper with zotlet

1. **Make a project** for the paper in the left pane.
2. **Add references** to it:
   - click **Add references** and paste DOIs or PMIDs, or
   - drag PDFs onto the list (only the DOI is read; the PDF is not stored), or
   - drag in a CSL JSON file exported from Zotero.
3. **Cite while you write.** Quit Zotero first, keep zotlet running (as a plugin: keep TBtools open), and use
   the Zotero toolbar in GenOffice:
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

- **The citation buttons do nothing.** Make sure zotlet is running (as a TBtools plugin: TBtools is open and
  the zotlet tab was opened once) and Zotero is closed: both use the same ports (23116 and 23119), and zotlet
  prints a warning if they are taken (in TBtools: in its debug log, lines starting with `zotlet:`).
- **The zotlet tab in TBtools shows a note and a button instead of the page.** TBtools' built-in browser
  could not start, so zotlet opens in your web browser instead; citing still works while TBtools is open.
  With the Intel build of TBtools on a Mac, zotlet works around a license problem of TBtools' browser; on an
  Apple-silicon Mac, the Apple-silicon build of TBtools avoids it.
- **A DOI cannot be imported.** zotlet asks doi.org first, then Crossref and PubMed. If all three fail,
  check your connection and try again; the error message names the problem.
- **The citation picker opens in the browser instead of as a pop-up.** The pop-up is native on macOS;
  if it cannot start, zotlet falls back to the browser (the log says why). Set `ZOTLET_PICKER=web`
  to always use the browser picker.

## Command line

```bash
java -jar lib/zotlet.jar web [--port N] [--open] [--no-word]   # start zotlet
java -jar lib/zotlet.jar add <DOI|PMID>...                     # import references
java -jar lib/zotlet.jar ls [words]                            # list or search the library
```

In a copy of the repository the jar is `java/build/lib/zotlet.jar` (built by `start-java.sh` or
`sh scripts/build-java.sh`).

`--no-word` starts zotlet without the word-processor service. Data lives in `~/.zotlet/`: `library.json`
(references, CSL JSON), `web-state.json` (projects) and `styles/` (downloaded styles). To keep it elsewhere,
set `ZOTLET_HOME` (data then goes to `$ZOTLET_HOME/.zotlet/`).

## Development

- `java/src/zotlet/` is zotlet (Java 11, no dependencies besides Rhino, which runs citeproc-js);
  `java/plugin/` is the TBtools plugin shell; `public/` is the page; `styles/` and `locales/` the CSL files.
- `sh scripts/build-java.sh` builds `java/build/lib/zotlet.jar`; `sh scripts/package-java.sh` builds the
  TBtools plugin (also copied to `zotlet.plugin`) and the Java zip. Set `TBTOOLS_JAR` to TBtools' main jar
  to compile the plugin against it.
- Tests: `npm test` (needs Node). zotlet started as a Node app (`zotlet.js`, `src/`), which is kept as the
  reference: `test/java.test.js` sends the same API requests and word-processor sessions to both and
  requires identical answers. The Node app still runs (`npm start`) if you prefer it.
- The `release` GitHub Actions workflow (run by hand, or by pushing a tag `v<version>`) builds the plugin and
  the zips and publishes them as a GitHub release, with the version's section of
  [CHANGELOG.md](CHANGELOG.md) as its notes.

[CLAUDE.md](CLAUDE.md) describes the requirements and design.

## License

zotlet is an independent project, not affiliated with Zotero. It owes a lot to the
[Zotero](https://www.zotero.org) project and the [CSL](https://citationstyles.org) community, whose
plugins, styles and formats it uses, and to [TBtools](https://github.com/CJ-Chen/TBtools-II), which hosts
the plugin — thank you.

zotlet is released under the [MIT License](LICENSE). The bundled citation styles in `styles/` and the
locale in `locales/` come from the CSL project and keep their own license (CC BY-SA 3.0). The Java version
and the plugin include [citeproc-js](https://github.com/Juris-M/citeproc-js) (CPAL / AGPL) and
[Rhino](https://github.com/mozilla/rhino) (MPL 2.0); see `THIRD-PARTY.txt` in the packages.
