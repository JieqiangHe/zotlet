#!/usr/bin/env node
// zotlet — a minimal, personal reference manager.
import { openBrowser } from './src/open.js'
import { createStore, dataDir } from './src/store.js'
import { parseIdentifiers, lookupIdentifier } from './src/metadata.js'

const DEFAULT_PORT = 23121
const color = (code) => (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = color(2), bold = color(1), green = color(32), red = color(31), yellow = color(33)

const HELP = `${bold('zotlet')} ${dim('— a minimal personal reference manager')}

${bold('Usage')}
  node zotlet.js web [--port N] [--open]   start the local web app (default port ${DEFAULT_PORT})
                    [--no-word]             … without the Word/LibreOffice/GenOffice plugin service
  node zotlet.js add <DOI|PMID>...         import references from the command line
  node zotlet.js ls [words]                list or search the library
  node zotlet.js help                      show this message

${dim(`Data folder: ${dataDir()}`)}`

async function isZotlet(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) })
    return (await r.json()).app === 'zotlet'
  } catch { return false }
}

async function web(args) {
  const i = args.indexOf('--port')
  const port = i >= 0 ? Number(args[i + 1]) : Number(process.env.ZOTLET_PORT || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port needs a number between 0 and 65535')
  const open = args.includes('--open')
  const integration = !args.includes('--no-word') && !process.env.ZOTLET_NO_WORD && {}
  const { startServer } = await import('./src/server.js')
  let server
  try {
    server = await startServer({ port, integration })
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    if (await isZotlet(port)) {
      const url = `http://127.0.0.1:${port}/`
      console.log(`${yellow('•')} zotlet is already running at ${url}`)
      if (open) openBrowser(url)
      return
    }
    throw new Error(`Port ${port} is used by another program. Start with --port <number> or set ZOTLET_PORT.`)
  }
  const { items, projects, paths } = await createStore().snapshot()
  console.log(`${bold('zotlet')} ${dim('·')} ${server.url}`)
  console.log(dim(`${items.length} references · ${projects.length} projects · ${paths.library}`))
  const word = server.integration
  if (word?.tcp || word?.http) {
    console.log(dim(`Word / LibreOffice / GenOffice citations: on (ports ${[word.tcp, word.http].filter(Boolean).map((s) => s.address().port).join(', ')})`))
  }
  console.log(dim('Keep this window open while you use zotlet. Press Ctrl+C to stop.'))
  if (open) openBrowser(server.url)
  const stop = () => { console.log(dim('\nzotlet stopped.')); server.close(); server.closeAllConnections(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function add(args) {
  const requests = parseIdentifiers(args.join('\n'))
  if (!requests.length) throw new Error('Give one or more DOIs or PMIDs')
  const store = createStore()
  for (const request of requests) {
    if (request.kind === 'invalid') { console.log(`${red('✗')} ${request.input}  ${dim('not a DOI or PMID')}`); continue }
    try {
      const item = await lookupIdentifier(request)
      const [result] = await store.addItems([item])
      const mark = result.status === 'added' ? green('✓') : yellow('•')
      console.log(`${mark} ${bold(result.id)}  ${result.status === 'added' ? result.item.title : dim('already in library')}`)
    } catch (error) { console.log(`${red('✗')} ${request.input}  ${dim(error.message)}`) }
  }
}

async function ls(args) {
  const { items } = await createStore().snapshot()
  const words = args.join(' ').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = items.filter((i) => { const t = JSON.stringify(i).toLowerCase(); return words.every((w) => t.includes(w)) })
  const width = Math.max(4, ...hits.map((i) => i.id.length))
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  for (const i of hits) {
    const first = i.author?.[0], who = first ? first.family || first.literal : ''
    const year = i.issued?.['date-parts']?.[0]?.[0] ?? ''
    console.log(`${bold(i.id.padEnd(width))}  ${dim(clip(`${who} ${year}`.trim(), 22).padEnd(22))}  ${clip(String(i.title || '').replace(/<[^>]+>/g, ''), 80)}`)
  }
  console.log(dim(`${hits.length} of ${items.length} references`))
}

const [cmd = 'help', ...rest] = process.argv.slice(2)
const commands = { web, add, ls }
if (commands[cmd]) {
  try { await commands[cmd](rest) } catch (error) { console.error(red(error.message)); process.exitCode = 1 }
} else {
  console.log(HELP)
  if (!['help', '-h', '--help'].includes(cmd)) process.exitCode = 1
}
