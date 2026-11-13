# zotlet

A tiny, local reference manager. If Zotero is more than you need, zotlet covers the basics: collect the
references for a paper, cite them from your word processor, and export everything when you are done.
It is built on Zotero's word-processor plugins and open formats (CSL), so your documents and references
move freely between the two. zotlet is a small Java app: it runs on the Java (11 or newer) already on your
computer and opens in your browser.

- Import by DOI or PMID, by dropping PDFs (the DOI is read from the file), or from a Zotero CSL JSON export
- Chinese literature without a plugin: references from CNKI (知网), Wanfang (万方) and VIP (维普), and the
  GB/T 7714 styles with 等 / et al. chosen per reference
- Live citations and bibliographies in **Microsoft Word** (macOS, Windows), **GenOffice** and **LibreOffice**
  through Zotero's word-processor plugins — Zotero itself does not need to be installed
- Documents stay compatible with Zotero, so they can be refreshed in Zotero later
- Thousands of citation styles from the official CSL repository (Nature, Science, Cell and GB/T 7714 are built in)
- One-click export of a project as RIS, CSL JSON and BibTeX

Everything runs on your own computer. Your library is plain JSON in `~/.zotlet/`, the same whether you
start zotlet yourself or in TBtools.

> **Status:** citing was first tested in depth with **GenOffice**. The Java version and the TBtools plugin
> are new in 0.2; Microsoft Word support is new and has had little real-world use yet.

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
   - Chinese literature: see [Chinese literature](#chinese-literature-中文文献) below.
3. **Cite while you write.** Quit Zotero first, keep zotlet running (as a plugin: keep TBtools open), and use
   the Zotero toolbar (or, in Word, the Zotero tab):
   - *Add/Edit Citation* pops up a search bar over your document, like Zotero's: type, press Enter to
     add a reference (repeat for more), press Enter again to insert. Esc cancels; ⌫ removes the last one.
   - *Add/Edit Bibliography* inserts the reference list; *Refresh* updates it.
   - *Document Preferences* changes the citation style.
4. **Export** when the paper is done: **Export** downloads the project (or the selected references) as one
   zip with RIS, CSL JSON and BibTeX.

Click a column header to sort the list; **Added** sorts by import time.

## Citation styles

Nature, Science, Cell and GB/T 7714—2015 (numeric and author-date, bilingual) are built in. To add a journal's style, click **Styles**, search for the journal and
click **Install**, or add a `.csl` file you already have. If you open a document that uses a style you
don't have, zotlet downloads it automatically.

## Chinese literature (中文文献)

Zotero needs the Jasminum (茉莉花) plugin for Chinese references; zotlet has the parts you need for citing built in:

- **Getting references from CNKI (知网), Wanfang (万方) or VIP (维普).** Select the articles there, choose
  导出 / 导出与分析, and either
  - copy the reference text it shows (GB/T 7714, e.g. `[1]张三,李四.题名[J].园艺学报,2020,47(3):12-18.`) and
    paste it under **Add references**, or
  - export as **EndNote**, **RefWorks** or **NoteExpress** and drop the downloaded file on the list
    (RIS and BibTeX files from any database work the same way; older files in GBK are read too).
- **Names.** 张三 is stored as family 张, given 三 (compound surnames such as 欧阳 are recognised), so styles
  print and sort Chinese names properly; reference ids use pinyin (`zhang2020`).
- **Language.** References with a Chinese title are marked `zh-CN`. The built-in **GB/T 7714** styles use
  this to write 等 after Chinese authors and et al. after English ones, in the same bibliography.
- A reference without a DOI counts as already in your library when one with the same title and year is there.

zotlet does not search CNKI by itself (CNKI has no public interface and blocks automated requests), and it
does not read a DOI from CNKI's own PDFs when they carry none: use the export above for those.

## Microsoft Word

zotlet puts Zotero's Word template into Word when it starts (it does nothing if the Zotero tab is already
there, e.g. from Zotero). Restart Word once; the **Zotero** tab then talks to zotlet whenever zotlet runs and
Zotero does not. The buttons work as in GenOffice; notes and annotations are not supported.

- **macOS** asks once whether zotlet (or Terminal / TBtools) may control Microsoft Word: allow it. On macOS 15
  and later, if the template cannot be copied, Finder opens the template and Word's startup folder: drag
  `Zotero.dotm` into the folder, then restart Word. `java -jar lib/zotlet.jar word-install` does the same step again.
- **Windows** needs nothing else (zotlet uses the PowerShell that comes with Windows).

## Moving a document to Zotero

