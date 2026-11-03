# zotlet

一个极简的个人文献管理器。按「项目」整理文献，粘贴 DOI / PMID 一键导入，用 citeproc-js 生成规范的引文和参考文献表，并导出 CSL JSON、BibTeX、RIS。

全部在本机运行：一个 Node.js 小服务器加一个静态网页，数据就是你电脑上的两个 JSON 文件。

---

## 快速开始

需要系统里已装好 **Node.js 18.17 或更新版本**（`node --version` 查看）。没有的话去 [nodejs.org](https://nodejs.org) 下载，或 `brew install node`。

**macOS**：解压后双击 `start-web.command`。

终端窗口会显示服务器日志，浏览器自动打开 <http://127.0.0.1:23121/>。用完在终端里按 `Ctrl+C` 停止；窗口不会被强制关闭，方便你看输出。

> 第一次双击如果提示「无法验证开发者」，在 Finder 里右键 → 打开 即可。

**Linux / 从源码运行**：

```bash
npm install
```

```bash
npm start
```

或者 `./start-web.sh`。如果 23121 端口被占用，可以 `node zotlet.js web --port 8080 --open`。再次双击启动器时如果 zotlet 已在运行，它只会打开浏览器，不会重复启动。

## 怎么用

| 想做的事 | 操作 |
| --- | --- |
| 导入文献 | 顶栏 **New** → 粘贴任意数量的 DOI、doi.org 链接、PMID 或 PubMed 链接（换行、空格、逗号分隔都行）→ **Import**。每条显示 ✓ 已添加 / • 已存在 / ✕ 失败原因 |
| 手动录入 | **New** → **Manual entry** |
| 编辑 | 双击一行，或选中后按 `Enter` / 点 **Edit**。引用键（ID）永远不变 |
| 新建 / 重命名 / 删除项目 | 左栏底部的 **+ New**、**Rename**、**Delete** 按钮。删除项目不会删除文献 |
| 把文献放进项目 | 选中后点 **Add to project**，或直接把行拖到左侧项目上。在某个项目下导入时，会自动加入该项目 |
| 从项目移除 | 在项目里选中 → **Remove from project**（文献仍留在库里） |
| 搜索 | 顶栏搜索框（快捷键 `/`），按标题、作者、期刊、年份、DOI、PMID、引用键匹配，多个词取交集 |
| 排序 | 点列标题：Title / Authors / Year / Journal；第三次点击恢复「最近添加在前」 |
| 引文与参考文献 | 选样式 → **Bibliography**。显示文内引用和参考文献表，**Copy** 会带着斜体/粗体格式粘贴到 Word / Google Docs，也可以下载 .txt |
| 导出 | **Export** → CSL JSON / BibTeX / RIS |
| 深色模式 | 右上角按钮，选择会记住 |

**Bibliography 和 Export 作用于谁？** 有选中项时只处理选中的文献；没有选中时处理当前列表里看到的全部——即整个库、当前项目，或当前搜索结果。菜单和对话框顶部会写明范围。

快捷键：`N` 新建 · `/` 搜索 · `↑ ↓` 移动（`Shift` 多选）· `⌘/Ctrl+A` 全选 · `Enter` 编辑 · `Delete` 删除 · `Esc` 取消选择。

### 内置引文样式

Nature、Science、Cell、PNAS、The Lancet、PLOS、APA 7th、Chicago (author-date)、Harvard (Cite Them Right)、Elsevier Harvard、AMA、Vancouver (NLM)、IEEE。

想要别的样式：从 [Zotero 样式库](https://www.zotero.org/styles) 下载 `.csl` 文件，放进 `~/.zotlet/styles/`，刷新页面即可（只支持独立样式，不支持 dependent style）。

## 数据存在哪里

```text
~/.zotlet/library.json     文献库：CSL-JSON 数组
~/.zotlet/web-state.json   项目列表
~/.zotlet/styles/          你自己添加的 .csl 样式
```

- 文献的 ID 和所有字段原样保留——包括 zotlet 不认识的字段，任何写入都不会丢掉它们。
- 每次保存都先写临时文件再原子替换；文件不是合法 JSON 时会报错，而不是覆盖掉。
- 备份 / 同步：直接复制或同步 `~/.zotlet` 文件夹。
- 环境变量：`ZOTLET_HOME=/某路径` 会改用 `/某路径/.zotlet/`；`ZOTLET_LIB` 单独指定文献库文件；`ZOTLET_PORT` 指定端口。

导入的元数据会被清洗成干净的 CSL：作者对象只保留 `family`、`given`、`literal` 及姓名小品词等字段（`sequence`、`affiliation`、`ORCID`、`role` 等全部去掉），所以 Elsevier 之类的 DOI 不会再因为多余字段校验失败；日期、标题数组、JATS 摘要标签也会被规范化。重复检测按 DOI（不区分大小写）和 PMID。

## 命令行

```text
node zotlet.js web [--port N] [--open]   启动网页（默认端口 23121）
node zotlet.js add <DOI|PMID>...         在终端里导入
node zotlet.js ls [关键词]               列出或搜索文献库
```

## 打包

```bash
npm run package
```

生成 `dist/zotlet-<版本>.zip`：只有源码、两个启动脚本，以及纯 JavaScript 的 `citeproc` 依赖。**不包含 Node 二进制**，与 CPU 架构无关，解压后在任何装了 `node` 的电脑上双击即可。若解压后缺少 `node_modules`，启动器会自动执行一次 `npm install`。

## 开发

```bash
npm test
```

测试用 Node 自带的 `node:test`，不需要网络（DOI / PubMed 请求用录制好的样本）。如果本机装了 Playwright，还会跑一组真实浏览器的端到端测试；设置 `ZOTLET_SCREENSHOTS=某目录` 可顺便保存截图。

```text
zotlet.js          命令行入口（web / add / ls）
src/server.js      本地 HTTP 服务：静态页面 + JSON API（只监听 127.0.0.1，带会话令牌）
src/store.js       library.json / web-state.json 的读写
src/metadata.js    DOI / PMID 解析、查询与 CSL 清洗
src/citations.js   citeproc-js 格式化与样式列表
src/export.js      CSL JSON / BibTeX / RIS
public/            前端（原生 HTML/CSS/JS，无构建步骤）
styles/ locales/   CSL 样式与 en-US 语言文件
test/              单元、API 与浏览器测试
```

更详细的设计约定见 [CLAUDE.md](CLAUDE.md)，原始需求见 [AGENTS.md](AGENTS.md)。
