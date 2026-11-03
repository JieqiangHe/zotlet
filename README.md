# zotlet

A tiny local reference manager with Zotero-compatible citations.

## Features

- A local web library at [http://127.0.0.1:23121/](http://127.0.0.1:23121/). You can search, add references by DOI or PMID, or type one in by hand. Projects can be created, renamed, deleted, and selected; the list then shows that project's references, and a reference can be removed from it. The page can format a bibliography for the current list and export CSL-JSON, BibTeX, or RIS.
- Citation styles in `styles/`: Nature, Science, and Cell. Formatting uses [citeproc](https://www.npmjs.com/package/citeproc) and the bundled en-US CSL locale. Drop another `.csl` file into `styles/`, or into `~/.zotlet/styles`, to make it available to the citation service.
- A command-line library: fetch metadata, list or search items, and turn a plain-text draft into a `.docx` whose citations are Zotero field codes.
- A citation service on this machine. TCP port 23116 speaks the document integration used by LibreOffice (when the connecting process is LibreOffice) and, otherwise, the GenOffice-compatible session. HTTP port 23119 speaks the Zotero Connector citing protocol (`/connector/ping`, `/connector/document/execCommand`, `/connector/document/respond`, `/connector/sendToBack`). These are the same ports Zotero uses, so quit Zotero before starting the service. `zotlet web` starts the service with the page. `zotlet server` starts only the listeners.

The `docx` command writes a WordprocessingML `.docx` with Zotero citation and bibliography fields. The command tells you to open that file in GenOffice and press Refresh. Inserting or restyling a citation from the TCP or HTTP session runs `picker.jxa` through `osascript`. That picker script is not part of this source tree.

## Requirements

- Node.js 22 or newer
- A network connection when looking up a DOI or PMID (Crossref CSL-JSON from `doi.org`, PubMed CSL from NCBI)

## Install

```sh
npm install
```

That installs the only dependency, `citeproc`.

## Run

On macOS:

```sh
./start-web.command
```

On Linux, or from a shell:

```sh
./start-web.sh
```

Or start it directly:

```sh
node zotlet.js web
```

The start scripts open [http://127.0.0.1:23121/](http://127.0.0.1:23121/) after a short delay. If they do not, open that address yourself. The page is served only on `127.0.0.1`. Leave the process running while you use it, and press Ctrl+C to quit.

If port 23121 is already taken, another zotlet web process is using it.

## Command-line usage

`zotlet.js` is the CLI. With no command, or with `help`, `-h`, or `--help`, it prints usage.

```text
zotlet add <DOI|PMID>...                 fetch metadata into your library
zotlet ls [words]                        list or search the library
zotlet docx <draft.txt> <out.docx> [--style nature|science|cell]
                                         turn a plain-text draft into a .docx with live citations
zotlet server                            start TCP 23116 and HTTP 23119 (quit Zotero first)
zotlet web                               serve local management on 23121 and start citations
```

Run them as `node zotlet.js <command>`.

`add` accepts DOIs (including `https://doi.org/...` and `doi:` forms) and PMIDs. A DOI already in the library is skipped. The citation key is the first author's family name plus the year, with a letter added if that key is taken.

`ls` prints every item, or those whose stored JSON contains every word you pass.

`docx` reads a UTF-8 draft: one paragraph per line. Cite with `[@key]` or `[@key1; @key2]`. A line that is only `[bibliography]` is where the reference list goes. Keys must already be in the library. The default style is `nature`.

## Data

The library is CSL-JSON at `~/.zotlet/library.json`. The web UI stores projects in `~/.zotlet/web-state.json`. User-added styles live in `~/.zotlet/styles/`.

If `ZOTLET_HOME` is set, those files are under `$ZOTLET_HOME/.zotlet/` instead of your home directory. `ZOTLET_LIB` overrides the library file path.

## Project layout

```text
zotlet.js            CLI (add, ls, docx, server, web)
server.js            TCP and HTTP citation servers
session.js           library, citeproc formatting, document commands
tcp.js               TCP integration transport
tcp-client.js        recognize a LibreOffice client on Linux and macOS
http.js              Zotero Connector HTTP citing protocol
metadata.js          DOI and PMID lookup, citation keys
style-catalog.js     built-in and user CSL styles
styles/              nature.csl, science.csl, cell.csl
locales/             locales-en-US.xml
web/                 local management page and its server (web/server.js)
start-web.command    macOS launcher
start-web.sh         shell launcher
package.json         package metadata and the citeproc dependency
```