Citations are stored as standard Zotero fields with a full copy of each reference, so Zotero can open and
refresh a zotlet document. To have the references in your Zotero library too, import the exported `.ris`
file (Zotero: *File → Import…*).

A document started in GenOffice or LibreOffice that will also be edited in Word: open *Document Preferences*
**before inserting the first citation** and tick *Also open in Microsoft Word with Zotero*. This stores
citations as bookmarks, which both Word and LibreOffice-style editors accept.

## Troubleshooting

- **Word on a Mac, zotlet as a TBtools plugin: the buttons do nothing, or a message says zotlet cannot control
  Word.** macOS lets an application control Word only after asking you, and it does not ask for TBtools.
  Quit TBtools, start zotlet with `start-java.command`, and click the button in Word again: macOS asks once
  whether Terminal may control Microsoft Word. After that TBtools can be opened again (its zotlet tab uses
  the zotlet that is already running). LibreOffice and GenOffice are not affected.
- **Word: something goes wrong.** Details are in `~/.zotlet/word.log`; please send it with a report.
- **The citation buttons do nothing.** Make sure zotlet is running (as a TBtools plugin: TBtools is open and
  the zotlet tab was opened once) and Zotero is closed: both use the same ports (23116 and 23119), and zotlet
  prints a warning if they are taken (in TBtools: in its debug log, lines starting with `zotlet:`).
- **The zotlet tab in TBtools shows a note and a button instead of the page.** TBtools' built-in browser
  could not start, so zotlet opens in your web browser instead; citing still works while TBtools is open.
  With the Intel build of TBtools on a Mac, zotlet works around a license problem of TBtools' browser; on an
  Apple-silicon Mac, the Apple-silicon build of TBtools avoids it.
- **A DOI cannot be imported.** zotlet asks doi.org first, then Crossref and PubMed. If all three fail,
  check your connection and try again; the error message names the problem.
- **Choosing references: the pop-up.** Add/Edit Citation opens a small launcher-style window over your word
  processor (Word, LibreOffice, GenOffice; macOS, Windows and Linux), light or dark like your system: type to
  search, Enter adds the highlighted reference, Enter again inserts, ⌫ removes the last one (or click its
  chip), Esc cancels. On Windows, click the pop-up once if it does not take the keyboard by itself. Only when
  no window can be shown (a computer without a screen) zotlet opens the picker in the browser; the log says
  why. On a Mac the pop-up is the macOS one; `ZOTLET_PICKER=window` uses Java's own pop-up there too,
  `ZOTLET_PICKER=web` always uses the browser picker, `ZOTLET_PICKER_THEME=dark|light` fixes its colours.

## Command line

```bash
java -jar lib/zotlet.jar web [--port N] [--open] [--no-word]   # start zotlet
java -jar lib/zotlet.jar add <DOI|PMID>...                     # import references
java -jar lib/zotlet.jar ls [words]                            # list or search the library
java -jar lib/zotlet.jar word-install                          # put the Zotero tab into Microsoft Word
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
- `npm test` runs the tests (Node is used for testing only): end-to-end checks of the API, exports and
  word-processor sessions against recorded answers, Word sessions through a stand-in for Word, the TBtools
  plugin packaged and loaded as TBtools does, browser tests with Playwright, and unit checks.
- Setting up a machine, packaging and releasing are described step by step in
  [`.claude/skills/zotlet-package/SKILL.md`](.claude/skills/zotlet-package/SKILL.md) (also usable by coding agents).
- The `release` GitHub Actions workflow (run by hand, or by pushing a tag `v<version>`) builds the plugin and
  the zip and publishes them as a GitHub release, with the version's section of
  [CHANGELOG.md](CHANGELOG.md) as its notes.

[CLAUDE.md](CLAUDE.md) describes the requirements and design.

## License

zotlet is an independent project, not affiliated with Zotero. It owes a lot to the
[Zotero](https://www.zotero.org) project and the [CSL](https://citationstyles.org) community, whose
plugins, styles and formats it uses, and to [TBtools](https://github.com/CJ-Chen/TBtools-II), which hosts
the plugin — thank you.

zotlet is released under the [MIT License](LICENSE). The bundled citation styles in `styles/` and the
locales in `locales/` come from the CSL project (the two GB/T 7714 styles from the Zotero Chinese community,
zotero-chinese/styles) and keep their own license (CC BY-SA 3.0). zotlet includes
[citeproc-js](https://github.com/Juris-M/citeproc-js) (CPAL / AGPL), [Rhino](https://github.com/mozilla/rhino)
(MPL 2.0) and Zotero's Word templates (GPL 3 or later, `java/word/NOTICE.md`); see `THIRD-PARTY.txt` in the packages.
