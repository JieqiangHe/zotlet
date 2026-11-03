// HTTP Citing Protocol: each response carries the next document instruction.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { runSession, tty } from './session.js'

export const COMPAT_VERSION = '6.0.0'
const BOOKMARKLET_ORIGIN = 'https://www.zotero.org'
const HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?$/i
const PATHS = new Map([
  ['/connector/ping', { methods: ['GET', 'POST'], types: ['application/json', 'text/plain'] }],
  ['/connector/document/execCommand', { methods: ['POST'], types: ['application/json'] }],
  ['/connector/document/respond', { methods: ['POST'], types: ['application/json'] }],
  ['/connector/sendToBack', { methods: ['GET', 'POST'], types: ['application/json'] }],
])

// Node parses requests; the upstream HTTP/1.0 response is close-delimited and
// has no automatically added Date or Transfer-Encoding header.
function reply(request, response, status, type, body = '') {
  const socket = response.socket
  if (!socket || socket.destroyed || socket.writableEnded) return
  let header = `HTTP/1.0 ${status} ${http.STATUS_CODES[status]}\r\nX-Zotero-Version: ${COMPAT_VERSION}\r\nX-Zotero-Connector-API-Version: 3\r\n`
  if (request.headers.origin === BOOKMARKLET_ORIGIN && HOST.test(request.headers.host || '')) {
    header += `Access-Control-Allow-Origin: ${BOOKMARKLET_ORIGIN}\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type,X-Zotero-Connector-API-Version,X-Zotero-Version\r\n`
  }
  if (type) header += `Content-Type: ${type}\r\n`
  if (!body) header += 'Content-Length: 0\r\n'
  socket.end(Buffer.from(header + '\r\n' + body))
}
const fieldTuple = (field) => field ? [field.id, field.code, field.noteIndex] : null
const fieldsTuple = (fields) => [fields.map((f) => f.id), fields.map((f) => f.code), fields.map((f) => f.noteIndex), fields.map((f) => f.adjacent)]

export function createHttpServer() {
  let transaction = null
  const server = http.createServer(async (request, response) => {
    const send = (status, type, body) => reply(request, response, status, type, body)
    try {
      if (!HOST.test(request.headers.host || '')) { send(400, 'text/plain', 'Invalid Host header\n'); return }
      const pathname = request.url.split('?')[0], endpoint = PATHS.get(pathname)
      if (!endpoint) {
        console.log(tty.dim(`HTTP ${request.method} ${pathname} · unsupported endpoint · 404`))
        send(404, 'text/plain', 'No endpoint found\n'); return
      }
      const method = request.method
      if (method === 'HEAD' || method === 'OPTIONS') { send(200); return }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { send(501, 'text/plain', 'Method not implemented\n'); return }
      let body = ''
      if (method !== 'GET') {
        if (!/^[0-9]+$/.test(request.headers['content-length'] || '') && method !== 'DELETE') { send(400, 'text/plain', 'Content-length not provided\n'); return }
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        body = Buffer.concat(chunks).toString('utf8')
      }
      if (!endpoint.methods.includes(method)) { send(400, 'text/plain', 'Endpoint does not support method\n'); return }
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
          if (data === null) throw new Error('Missing ping data')
          const emptyHash = createHash('md5').update('').digest('hex')
          send(200, 'application/json', JSON.stringify({ prefs: {
            automaticSnapshots: false, downloadAssociatedFiles: false,
            supportsAttachmentUpload: true, supportsTagsAutocomplete: true, googleDocsAddNoteEnabled: true,
            googleDocsAddAnnotationEnabled: true, canUserAddNote: true, googleDocsCitationExplorerEnabled: false,
            translatorsHash: emptyHash, sortedTranslatorHash: emptyHash,
          } }))
        }
        return
      }
      if (pathname === '/connector/sendToBack') { send(200); return }
      if (pathname === '/connector/document/respond') {
        try { data = JSON.parse(data) } catch {}
        if (!transaction?.waiting) { send(500); return }
        const waiting = transaction.waiting
        transaction.waiting = null; transaction.send = send
        if (data?.error) {
          const message = data.error === 'Alert' ? data.message : data.error === 'Tab Not Available Error'
            ? `The operation cannot be completed because the ${transaction.processorName || 'Google Docs'} tab is no longer available.` : 'HTTP Integration Error'
          waiting.reject(new Error(message))
        } else waiting.resolve(data)
        return
      }
      if (transaction) { send(503, 'text/plain', 'Integration transaction is already in progress'); return }
      const current = { send, waiting: null }
      transaction = current
      const call = async (method, args) => {
        const rpcArgs = method === 'Application.getActiveDocument' ? [] : args
        if (method === 'Document.complete') {
          current.send(200, 'application/json', JSON.stringify({ command: method, arguments: rpcArgs }))
          transaction = null
          return
        }
        const value = await new Promise((resolve, reject) => {
          current.waiting = { resolve, reject }
          current.send(200, 'application/json', JSON.stringify({ command: method, arguments: rpcArgs }))
        })
        if (method === 'Application.getActiveDocument') {
          current.processorName = value.processorName || 'HTTP Integration'
          return [3, value.documentID, { outputFormat: value.outputFormat || 'html', supportedNotes: value.supportedNotes || ['footnotes'] }]
        }
        if (method === 'Document.cursorInField' || method === 'Document.insertField') return fieldTuple(value)
        if (method === 'Document.getFields') return fieldsTuple(value)
        return value
      }
      const time = new Date().toTimeString().slice(0, 8)
      runSession(data.command, call, { fieldType: 'Http', outputFormat: 'html', supportedNotes: ['footnotes'],
        modernData: true, setBibliographyStyle: true, finalCommit: true, version: COMPAT_VERSION })
        .then((note) => console.log(`${tty.dim(time)}  ${data.command.padEnd(20)} ${tty.dim(note || '')}`))
        .catch((error) => { console.error(tty.red(error.message)); current.send(500) })
    } catch (error) { console.error(tty.red(`HTTP: ${error.message}`)); send(500) }
  })
  // No recovery deadline: a missing continuation keeps execCommand busy.
  server.requestTimeout = 0
  return server
}
