// Local HTTP server: static frontend + JSON API, bound to 127.0.0.1 only.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createStore, dataDir } from './store.js'
import { lookupIdentifier, parseIdentifiers, normalizeItem, ITEM_FIELDS } from './metadata.js'
import { formatCitations, listStyles } from './citations.js'
import { FORMATS } from './export.js'

const PUBLIC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public')
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/theme.js': ['theme.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
}
const MAX_IDENTIFIERS = 100
const LOOKUP_CONCURRENCY = 4

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

async function readBody(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw fail('Expected application/json', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2_000_000) throw fail('Request is too large', 413)
    chunks.push(chunk)
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw fail('Invalid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Expected a JSON object')
  return body
}

const stringList = (value, what = 'ids') => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw fail(`Expected a list of ${what}`)
  return value
}

/** Validate a manual/edited reference. Returns a clean patch (null = remove that field). */
export function validateFields(fields, { creating = false } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw fail('Expected reference fields')
  for (const key of Object.keys(fields)) if (!ITEM_FIELDS.has(key)) throw fail(`Unsupported field: ${key}`)
  const empty = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
  const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => !empty(v)))
  if ((creating || 'title' in fields) && typeof present.title !== 'string') throw fail('A title is required')
  // Same normalization as imported metadata, so manual items obey identical rules.
  const clean = normalizeItem({ title: 'untitled', ...present })
  const patch = {}
  for (const key of Object.keys(fields)) patch[key] = key in present && key in clean ? clean[key] : null
  if (creating || 'type' in fields) patch.type = clean.type
  return patch
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i], i) }
  }))
  return out
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function safeFileName(name) {
  return String(name || 'library').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'library'
}

export async function startServer({ port = 23121, host = '127.0.0.1', dir = dataDir(), store = createStore({ dir }),
  fetchImpl = globalThis.fetch, quiet = false } = {}) {
  const token = randomBytes(24).toString('hex')
  const userStyles = path.join(dir, 'styles')

  async function selectItems(ids) {
    const all = (await store.snapshot()).items
    if (!Array.isArray(ids)) return all
    const byId = new Map(all.map((i) => [i.id, i]))
    return stringList(ids).map((id) => byId.get(id)).filter(Boolean)
  }

  const api = {
    'GET /api/state': async () => ({ ...(await store.snapshot()), styles: listStyles(userStyles).map(({ id, title, label }) => ({ id, title, label })) }),

    'POST /api/import': async (body) => {
      if (typeof body.text !== 'string') throw fail('Paste one or more DOIs or PMIDs')
      const requests = parseIdentifiers(body.text)
      if (!requests.length) throw fail('Paste one or more DOIs or PMIDs')
      if (requests.length > MAX_IDENTIFIERS) throw fail(`Import at most ${MAX_IDENTIFIERS} identifiers at a time`)
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined
      const looked = await mapLimit(requests, LOOKUP_CONCURRENCY, async (request) => {
        if (request.kind === 'invalid') return { ...request, error: 'Not a DOI or PMID' }
        try { return { ...request, item: await lookupIdentifier(request, fetchImpl) } }
        catch (error) { return { ...request, error: error.message } }
      })
      const found = looked.filter((r) => r.item)
      const saved = found.length ? await store.addItems(found.map((r) => r.item), { projectId }) : []
      let k = 0
      return {
        results: looked.map((r) => (r.item
          ? { input: r.input, status: saved[k].status, id: saved[k].id, title: saved[k++].item.title }
          : { input: r.input, status: 'error', message: r.error })),
      }
    },

    'POST /api/items/create': async (body) => {
      const fields = Object.fromEntries(Object.entries(validateFields(body.fields, { creating: true })).filter(([, v]) => v !== null))
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined
      const [result] = await store.addItems([fields], { projectId })
      if (result.status === 'duplicate') throw fail(`That DOI/PMID is already in the library as "${result.id}"`, 409)
      return result
    },
    'POST /api/items/update': async (body) => {
      if (typeof body.id !== 'string') throw fail('Missing reference id')
      return { item: await store.updateItem(body.id, validateFields(body.fields)) }
    },
    'POST /api/items/delete': async (body) => store.deleteItems(stringList(body.ids)),

    'POST /api/projects/create': async (body) => store.createProject(body.name),
    'POST /api/projects/rename': async (body) => store.renameProject(body.id, body.name),
    'POST /api/projects/delete': async (body) => store.deleteProject(body.id),
    'POST /api/projects/add': async (body) => store.addToProject(body.id, stringList(body.itemIds)),
    'POST /api/projects/remove': async (body) => store.removeFromProject(body.id, stringList(body.itemIds)),

    'POST /api/cite': async (body) => {
      const items = await selectItems(body.ids)
      if (!items.length) throw fail('No references to format')
      return formatCitations({ styleId: String(body.style || 'nature'), items, userDir: userStyles })
    },
  }

  async function exportFile(body, res) {
    const format = FORMATS[body.format]
    if (!format) throw fail('Choose CSL JSON, BibTeX or RIS')
    const items = await selectItems(body.ids)
    if (!items.length) throw fail('Nothing to export')
    const name = `${safeFileName(body.name)}.${format.extension}`
    res.writeHead(200, { 'Content-Type': `${format.mime}; charset=utf-8`, 'Content-Disposition': contentDisposition(name), 'X-Item-Count': String(items.length) })
    res.end(format.render(items))
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json') => {
      if (res.headersSent) return res.end()
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` })
      res.end(type === 'application/json' ? JSON.stringify(value) : value)
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    try {
      const actual = server.address().port
      if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host)) return send(403, { error: 'Invalid Host header' })
      const url = new URL(req.url, `http://${req.headers.host}`)

      if (req.method === 'GET' && url.pathname === '/api/ping') return send(200, { app: 'zotlet' })
      if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
        const [file, type] = STATIC[url.pathname]
        let content = await fs.readFile(path.join(PUBLIC, file), file === 'favicon.svg' ? undefined : 'utf8')
        if (file === 'index.html') content = content.replace('__ZOTLET_TOKEN__', token)
        return send(200, content, type)
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' }, 'application/json')

      // Every API call needs the per-process token embedded in the page (blocks other sites).
      const supplied = Buffer.from(String(req.headers['x-zotlet-token'] || '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'The page is out of date. Reload it.' })

      if (req.method === 'POST' && url.pathname === '/api/export') return await exportFile(await readBody(req), res)
      const handler = api[`${req.method} ${url.pathname}`]
      if (!handler) return send(404, { error: 'Not found' })
      const body = req.method === 'POST' ? await readBody(req) : {}
      return send(200, await handler(body))
    } catch (error) {
      if (!error.status && !quiet) console.error(error)
      return send(error.status || 500, { error: error.message || 'Unexpected error' })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  server.url = `http://127.0.0.1:${server.address().port}/`
  server.token = token
  return server
}
