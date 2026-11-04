# zotlet

A minimal, personal reference manager.

Organize references by project, import by DOI / PMID, generate citations with citeproc-js (Nature, Science, Cell, APA, Vancouver, IEEE …), and export CSL JSON, BibTeX or RIS. Everything runs locally.

**Run** — requires Node.js 18.17+:

- macOS: double-click `start-web.command`
- Or: `npm install && npm start`

The app opens at <http://127.0.0.1:23121/>. Press `Ctrl+C` in the terminal to stop it.

**Data** lives in `~/.zotlet/`: `library.json` holds the references as CSL-JSON, and `web-state.json` holds the projects. To add more citation styles, put `.csl` files in `~/.zotlet/styles/`.

**Develop**: `npm test` runs the tests, and `npm run package` builds a zip. [CLAUDE.md](CLAUDE.md) covers the requirements and design.
