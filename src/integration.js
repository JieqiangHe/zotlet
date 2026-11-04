// Word processor integration: speaks the protocol of Zotero's word-processor plugins, so
// "Add/Edit Citation", "Add/Edit Bibliography", "Refresh", "Document Preferences" and
// "Unlink Citations" in Microsoft Word, LibreOffice and GenOffice work against the zotlet library.
//
// * TCP 23116  — native transport used by the Word and LibreOffice plugins (8-byte header + JSON).
// * HTTP 23119 — "HTTP citing protocol" (/connector/document/*) used by GenOffice and web editors.
//
// Both transports drive the same document session (`runSession`). Citation and style choices are
// made in a picker page of the web app (see public/pick.html), supplied by the caller as `pick`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { endianness } from 'node:os'
import { promisify } from 'node:util'
import { makeEngine } from './citations.js'

export const TCP_PORT = 23116
export const HTTP_PORT = 23119
export const SCHEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'
export const COMPAT_VERSION = '6.0.0'
const DEFAULT_STYLE = 'nature'

const rid = () => randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8).padEnd(8, '0')

// Stable Zotero-style item URI for a zotlet item id (unchanged from earlier zotlet versions,
// so citations already in documents keep matching).
const zkey = (s) => {
  const a = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
  let h = 0n
  for (let k = 0; k < s.length; k++) h += BigInt(s.charCodeAt(k)) * 31n ** BigInt(k)
  return Array.from({ length: 8 }, (_, k) => a[Number((h / 33n ** BigInt(k)) % 33n)]).join('')
}
export const itemURI = (id) => `http://zotero.org/users/local/zotlet/items/${zkey(String(id))}`

// ---------- styles ----------

/** Map a style URI stored in a document (or a bare id) to an installed style id, else null. */
export function resolveStyle(value, styles) {
  if (typeof value !== 'string' || !value) return null
  const uri = value.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const suffix = uri.split('/').pop()
  return styles.find((s) => s.id === suffix)?.id || styles.find((s) => s.uri === uri)?.id || null
}

const styleURI = (id, styles) => styles.find((s) => s.id === id)?.uri || `http://www.zotero.org/styles/${id}`

// ---------- formatting ----------

