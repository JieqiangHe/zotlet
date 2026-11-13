# zotlet

A tiny local reference manager, for when Zotero is more than you need: collect the references for a paper,
cite them while you write, export them when you are done. It runs on the Java already on your computer and
opens in your browser. Your library is plain JSON in `~/.zotlet/`; nothing is uploaded.

- Import by DOI or PMID, by dropping PDFs, from CNKI / Wanfang / VIP exports, or from Zotero (CSL JSON)
- Live citations in **Word** (macOS, Windows), **GenOffice** and **LibreOffice** through Zotero's own
  plugins, without Zotero installed; documents stay Zotero documents
- Nature, Science, Cell and GB/T 7714—2015 built in; thousands more under **Styles**
- One-click export as RIS, BibTeX and CSL JSON

**Download: [latest release](https://github.com/JieqiangHe/zotlet/releases/latest)**: unzip
`zotlet-java-<version>.zip` and double-click `start-java.command` (macOS) or run `./start-java.sh`. Needs Java 11+
(e.g. `brew install openjdk`). Keep the terminal window open while you work.

[TBtools-II](https://github.com/CJ-Chen/TBtools-II) users can use [`zotlet.plugin`](zotlet.plugin) directly
(*Install Plugin*), and zotlet opens as a TBtools tab.

## Citing

Quit Zotero, keep zotlet running, and use the Zotero toolbar in your word processor. **Add/Edit Citation** opens
a small pop-up: type to search, click references to choose them (or Enter), then **Insert**. Word gets the
Zotero tab from zotlet automatically; restart Word once, and on a Mac allow it to control Word when asked.

If something does not work, `~/.zotlet/word.log` and the terminal window say why; please send them with a report.

## License

MIT. Bundled CSL styles and locales: CC BY-SA 3.0; citeproc-js: CPAL / AGPL; Rhino: MPL 2.0; Zotero's Word
templates: GPL 3+. zotlet is independent of, and grateful to, [Zotero](https://www.zotero.org),
[CSL](https://citationstyles.org) and [TBtools](https://github.com/CJ-Chen/TBtools-II).
Development and releases: [CLAUDE.md](CLAUDE.md), [`.claude/skills/zotlet-package`](.claude/skills/zotlet-package/SKILL.md).
