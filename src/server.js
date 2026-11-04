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
import { startIntegration } from './integration.js'
import { openBrowser } from './open.js'
import { createStyleRepository } from './style-repo.js'
import { extractDOI, locatePdf, checkPdfPath, openFile, choosePdf, sha256 } from './pdf.js'

const PUBLIC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public')
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/theme.js': ['theme.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/pick.html': ['pick.html', 'text/html'],
  '/pick.js': ['pick.js', 'text/javascript'],
}
// A citation picker left open this long is cancelled, so the word processor is released.
const PICK_TIMEOUT = 30 * 60 * 1000
const PICK_FIELDS = ['id', 'type', 'title', 'author', 'editor', 'issued', 'container-title', 'container-title-short', 'publisher', 'DOI', 'PMID']
const MAX_IDENTIFIERS = 100
const MAX_PDF_BYTES = 300 * 1024 * 1024
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
  fetchImpl = globalThis.fetch, quiet = false, integration = false, openUrl = openBrowser, log = console.log,
  locate = locatePdf, openPath = openFile, choose = choosePdf, platform = process.platform } = {}) {
  const token = randomBytes(24).toString('hex')
  const userStyles = path.join(dir, 'styles')
  const styles = () => listStyles(userStyles)
  const styleList = () => styles().map(({ id, title, label, builtin, parent, format }) => ({ id, title, label, builtin, parent: parent || null, format }))
  const repository = createStyleRepository({ userDir: userStyles, cacheFile: path.join(dir, 'style-index.json'), fetchImpl })

  // Pending picker requests from the word processor integration, answered by public/pick.html.
  const picks = new Map()
  function pick(spec) {
    const id = randomBytes(12).toString('hex')
    return new Promise((resolve) => {
      const entry = { spec, timer: setTimeout(() => entry.done(null), PICK_TIMEOUT) }
      entry.done = (value) => { clearTimeout(entry.timer); picks.delete(id); resolve(value) }
      picks.set(id, entry)
      openUrl(`${server.url}pick.html?id=${id}`)
    })
  }
  const pending = (id) => {
    const entry = typeof id === 'string' && picks.get(id)
    if (!entry) throw fail('This request is no longer active. Start it again from your word processor.', 410)
    return entry
  }

  async function selectItems(ids) {
    const all = (await store.snapshot()).items
    if (!Array.isArray(ids)) return all
    const byId = new Map(all.map((i) => [i.id, i]))
    return stringList(ids).map((id) => byId.get(id)).filter(Boolean)
  }

  const api = {
    'GET /api/state': async () => ({ ...(await store.snapshot()), styles: styleList(), platform }),

    'POST /api/pdf/link': async (body) => {
      if (typeof body.id !== 'string') throw fail('Missing reference id')
      return store.setPdf(body.id, await checkPdfPath(body.path))
    },
    'POST /api/pdf/choose': async (body) => {
      if (typeof body.id !== 'string') throw fail('Missing reference id')
      const file = await choose()
      return file ? store.setPdf(body.id, await checkPdfPath(file)) : { id: body.id, cancelled: true }
    },
    'POST /api/pdf/unlink': async (body) => {
      if (typeof body.id !== 'string') throw fail('Missing reference id')
      return store.setPdf(body.id, null)
    },
    'POST /api/pdf/open': async (body) => {
      const file = (await store.snapshot()).pdfs[body.id]
      if (!file) throw fail('No PDF is linked to this reference', 404)
      try { await fs.access(file) } catch { throw fail(`The PDF is no longer at ${file}. Drop the file on the reference again to relink it.`, 410) }
      await openPath(file)
      return { ok: true, path: file }
    },

    'POST /api/styles/search': async (body) => repository.search(typeof body.query === 'string' ? body.query : '', { refresh: !!body.refresh }),
    'POST /api/styles/install': async (body) => {
      if (typeof body.name !== 'string') throw fail('Missing style name')
      return { installed: await repository.install(body.name), styles: styleList() }
    },
    'POST /api/styles/add': async (body) => {
      if (typeof body.xml !== 'string') throw fail('Choose a .csl file')
      return { installed: await repository.addFile(body.xml), styles: styleList() }
    },
    'POST /api/styles/remove': async (body) => {
      if (typeof body.id !== 'string') throw fail('Missing style id')
      return { removed: await repository.remove(body.id), styles: styleList() }
    },

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

    'POST /api/pick/get': async (body) => {
      const { spec } = pending(body.id)
      const { projects } = await store.snapshot()
      const items = (spec.items || []).map((item) => Object.fromEntries(PICK_FIELDS.filter((k) => k in item).map((k) => [k, item[k]])))
      return { mode: spec.mode, style: spec.style, selected: spec.selected || [], items,
        projects: projects.map(({ id, name, itemIds }) => ({ id, name, itemIds })),
        styles: styleList() }
    },
    'POST /api/pick/done': async (body) => {
      const entry = pending(body.id)
      if (body.cancel) { entry.done(null); return { ok: true } }
      const style = typeof body.style === 'string' && styles().some((s) => s.id === body.style) ? body.style : undefined
      if (entry.spec.mode === 'style') {
        if (!style) throw fail('Choose a citation style')
        entry.done({ style })
      } else {
        const ids = stringList(body.ids)
        if (!ids.length) throw fail('Choose at least one reference')
        entry.done({ ids, style })
      }
      return { ok: true }
    },

    'POST /api/cite': async (body) => {
      const items = await selectItems(body.ids)
      if (!items.length) throw fail('No references to format')
      return formatCitations({ styleId: String(body.style || 'nature'), items, userDir: userStyles })
    },
  }

  async function readPdf(req) {
    if (!/^application\/pdf\b/i.test(req.headers['content-type'] || '')) throw fail('Expected a PDF', 415)
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_PDF_BYTES) throw fail('The PDF is too large (300 MB at most)', 413)
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.subarray(0, 1024).indexOf('%PDF-') < 0) throw fail('This file is not a PDF')
    return bytes
  }

  /**
   * A PDF dropped on the page. Reads its DOI, imports the reference (or finds it in the library),
   * finds the file on disk and links its path. With ?itemId= it only links the file to that item.
   * The PDF itself is never stored.
   */
  async function importPdf(req, url) {
    const header = (name) => { try { return decodeURIComponent(String(req.headers[name] || '')) } catch { return '' } }
    const name = header('x-file-name'), size = Number(req.headers['x-file-size'])
    const bytes = await readPdf(req)
    const located = await locate({ name, size: Number.isFinite(size) && size > 0 ? size : bytes.length, hash: sha256(bytes) })
    const out = { file: name, path: located || null }
    const itemId = url.searchParams.get('itemId')
    if (itemId) {
      if (!(await store.snapshot()).items.some((i) => i.id === itemId)) throw fail('Reference not found', 404)
      if (located) await store.setPdf(itemId, located)
      return { ...out, status: 'linked', id: itemId }
    }
    const found = extractDOI(bytes)
    if (!found) return { ...out, status: 'no-doi' }
    out.doi = found.doi
    const [request] = parseIdentifiers(found.doi)
    if (!request || request.kind !== 'doi') return { ...out, status: 'no-doi' }
    let item
    try { item = await lookupIdentifier(request, fetchImpl) } catch (error) { return { ...out, status: 'error', message: error.message } }
    const projectId = url.searchParams.get('projectId') || undefined
    const [saved] = await store.addItems([item], { projectId })
    if (located) await store.setPdf(saved.id, located)
    return { ...out, status: saved.status, id: saved.id, title: saved.item.title }
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
        let content = await fs.readFile(path.join(PUBLIC, file), 'utf8')
        if (file.endsWith('.html')) content = content.replace('__ZOTLET_TOKEN__', token)
        return send(200, content, type)
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' }, 'application/json')

      // Every API call needs the per-process token embedded in the page (blocks other sites).
      const supplied = Buffer.from(String(req.headers['x-zotlet-token'] || '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'The page is out of date. Reload it.' })

      if (req.method === 'POST' && url.pathname === '/api/export') return await exportFile(await readBody(req), res)
      if (req.method === 'POST' && url.pathname === '/api/pdf/import') return send(200, await importPdf(req, url))
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
  server.pick = pick

  // Word / LibreOffice / GenOffice plugins (Zotero protocol). Off unless asked for.
  if (integration) {
    const ctx = { items: async () => (await store.snapshot()).items, styles, pick }
    server.integration = await startIntegration(ctx, { ...integration, host,
      log: quiet ? () => {} : (line) => log(`${new Date().toTimeString().slice(0, 8)}  ${line}`),
      warn: quiet ? () => {} : log })
    const close = server.close.bind(server)
    server.close = (callback) => {
      server.integration.close()
      for (const entry of picks.values()) entry.done(null)
      return close(callback)
    }
  }
  return server
}