const parseCode = (code) => {
  try { return JSON.parse(code.slice(code.indexOf('{'), code.lastIndexOf('}') + 1)) } catch { return null }
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const prefXml = (uri, fieldType = 'ReferenceMark', bibliographyStyleSet = true, sessionID = rid(), version = 'zotlet') =>
  `<data data-version="3" zotero-version="${version}"><session id="${sessionID}"/><style id="${escAttr(uri)}" hasBibliography="1" bibliographyStyleHasBeenSet="${bibliographyStyleSet ? 1 : 0}"/><prefs><pref name="fieldType" value="${fieldType}"/></prefs></data>`

function readData(data) {
  try { const parsed = JSON.parse(data); if (parsed?.dataVersion === 4) return parsed } catch {}
  return null
}

/** Paragraph settings for Document.setBibliographyStyle, in twips (same rules as Zotero). */
export function bibliographyStyle([meta]) {
  const tabs = []
  let first = 0, indent = 0
  if (meta.hangingindent) { indent = 720; first = -720 }
  else if (meta['second-field-align']) {
    const at = 24 + meta.maxoffset * 120
    first = -at
    if (meta['second-field-align'] === 'margin') tabs.push(0)
    else { indent = at; tabs.push(at) }
  }
  return [first, indent, 240 * meta.linespacing, 240 * meta.entryspacing, tabs, tabs.length]
}

function render(xml, items, cites, mode) {
  const engine = makeEngine(xml, Object.values(items), mode)
  const out = engine.rebuildProcessorState(cites.map((c) => ({
    citationID: c.j.citationID,
    citationItems: c.j.citationItems.map(({ itemData, uris, uri, ...ci }) => ({ ...ci, id: String(ci.id) })),
    properties: { noteIndex: 0 },
  })), mode)
  let bib = false
  try { bib = engine.makeBibliography() } catch { bib = false }
  return [Object.fromEntries(out.map(([cid, , s]) => [cid, s])), bib]
}

function bibRtf([meta, entries]) {
  const n = meta['second-field-align'] ? Math.max(480, meta.maxoffset * 150) : 720
  const indent = meta.hangingindent || meta['second-field-align'] ? `\\li${n}\\fi-${n} ` : ''
  return `{\\rtf ${indent}${entries.map((s) => s.replace(/\s+$/, '')).join('\\par ')}}`
}

async function refresh(doc, style, call, options, ctx) {
  const [ids, codes] = await call('Document.getFields', [doc, options.fieldType])
  const library = new Map((await ctx.items()).map((i) => [String(i.id), i]))
  const items = {}, cites = [], bibs = [], seen = new Set()
  ids.forEach((id, k) => {
    const code = codes[k]
    if (/^ITEM/.test(code)) {
      const j = parseCode(code)
      if (!j || !Array.isArray(j.citationItems)) return
      if (!j.citationID || seen.has(j.citationID)) j.citationID = rid()
      seen.add(j.citationID)
      for (const ci of j.citationItems) {
        // The library copy wins, so edits made in zotlet show up on refresh.
        ci.itemData = { ...(library.get(String(ci.id)) || ci.itemData), id: ci.id }
        ci.uris ??= [itemURI(ci.id)]
        items[String(ci.id)] = ci.itemData
      }
      cites.push({ id, j })
    } else if (/^BIBL/.test(code)) bibs.push(id)
  })
  if (!cites.length) return 0
  const xml = fs.readFileSync(ctx.styles().find((s) => s.id === style).file, 'utf8')
  const [formatted, bib] = render(xml, items, cites, options.outputFormat)
  const [plain] = render(xml, items, cites, 'text')
  for (const { id, j } of cites) {
    const r = formatted[j.citationID]
    j.properties = { formattedCitation: r, plainCitation: plain[j.citationID], noteIndex: 0 }
    j.schema = SCHEMA
    const text = options.outputFormat === 'rtf' ? (r.startsWith('{\\rtf') ? r : `{\\rtf ${r}}`) : r
    await call('Field.setText', [doc, id, text, true])
    await call('Field.setCode', [doc, id, `ITEM CSL_CITATION ${JSON.stringify(j)}`])
  }
  for (const id of bibs) {
    if (bib && options.setBibliographyStyle && !options.bibliographyStyleSet) {
      await call('Document.setBibliographyStyle', [doc, ...bibliographyStyle(bib)])
      options.bibliographyStyleSet = true
    }
    const text = !bib ? '' : options.outputFormat === 'rtf' ? bibRtf(bib) : bib[0].bibstart + bib[1].join('') + bib[0].bibend
    await call('Field.setText', [doc, id, text, true])
  }
  return cites.length
}

const COMMANDS = ['addEditCitation', 'addEditBibliography', 'refresh', 'setDocPrefs', 'removeCodes']

/**
 * Run one plugin command against a document.
 * `call(method, args)` performs a document RPC ("Document.getFields", …) on the client.
 * `ctx` = { items: async () => [CSL items], styles: () => [{ id, uri, file }], pick: async (spec) => result | null }.
 * Returns a short note for the server log.
 */
export async function runSession(cmd, call, session, ctx) {
  const styles = ctx.styles()
  const [, doc, capabilities] = await call('Application.getActiveDocument', [3])
  const options = { fieldType: 'ReferenceMark', outputFormat: 'rtf', supportedNotes: [], ...session, ...capabilities }
  const alert = (msg, buttons = 0) => call('Document.displayAlert', [doc, msg, 0, buttons])
  let note = '', mutated = false, serializeData
  if (options.finalCommit) {
    const invoke = call
    call = async (method, args) => {
      const value = await invoke(method, args)
      if (/^(Field\.(setText|setCode|removeCode|delete)|Document\.(insertField|convert|setBibliographyStyle))$/.test(method)) mutated = true
      return value
    }
  }
  try {
    if (options.modernData && !COMMANDS.includes(cmd)) throw new Error(`zotlet does not support "${cmd}" yet`)
    if (!['rtf', 'html'].includes(options.outputFormat)) throw new Error(`Unsupported output format: ${options.outputFormat}`)
    const rawData = await call('Document.getDocumentData', [doc])
    if (options.modernData && typeof rawData !== 'string') throw new Error('Invalid document data: expected a string')
    const data = options.modernData ? readData(rawData) : null
    const stored = resolveStyle(data ? data.style?.styleID : /<style id="([^"]+)"/.exec(rawData || '')?.[1], styles)
    if (options.nativeFieldTypes) {
      const field = /<pref name="fieldType" value="([^"]+)"/.exec(rawData || '')?.[1] || data?.prefs?.fieldType
      if (options.nativeFieldTypes.includes(field)) options.fieldType = field
    }
    options.bibliographyStyleSet = data ? !!data.style?.bibliographyStyleHasBeenSet : /bibliographyStyleHasBeenSet="1"/.test(rawData || '')
    let style = stored || (styles.some((s) => s.id === DEFAULT_STYLE) ? DEFAULT_STYLE : styles[0]?.id)
    if (!style) throw new Error('No citation styles are installed')
    let sessionID = data?.sessionID || /<session id="([^"]+)"/.exec(rawData || '')?.[1]
    serializeData = () => {
      const uri = styleURI(style, styles)
      if (!options.modernData) return prefXml(uri)
      sessionID ||= rid()
      if (!data) {
        let xml = prefXml(uri, options.fieldType, options.bibliographyStyleSet, sessionID, options.version)
        const prefs = /<prefs>([\s\S]*?)<\/prefs>/.exec(rawData || '')
        if (prefs) {
          const field = `<pref name="fieldType" value="${options.fieldType}"/>`
          const existing = /<pref name="fieldType" value="[^"]*"\s*\/>/
          const retained = existing.test(prefs[1]) ? prefs[1].replace(existing, field) : prefs[1] + field
          xml = xml.replace(/<prefs>[\s\S]*?<\/prefs>/, `<prefs>${retained}</prefs>`)
        }
        return xml
      }
      return JSON.stringify({
        style: { styleID: uri, ...(data.style?.locale ? { locale: data.style.locale } : {}), hasBibliography: true,
          bibliographyStyleHasBeenSet: options.bibliographyStyleSet },
        prefs: { ...data.prefs, fieldType: options.fieldType, noteType: 0 }, sessionID,
        zoteroVersion: options.version || 'zotlet', dataVersion: 4,
      })
    }
    const setStyle = async (s) => {
      if (s === stored && s === style) return
      style = s
      if (options.setBibliographyStyle) options.bibliographyStyleSet = false
      await call('Document.setDocumentData', [doc, serializeData()])
    }

    if (cmd === 'setDocPrefs') {
      const r = await ctx.pick({ mode: 'style', style })
      if (!r?.style || !styles.some((s) => s.id === r.style)) return (note = 'cancelled')
      await setStyle(r.style)
    } else if (cmd === 'addEditCitation') {
      const cur = await call('Document.cursorInField', [doc, options.fieldType])
      const old = cur && /^ITEM/.test(cur[1]) ? parseCode(cur[1]) : null
      const pool = [...await ctx.items()]
      for (const ci of old?.citationItems || []) {
        if (!pool.some((it) => String(it.id) === String(ci.id))) pool.push({ ...ci.itemData, id: String(ci.id) })
      }
      if (!pool.length) throw new Error('Your zotlet library is empty. Add references in zotlet first.')
      const r = await ctx.pick({ mode: 'cite', style, items: pool, selected: (old?.citationItems || []).map((c) => String(c.id)) })
      const byId = new Map(pool.map((it) => [String(it.id), it]))
      const chosen = (r?.ids || []).map((id) => byId.get(String(id))).filter(Boolean)
      if (!chosen.length) return (note = 'cancelled')
      if (r.style && styles.some((s) => s.id === r.style)) await setStyle(r.style)
      const fieldId = old ? cur[0] : (await call('Document.insertField', [doc, options.fieldType, 0]))[0]
      const j = {
        citationID: old?.citationID || rid(), properties: { noteIndex: 0 },
        citationItems: chosen.map((it) => {
          // Keep locator/prefix/suffix of items that were already in this citation.
          const prev = old?.citationItems?.find((c) => String(c.id) === String(it.id))
          const { itemData: _d, uris: _u, uri: _x, ...extra } = prev || {}
          return { ...extra, id: it.id, uris: [itemURI(it.id)], itemData: it }
        }),
        schema: SCHEMA,
      }
      await call('Field.setCode', [doc, fieldId, `ITEM CSL_CITATION ${JSON.stringify(j)}`])
      note = chosen.map((it) => it.id).join(', ')
    } else if (cmd === 'addEditBibliography') {
      const [, codes] = await call('Document.getFields', [doc, options.fieldType])
      if (!codes.some((c) => /^BIBL/.test(c))) {
        const [id] = await call('Document.insertField', [doc, options.fieldType, 0])
        await call('Field.setCode', [doc, id, 'BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY'])
      }
    } else if (cmd === 'removeCodes') {
      if ((await alert('Convert all citations to plain text? They can no longer be refreshed or edited.', 1)) !== 1) return (note = 'cancelled')
      const [ids] = await call('Document.getFields', [doc, options.fieldType])
      for (const id of ids) await call('Field.removeCode', [doc, id])
      return (note = `${ids.length} fields unlinked`)
    }
    if (!stored) await setStyle(style)
    const n = await refresh(doc, style, call, options, ctx)
    note = [note, `${n} citation${n === 1 ? '' : 's'} · ${style}`].filter(Boolean).join('  ')
  } catch (e) {
    note = `error: ${e.message}`
    await alert(`zotlet: ${e.message}`).catch(() => {})
  } finally {
    if (options.finalCommit && mutated && serializeData) {
      await call('Document.setDocumentData', [doc, serializeData()])
        .catch(async (error) => { note = `error: ${error.message}`; await alert(`zotlet: ${error.message}`).catch(() => {}) })
    }
    await call('Document.complete', [doc]).catch(() => {})
  }
  return note
}

