# zotlet

A minimal, personal reference manager · 极简的个人文献管理器

[English](#english) · [中文](#中文)

## English

Organize references by project, import by DOI / PMID, generate citations with citeproc-js (Nature, Science, Cell, APA, Vancouver, IEEE …), and export CSL JSON, BibTeX or RIS. Everything runs locally.

**Run** — requires Node.js 18.17+:

- macOS: double-click `start-web.command`
- Or: `npm install && npm start`

The app opens at <http://127.0.0.1:23121/>. Press `Ctrl+C` in the terminal to stop it.

**Data** lives in `~/.zotlet/`: `library.json` holds the references as CSL-JSON, and `web-state.json` holds the projects. To add more citation styles, put `.csl` files in `~/.zotlet/styles/`.

**Develop**: `npm test` runs the tests, and `npm run package` builds a zip. [CLAUDE.md](CLAUDE.md) covers the design, and [AGENTS.md](AGENTS.md) the requirements.

## 中文

按项目整理文献，用 DOI / PMID 导入，用 citeproc-js 生成引文（Nature、Science、Cell、APA、Vancouver、IEEE 等），并导出 CSL JSON、BibTeX、RIS。全部在本机运行。

**运行**（需要 Node.js 18.17+）：

- macOS：双击 `start-web.command`
- 或者：`npm install && npm start`

浏览器会打开 <http://127.0.0.1:23121/>，在终端按 `Ctrl+C` 停止。

**数据**存放在 `~/.zotlet/`：`library.json` 是 CSL-JSON 格式的文献库，`web-state.json` 存项目。想加更多引文样式，把 `.csl` 文件放进 `~/.zotlet/styles/`。

**开发**：`npm test` 跑测试，`npm run package` 打包 zip。设计说明见 [CLAUDE.md](CLAUDE.md)，需求见 [AGENTS.md](AGENTS.md)。
