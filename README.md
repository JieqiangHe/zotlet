# zotlet

A minimal, personal reference manager · 极简的个人文献管理器

[English](#english) · [中文](#中文)

## English

Collect references for a paper, cite them while you write, export everything when you are done. Everything runs locally.

**Run** — requires Node.js 18.17+: double-click `start-web.command` (macOS), or `npm install && npm start`. The app opens at <http://127.0.0.1:23121/>; `Ctrl+C` in the terminal stops it.

**1. Collect** — make a project per paper (left pane). Add references with **New** (DOI / PMID), or drag PDFs onto the list (zotlet reads the DOI inside; the PDF is not kept), or drag a CSL JSON file exported from Zotero.

**2. Cite** — quit Zotero, keep zotlet running, and use the Zotero buttons in GenOffice or LibreOffice: *Add/Edit Citation* opens a picker tab (search, click, Enter); *Add/Edit Bibliography*, *Refresh*, *Document Preferences* (style) work as in Zotero. **Styles** in the top bar downloads more styles (~10,000 journals, like Zotero).

**3. Export** — **Export** downloads the current project (or your selection) as one zip: RIS, CSL JSON and BibTeX, with a note on importing into Zotero.

**Moving to Zotero / Word** — documents use Zotero's own field codes and carry a full copy of each cited reference, so Zotero can open and refresh them; import the exported `.ris` into Zotero to have the references there too. Microsoft Word talks only to Zotero, not to zotlet. If a document will also be edited in Word with Zotero, tick *Also open in Microsoft Word with Zotero* in *Document Preferences* **before the first citation** (citations are then stored as bookmarks, which both Word and LibreOffice-type editors accept).

**Data** lives in `~/.zotlet/` (`library.json`: references as CSL-JSON; `web-state.json`: projects; `styles/`: downloaded styles). Start with `--no-word` to turn the word-processor service off.

**Develop**: `npm test`, `npm run package`. [CLAUDE.md](CLAUDE.md) covers the design, [AGENTS.md](AGENTS.md) the requirements.

## 中文

为一篇文章收集文献，写作时插入引用，写完一次性导出全部文献。全部在本机运行。

**运行**（需要 Node.js 18.17+）：macOS 双击 `start-web.command`，或 `npm install && npm start`。浏览器会打开 <http://127.0.0.1:23121/>，在终端按 `Ctrl+C` 停止。

**1. 收集**：每篇文章建一个项目（左栏）。用 **New** 输入 DOI / PMID；或把 PDF 拖进列表（读出 DOI 后导入，不保存 PDF）；或拖入从 Zotero 导出的 CSL JSON 文件。

**2. 引用**：先退出 Zotero，保持 zotlet 运行，在 GenOffice 或 LibreOffice 里用 Zotero 的按钮：*Add/Edit Citation* 会打开选择页（搜索、点选、回车）；*Add/Edit Bibliography*、*Refresh*、*Document Preferences*（选样式）和 Zotero 用法一样。顶栏的 **Styles** 可以下载更多样式（约一万个期刊，和 Zotero 一样）。

**3. 导出**：点 **Export**，把当前项目（或选中的文献）下载成一个 zip，里面有 RIS、CSL JSON、BibTeX，以及导入 Zotero 的说明。

**转到 Zotero / Word**：文档里用的是 Zotero 自己的域代码，并且每条引用都带有完整的文献数据，所以 Zotero 能直接打开并刷新；把导出的 `.ris` 导入 Zotero，文献也就在 Zotero 里了。Microsoft Word 只能和 Zotero 通信，不能直接连 zotlet。如果文档之后还要在 Word 里用 Zotero 编辑，请在**插入第一条引用之前**，到 *Document Preferences* 勾选 *Also open in Microsoft Word with Zotero*（引用会以书签形式保存，Word 和 LibreOffice 类编辑器都能识别）。

**数据**在 `~/.zotlet/`：`library.json`（CSL-JSON 文献）、`web-state.json`（项目）、`styles/`（下载的样式）。用 `--no-word` 启动可关闭文字处理器服务。

**开发**：`npm test` 跑测试，`npm run package` 打包。设计见 [CLAUDE.md](CLAUDE.md)，需求见 [AGENTS.md](AGENTS.md)。