// ---------- TCP transport (Word, LibreOffice, GenOffice) ----------

const execute = promisify(execFile)
const OFFICE_NAMES = new Set(['soffice', 'soffice.bin', 'libreoffice', 'libreofficedev', 'uno', 'uno.bin'])
const bareHost = (value) => String(value).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '')
const isOffice = (name) => OFFICE_NAMES.has(String(name).toLowerCase())
const LIBREOFFICE_SESSION = { modernData: true, nativeFieldTypes: ['ReferenceMark', 'Bookmark'],
  setBibliographyStyle: true, finalCommit: true, supportedNotes: ['footnote', 'endnote'], version: COMPAT_VERSION }

/** Find the process owning the client end of `socket` in `lsof -Fpcn` output. */
export function lsofClient(output, socket) {
  let pid, command
  const owners = new Map()
  for (const line of output.split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); command = '' }
    else if (line[0] === 'c') command = line.slice(1)
    else if (line[0] === 'n') {
      const peer = /^(\[[^\]]+\]|[^:]+):(\d+)->(\[[^\]]+\]|[^:]+):(\d+)(?:\s|$)/.exec(line.slice(1))
      if (peer && bareHost(peer[1]) === bareHost(socket.remoteAddress) && +peer[2] === socket.remotePort
        && bareHost(peer[3]) === bareHost(socket.localAddress) && +peer[4] === socket.localPort
        && Number.isSafeInteger(pid) && pid > 0) owners.set(pid, { pid, command })
    }
  }
  if (owners.size !== 1) throw new Error('TCP peer has no unique process owner')
  return [...owners.values()][0]
}

