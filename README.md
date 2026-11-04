# zotlet

A minimal, personal reference manager · 极简的个人文献管理器

[English](#english) · [中文](#中文)

## English

Organize references by project, import by DOI / PMID, generate citations with citeproc-js (Nature, Science, Cell, APA, Vancouver, IEEE …), and export CSL JSON, BibTeX or RIS. Everything runs locally.

**Run** — requires Node.js 18.17+:

- macOS: double-click `start-web.command`
- Or: `npm install && npm start`

The app opens at <http://127.0.0.1:23121/>. Press `Ctrl+C` in the terminal to stop it.

**Cite in Word, LibreOffice and GenOffice** — zotlet answers the Zotero word-processor plugin (it listens on Zotero's ports 23116 and 23119, so quit Zotero first). Keep zotlet running and use the plugin's *Add/Edit Citation*, *Add/Edit Bibliography*, *Refresh*, *Document Preferences* and *Unlink Citations* buttons. *Add/Edit Citation* opens a picker tab in your browser: search, click the references, press Enter, then switch back to your document. Start with `--no-word` to turn this off.

**Data** lives in `~/.zotlet/`: `library.json` holds the references as CSL-JSON, and `web-state.json` holds the projects. To add more citation styles, put `.csl` files in `~/.zotlet/styles/`.

**Develop**: `npm test` runs the tests, and `npm run package` builds a zip. [CLAUDE.md](CLAUDE.md) covers the design, and [AGENTS.md](AGENTS.md) the requirements.

## 中文

按项目整理文献，用 DOI / PMID 导入，用 citeproc-js 生成引文（Nature、Science、Cell、APA、Vancouver、IEEE 等），并导出 CSL JSON、BibTeX、RIS。全部在本机运行。

**运行**（需要 Node.js 18.17+）：

- macOS：双击 `start-web.command`
- 或者：`npm install && npm start`

浏览器会打开 <http://127.0.0.1:23121/>，在终端按 `Ctrl+C` 停止。

**在 Word、LibreOffice、GenOffice 中引用**：zotlet 兼容 Zotero 的文字处理器插件（监听 Zotero 的 23116 和 23119 端口，所以请先退出 Zotero）。保持 zotlet 运行，在插件里使用 *Add/Edit Citation*、*Add/Edit Bibliography*、*Refresh*、*Document Preferences*、*Unlink Citations*。点 *Add/Edit Citation* 会在浏览器里打开一个选择页：搜索、点选文献、按回车，然后切回文档即可。用 `--no-word` 启动可关闭此功能。

**数据**存放在 `~/.zotlet/`：`library.json` 是 CSL-JSON 格式的文献库，`web-state.json` 存项目。想加更多引文样式，把 `.csl` 文件放进 `~/.zotlet/styles/`。

**开发**：`npm test` 跑测试，`npm run package` 打包 zip。设计说明见 [CLAUDE.md](CLAUDE.md)，需求见 [AGENTS.md](AGENTS.md)。
