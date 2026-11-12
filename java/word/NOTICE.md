# Word templates from Zotero

`mac/Zotero.dotm`, `mac/Zotero.scpt` and `win/Zotero.dotm` are Zotero's Word templates, unchanged.
They add the Zotero tab to Microsoft Word; its buttons call zotlet the way they call Zotero
(see `java/src/zotlet/Word.java`). They are part of Zotero (https://www.zotero.org) and licensed
under the GNU General Public License, version 3 or later; their source is at

- https://github.com/zotero/zotero-word-for-mac-integration (`install/`, `build/template/`), commit aca763f6f429b1027a79195fa69ac75d423f2210
- https://github.com/zotero/zotero-word-for-windows-integration (`install/`, `build/template/`), commit d35757038a4bbb323a706ab6dc6b69c1c94c3dc7

`word-mac.js` and `word-win.ps1` are zotlet's own (MIT); they follow the behaviour of Zotero's
`build/src/*.m` (Mac) and `build/zoteroWinWordIntegration/*.cpp` (Windows) in those repositories.