function procEndpoint(value) {
  const [address, port] = value.split(':')
  const bytes = Buffer.from(address, 'hex')
  if (endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse()
  const mapped = bytes.length === 16 && bytes.subarray(0, 12).equals(Buffer.from('00000000000000000000ffff', 'hex'))
  return { address: bytes.length === 4 || mapped ? [...bytes.subarray(-4)].join('.') : bytes.toString('hex'), port: parseInt(port, 16) }
}

async function linuxClient(socket) {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(async (file) => {
    try { return await fsp.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
  }))
  const inodes = new Set()
  for (const line of tables.join('\n').split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns[3] !== '01') continue
    const local = procEndpoint(columns[1]), remote = procEndpoint(columns[2])
    if (local.address === bareHost(socket.remoteAddress) && local.port === socket.remotePort
      && remote.address === bareHost(socket.localAddress) && remote.port === socket.localPort && columns[9] !== '0') inodes.add(columns[9])
  }
  if (!inodes.size) return null
  for (const pid of await fsp.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const command = (await fsp.readFile(`/proc/${pid}/comm`, 'utf8')).trim()
      if (!isOffice(command)) continue
      for (const fd of await fsp.readdir(`/proc/${pid}/fd`)) {
        let target
        try { target = await fsp.readlink(`/proc/${pid}/fd/${fd}`) } catch { continue }
        if (inodes.has(/^socket:\[(\d+)\]$/.exec(target)?.[1])) return { pid: Number(pid), command }
      }
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error }
  }
  return null
}

