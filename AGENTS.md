# zotlet — Requirements

A minimal, personal reference manager inspired by Zotero.  
Focus: compact UI, project-centric organization, reliable DOI import, and clean citation export.

## Core Features

- **Projects**: Treat each paper / task as a separate project.  
  References can belong to zero or more projects.  
  Left pane shows the project list (keep it simple).

- **Library**: Central list of references.  
  Support search, and filter by active project.

- **DOI / PMID import**:  
  Paste one or more DOIs or PMIDs and import.  
  Must correctly normalize author objects (drop `sequence`, `affiliation`, `role`, etc.) so validation never fails on extra fields.

- **Citations**:  
  Generate in-text citations and bibliographies using citeproc-js.  
  Support common styles (Nature, Science, Cell, etc.).

- **Word processor citations**:  
  Insert and refresh live citations and bibliographies in Microsoft Word, LibreOffice and GenOffice
  through the Zotero word-processor plugin protocol (TCP 23116, HTTP 23119).

- **Export**:  
  One-click download of the current selection (or whole library / project) as:
  - CSL JSON
  - BibTeX
  - RIS

## UI

- Two-pane layout only:  
  - Left: Projects (compact)  
  - Center: Reference list  
  - No right-hand detail pane.

- Visual style:  
  Reference the restrained look of [svguest.online](https://svguest.online) for the main area  
  (light gray background, thin borders, small radius, 12 px font, short toolbar).  
  Left project pane can stay simpler.

- Density:  
  Compact enough for personal daily use, but not so small that text becomes hard to read.  
  Medium-compact sizing is preferred.

- Dark mode: toggle in the top bar, persisted in localStorage.

- Top bar: clean and ordered (New, Search, Style selector, Bibliography, Export, theme toggle).

- Project actions:  
  Direct buttons at the bottom of the left pane (`+ New`, `Rename`, `Delete`).  
  Do not hide them behind a menu that can be clipped.

- Empty states and list rows should align cleanly with the window.

## Technical Constraints

- **Runtime**: Node.js server + static frontend.  
  Do **not** bundle a Node binary. The user will use their own system `node`.

- **Packaging**:  
  Produce a plain zip that contains only the application source + a simple launcher script  
  (`start-web.command` / `start-web.sh`).  
  The launcher must call the system `node` and open the browser.

- **Platform**: macOS ARM is the primary target, but the package itself should be architecture-agnostic  
  (no prebuilt Node).

- **Launcher behavior**:  
  Do not force-close the Terminal window.  
  Let the user see the server output.

- **Data**: Persist library and projects locally (file-based or equivalent).  
  Preserve item IDs and unknown fields on write.

## Non-Goals

- No silent / background-only launcher.
- No bundled Node binary.
- No three-pane Zotero clone.
- No attempt to re-implement the full Zotero connector (web page saving, translators).

## Acceptance Checks

- DOI `10.1016/j.plaphy.2026.111729` (and similar Elsevier DOIs) imports without author-validation errors.
- Creating, renaming, and deleting a project works from the left-pane buttons.
- Bibliography generation and multi-format export work for both the whole library and a single project.
- Dark mode toggle persists across reloads.
- Double-clicking the launcher on a machine that already has `node` in `PATH` starts the server and opens the browser.
