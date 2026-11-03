// Separate local UI server. The Connector endpoints and citation listeners are unchanged.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStore } from './store.js'
import { styleCatalog } from '../style-catalog.js'
import { loadLib } from '../session.js'
import { getStyle, previewStyle, saveStyle } from './styles.js'
import { createReferences } from './references.js'
import { createStyleRepository } from './style-repository.js'
import { createCitations } from './citations.js'
import { formatItems } from './format.js'

const execute = promisify(execFile), HERE = path.dirname(fileURLToPath(import.meta.url))
// Verify static files exist at startup
try { await fs.access(path.join(HERE, 'index.html')) } catch {
  console.error(`zotlet: cannot find web files at ${HERE}`)
  console.error('Make sure you extracted the full zip and are running from inside the zotlet-macos-arm64 folder.')
  process.exit(1)
}
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/library.js': ['library.js', 'text/javascript'], '/style-editor.js': ['style-editor.js', 'text/javascript'],
  '/reference-editor.js': ['reference-editor.js', 'text/javascript'], '/style-browser.js': ['style-browser.js', 'text/javascript'],
  '/ui.js': ['ui.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }
async function revealFile(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error('The file changed. Check files again')
  if (process.platform === 'darwin') await execute('/usr/bin/open', ['-R', file])
  else if (process.platform === 'linux') await execute('xdg-open', [path.dirname(file)])
  else if (process.platform === 'win32') await execute('explorer.exe', [`/select,${file}`])
  else throw new Error('Copy the path and open it in your file manager')
}
async function chooseFolder() {
  if (process.platform !== 'darwin') throw new Error('Enter or paste a folder path on this platform')
  try {
    const { stdout } = await execute('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder to check for PDFs")'], { encoding: 'utf8' })
    return stdout.trim()
  } catch (error) { if (/\(-128\)/.test(error.stderr || '')) return null; throw error }
}
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected application/json'), { status: 415 })
  let size = 0; const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1100000) throw Object.assign(new Error('Request is too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}
export async function serveWeb(port = 23121, { store: providedStore, schedule = true, reveal = revealFile, choose = chooseFolder, quiet = false,
  references = createReferences(), repository = createStyleRepository(), citations = createCitations(), autoCitations = false } = {}) {
  const store = providedStore || await createStore(), token = randomBytes(32).toString('hex')
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json') => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` }); res.end(type === 'application/json' ? JSON.stringify(value) : value)
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    try {
      const actualPort = server.address().port
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host)) return send(403, { error: 'Invalid Host' })
      const origin = `http://${req.headers.host}`
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site requests are not allowed' })
      const url = new URL(req.url, origin)
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [name, type] = assets[url.pathname]
        let content = await fs.readFile(path.join(HERE, name), 'utf8')
        if (name === 'index.html') content = content.replace('__ZOTLET_TOKEN__', token)
        return send(200, content, type)
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' })
      const supplied = Buffer.from(req.headers['x-zotlet-token'] || ''), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'Reload the local page to start a session' })
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return send(200, { ...store.snapshot(), platform: process.platform, citations: citations.status() })
        if (url.pathname === '/api/job') return send(200, { ...store.progress(), citations: citations.status() })
        if (url.pathname === '/api/reference') return send(200, await references.get(url.searchParams.get('id')))
        if (url.pathname === '/api/style-repository') return send(200, await repository.search(url.searchParams.get('q') || ''))
        if (url.pathname === '/api/styles') return send(200, styleCatalog())
        if (url.pathname === '/api/style') return send(200, getStyle(url.searchParams.get('id')))
        return send(404, { error: 'Not found' })
      }
      if (req.method !== 'POST') return send(405, { error: 'Use GET or POST' })
      const body = await jsonBody(req)
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Expected a JSON object')
      switch (url.pathname) {
        case '/api/references/import': return send(200, await references.importIdentifiers(body.identifiers))
        case '/api/references/create': return send(200, await references.create(body.fields))
        case '/api/references/update': return send(200, await references.update(body.id, body.patch, body.expectedRevision))
        case '/api/citations/start': return send(202, citations.start())
        case '/api/style-repository/refresh': return send(200, await repository.search(body.query || '', { refresh: true }))
        case '/api/style-repository/install': return send(200, await repository.install(body.name, body.expectedRevision, loadLib()))
        case '/api/check': return send(202, store.startCheck())
        case '/api/folders': return send(200, await store.addRoot(body.path))
        case '/api/folders/remove': return send(200, await store.removeRoot(body.path))
        case '/api/folders/choose': return send(200, { path: await choose() })
        case '/api/schedule': return send(200, await store.setInterval(body.days))
        case '/api/link': return send(200, await store.link(body.itemID, body.fileID))
        case '/api/unlink': return send(200, await store.link(body.itemID, body.fileID, true))
        case '/api/projects/create': return send(200, await store.createProject(body.name))
        case '/api/projects/rename': return send(200, await store.renameProject(body.id, body.name))
        case '/api/projects/delete': return send(200, await store.deleteProject(body.id))
        case '/api/projects/active': return send(200, await store.setActiveProject(body.id))
        case '/api/projects/add': return send(200, await store.addToProject(body.projectId, body.itemIds))
        case '/api/projects/remove': return send(200, await store.removeFromProject(body.projectId, body.itemIds))
        case '/api/cite': {
          const style = body.style || 'nature'
          const itemIds = Array.isArray(body.itemIds) ? body.itemIds : []
          const items = loadLib().filter(item => itemIds.includes(item.id))
          if (!items.length) return send(200, { text: '', citations: [], bibliography: '' })
          const result = await formatItems({ style, items, mode: body.mode || 'bibliography' })
          return send(200, result)
        }
        case '/api/files/reveal': await reveal(store.file(body.fileID).path); return send(200, { ok: true })
        case '/api/style/preview': return send(200, await previewStyle(body.xml, loadLib()))
        case '/api/style/save': return send(200, await saveStyle(body, loadLib()))
        default: return send(404, { error: 'Not found' })
      }
    } catch (error) { send(error.status || (/already running/.test(error.message) ? 409 : 400), { error: error.message }) }
  })
  const timer = schedule ? setInterval(() => { try { store.tick() } catch (error) { console.error(`zotlet web: ${error.message}`) } }, 30000) : null
  timer?.unref()
  const close = server.close.bind(server)
  server.close = (callback) => {
    clearInterval(timer)
    close((error) => { void Promise.all([store.stop(), citations.close()]).then(() => callback?.(error), (failure) => callback?.(failure)) })
    server.closeIdleConnections()
    return server
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  } catch (error) {
    clearInterval(timer); await Promise.all([store.stop(), citations.close()])
    if (error.code === 'EADDRINUSE') error.message = `Port ${port} is in use. Another zotlet web page may already be running`
    throw error
  }
  if (autoCitations) citations.start()
  if (!quiet) console.log(`zotlet web · http://127.0.0.1:${server.address().port}/\nKeep this process running while using the page. Ctrl+C to quit.`)
  return server
}