/** LibreOffice speaks a newer dialect over the same socket; detect it from the peer process. */
export async function libreOfficeClient(socket) {
  if (process.platform === 'linux') return linuxClient(socket)
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${socket.localPort}`, '-sTCP:ESTABLISHED', '-Fpcn'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 })
    const owner = lsofClient(stdout, socket)
    return isOffice(owner.command) ? owner : null
  }
  return null
}

export function createTcpServer(ctx, { log = () => {}, detectClient = libreOfficeClient } = {}) {
  return net.createServer((sock) => {
    let buffer = Buffer.alloc(0), tx = 0, closed = false, commands = Promise.resolve()
    const profile = Promise.resolve().then(() => detectClient(sock)).then((owner) => {
      if (owner) log(`TCP client ${owner.command} (PID ${owner.pid}): LibreOffice mode`)
      return owner ? LIBREOFFICE_SESSION : {}
    }).catch(() => ({}))
    const waiting = new Map()
    const call = (method, args) => new Promise((resolve, reject) => {
      if (closed || sock.destroyed || sock.writableEnded) { reject(new Error('The word processor closed the connection')); return }
      const id = ++tx, body = Buffer.from(JSON.stringify([method, args])), header = Buffer.alloc(8)
      header.writeUInt32BE(id); header.writeUInt32BE(body.length, 4)
      waiting.set(id, { resolve, reject })
      sock.write(Buffer.concat([header, body]))
    })
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const id = buffer.readUInt32BE(), length = buffer.readUInt32BE(4)
        if (buffer.length < 8 + length) break
        const payload = buffer.subarray(8, 8 + length).toString('utf8')
        buffer = buffer.subarray(8 + length)
        if (id === 0) {
          let command
          try { ({ command } = JSON.parse(payload)); if (typeof command !== 'string') throw new Error('Invalid command') } catch { sock.destroy(); return }
          commands = commands.then(async () => {
            const session = await profile, native = !!session.nativeFieldTypes
            const invoke = async (method, args) => {
              const value = await call(method.replace('.', '_'), args)
              // LibreOffice needs RTF text set again after a code change to keep italics etc.
              if (native && method === 'Field.setCode') {
                const code = args[2], start = code.indexOf('{')
                if (start !== -1) {
                  const text = JSON.parse(code.slice(start, code.lastIndexOf('}') + 1)).properties?.formattedCitation
                  if (text?.includes('\\')) await call('Field_setText', [args[0], args[1], text.startsWith('{\\rtf') ? text : `{\\rtf ${text}}`, true])
                }
              }
              return value
            }
            try { log(`${command.padEnd(20)} ${await runSession(command, invoke, session, ctx)}`) } finally { if (!native) sock.end() }
          }).catch((error) => log(`error: ${error.message}`))
          continue
        }
        const pending = waiting.get(id)
        if (!pending) continue
        waiting.delete(id)
        if (payload.startsWith('ERR:')) pending.reject(new Error(payload.slice(4)))
        else { try { pending.resolve(JSON.parse(payload)) } catch (error) { pending.reject(error) } }
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      closed = true
      waiting.forEach((pending) => pending.reject(new Error('The word processor closed the connection')))
      waiting.clear()
    })
  })
}

// ---------- HTTP citing protocol (GenOffice, web editors) ----------

const BOOKMARKLET_ORIGIN = 'https://www.zotero.org'
const LOCAL_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?$/i
const PATHS = new Map([
  ['/connector/ping', { methods: ['GET', 'POST'], types: ['application/json', 'text/plain'] }],
  ['/connector/document/execCommand', { methods: ['POST'], types: ['application/json'] }],
  ['/connector/document/respond', { methods: ['POST'], types: ['application/json'] }],
  ['/connector/sendToBack', { methods: ['GET', 'POST'], types: ['application/json'] }],
])

// The upstream protocol uses close-delimited HTTP/1.0 responses.
function reply(request, response, status, type, body = '') {
  const socket = response.socket
  if (!socket || socket.destroyed || socket.writableEnded) return
  let header = `HTTP/1.0 ${status} ${http.STATUS_CODES[status]}\r\nX-Zotero-Version: ${COMPAT_VERSION}\r\nX-Zotero-Connector-API-Version: 3\r\n`
  if (request.headers.origin === BOOKMARKLET_ORIGIN && LOCAL_HOST.test(request.headers.host || '')) {
    header += `Access-Control-Allow-Origin: ${BOOKMARKLET_ORIGIN}\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type,X-Zotero-Connector-API-Version,X-Zotero-Version\r\n`
  }
  if (type) header += `Content-Type: ${type}\r\n`
  if (!body) header += 'Content-Length: 0\r\n'
  socket.end(Buffer.from(header + '\r\n' + body))
}
const fieldTuple = (field) => (field ? [field.id, field.code, field.noteIndex] : null)
const fieldsTuple = (fields) => [fields.map((f) => f.id), fields.map((f) => f.code), fields.map((f) => f.noteIndex), fields.map((f) => f.adjacent)]

export function createHttpIntegrationServer(ctx, { log = () => {} } = {}) {
  let transaction = null
  const server = http.createServer(async (request, response) => {
    const send = (status, type, body) => reply(request, response, status, type, body)
    try {
      if (!LOCAL_HOST.test(request.headers.host || '')) { send(400, 'text/plain', 'Invalid Host header\n'); return }
      const pathname = request.url.split('?')[0], endpoint = PATHS.get(pathname)
      if (!endpoint) { send(404, 'text/plain', 'No endpoint found\n'); return }
      const method = request.method
      if (method === 'HEAD' || method === 'OPTIONS') { send(200); return }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { send(501, 'text/plain', 'Method not implemented\n'); return }
      let body = ''
      if (method !== 'GET') {
        if (!/^[0-9]+$/.test(request.headers['content-length'] || '') && method !== 'DELETE') { send(400, 'text/plain', 'Content-length not provided\n'); return }
        const chunks = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 20_000_000) { send(413, 'text/plain', 'Request is too large\n'); return }
          chunks.push(chunk)
        }
        body = Buffer.concat(chunks).toString('utf8')
      }
      if (!endpoint.methods.includes(method)) { send(400, 'text/plain', 'Endpoint does not support method\n'); return }
      // Same rule as Zotero: browsers must send a connector header (blocks cross-site form posts).
      const browser = request.headers['user-agent']?.startsWith('Mozilla/') || Object.hasOwn(request.headers, 'origin')
      if (browser && !request.headers['x-zotero-connector-api-version'] && !request.headers['zotero-allowed-request']
        && !(pathname === '/connector/ping' && request.headers['sec-fetch-mode'] === 'navigate')) { response.socket.destroy(); return }
      let data = null
      const type = request.headers['content-type']?.split(/\s*;/)[0]
      if (method !== 'GET' && type) {
        if (!endpoint.types.includes(type)) { send(400, 'text/plain', 'Endpoint does not support content-type\n'); return }
        if (type === 'application/json') {
          try { data = JSON.parse(body || 'null') } catch { send(400, 'text/plain', 'Invalid JSON provided\n'); return }
        } else data = body || null
      }
      if (pathname === '/connector/ping') {
        if (method === 'GET') send(200, 'text/html', '<!DOCTYPE html><html><body>Zotero is running</body></html>')
        else {
          const emptyHash = createHash('md5').update('').digest('hex')
          send(200, 'application/json', JSON.stringify({ prefs: {
            automaticSnapshots: false, downloadAssociatedFiles: false,
            supportsAttachmentUpload: false, supportsTagsAutocomplete: false, googleDocsAddNoteEnabled: false,
            googleDocsAddAnnotationEnabled: false, canUserAddNote: false, googleDocsCitationExplorerEnabled: false,
            translatorsHash: emptyHash, sortedTranslatorHash: emptyHash,
          } }))
        }
        return
      }
      if (pathname === '/connector/sendToBack') { send(200); return }
      if (pathname === '/connector/document/respond') {
        if (typeof data === 'string') { try { data = JSON.parse(data) } catch {} }
        if (!transaction?.waiting) { send(500); return }
        const waiting = transaction.waiting
        transaction.waiting = null; transaction.send = send
        if (data?.error) {
          const message = data.error === 'Alert' ? data.message : data.error === 'Tab Not Available Error'
            ? `The ${transaction.processorName || 'document'} tab is no longer available.` : 'HTTP integration error'
          waiting.reject(new Error(message))
        } else waiting.resolve(data)
        return
      }
      // execCommand
      if (typeof data?.command !== 'string') { send(400, 'text/plain', 'Missing command\n'); return }
      if (transaction) { send(503, 'text/plain', 'Integration transaction is already in progress'); return }
      const current = { send, waiting: null }
      transaction = current
      const call = async (rpc, args) => {
        const rpcArgs = rpc === 'Application.getActiveDocument' ? [] : args
        if (rpc === 'Document.complete') {
          current.send(200, 'application/json', JSON.stringify({ command: rpc, arguments: rpcArgs }))
          if (transaction === current) transaction = null
          return
        }
        const value = await new Promise((resolve, reject) => {
          current.waiting = { resolve, reject }
          current.send(200, 'application/json', JSON.stringify({ command: rpc, arguments: rpcArgs }))
        })
        if (rpc === 'Application.getActiveDocument') {
          current.processorName = value?.processorName || 'HTTP integration'
          return [3, value?.documentID, { outputFormat: value?.outputFormat || 'html', supportedNotes: value?.supportedNotes || ['footnotes'] }]
        }
        if (rpc === 'Document.cursorInField' || rpc === 'Document.insertField') return fieldTuple(value)
        if (rpc === 'Document.getFields') return fieldsTuple(value || [])
        return value
      }
      runSession(data.command, call, { fieldType: 'Http', outputFormat: 'html', supportedNotes: ['footnotes'],
        modernData: true, setBibliographyStyle: true, finalCommit: true, version: COMPAT_VERSION }, ctx)
        .then((note) => log(`${data.command.padEnd(20)} ${note}`))
        .catch((error) => { log(`error: ${error.message}`); current.send(500) })
        .finally(() => { if (transaction === current) transaction = null })
    } catch (error) { log(`HTTP error: ${error.message}`); send(500) }
  })
  // A document command waits for the user in the picker; never time it out.
  server.requestTimeout = 0
  return server
}

/**
 * Start both listeners. A port that is taken (usually by Zotero itself) is skipped with a
 * message instead of failing the whole app. Resolves to { tcp, http, close() }.
 */
export async function startIntegration(ctx, { tcpPort = TCP_PORT, httpPort = HTTP_PORT, host = '127.0.0.1', log = () => {}, warn = log, detectClient } = {}) {
  const listen = (server, port) => new Promise((resolve) => {
    const failed = (error) => {
      warn(error.code === 'EADDRINUSE'
        ? `Port ${port} is in use (is Zotero running?). Quit it to cite from Word/GenOffice with zotlet.`
        : `Cannot listen on port ${port}: ${error.message}`)
      resolve(null)
    }
    server.once('error', failed)
    server.listen(port, host, () => { server.off('error', failed); resolve(server) })
  })
  const [tcp, web] = await Promise.all([
    listen(createTcpServer(ctx, { log, detectClient }), tcpPort),
    listen(createHttpIntegrationServer(ctx, { log }), httpPort),
  ])
  return {
    tcp, http: web,
    close() {
      tcp?.close()
      if (web) { web.close(); web.closeAllConnections() }
    },
  }
}
