// Starting the real zotlet (java/build/lib/zotlet.jar) for the tests, a fake internet for its
// lookups, and an in-memory word processor that speaks the Zotero plugin protocol over TCP.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const JAR = path.join(ROOT, 'java', 'build', 'lib', 'zotlet.jar')

/** Build zotlet once per test file; a reason to skip the tests when that is not possible. */
export function buildOrSkip() {
  const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0
  if (!hasJava) return 'no JDK installed'
  // npm test builds once before the test files run (they run one after another).
  if (process.env.ZOTLET_SKIP_BUILD && fs.existsSync(JAR)) return false
  const built = spawnSync('sh', [path.join(ROOT, 'scripts', 'build-java.sh')], { cwd: ROOT, encoding: 'utf8' })
  return built.status === 0 ? false : `the Java build failed: ${built.stderr || built.stdout}`
}

/** A local HTTP server answering https://host/path requests (sent as /host/path) with `internet(url)`. */
export async function startInternet(internet) {
  const server = http.createServer(async (req, res) => {
    try {
      const r = await internet(`https://${req.url.slice(1)}`, { headers: req.headers })
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain' })
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch { req.socket.destroy() }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  server.base = `http://127.0.0.1:${server.address().port}`
  return server
}

/** zotlet, started like the launcher does (ZOTLET_HOME is the folder holding .zotlet). */
export function javaServer(dir, { libreOffice = false, fetchBase, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-jar', JAR, 'web', '--port', '0', '--tcp-port', '0', '--http-port', '0'], {
      env: { ...process.env, ZOTLET_HOME: path.dirname(dir), ZOTLET_FETCH_BASE: fetchBase || '',
        ZOTLET_PICKER: 'web', ZOTLET_OPEN_LOG: 'stdout', ZOTLET_TEST_CLIENT: libreOffice ? 'soffice' : '', NO_COLOR: '1', ZOTLET_WORD_MODE: '', ZOTLET_WORD_INSTALL: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const opened = [], info = {}
    let out = '', err = ''
    child.stderr.on('data', (d) => { err += d })
    child.stdout.on('data', (d) => {
      out += d
      for (;;) {
        const nl = out.indexOf('\n')
        if (nl < 0) break
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (line.startsWith('open: ')) opened.push(line.slice(6))
        let m
        if ((m = /zotlet . (http:\/\/127\.0\.0\.1:\d+\/)/.exec(line))) info.url = m[1]
        if ((m = /citations: on \(ports (\d+), (\d+)\)/.exec(line))) {
          info.tcp = Number(m[1]); info.http = Number(m[2])
          fetch(info.url).then((r) => r.text()).then((html) => {
            resolve({ name: 'java', ...info, opened, token: /name="zotlet-token" content="([0-9a-f]+)"/.exec(html)[1], close: () => child.kill() })
          }, reject)
        }
      }
    })
    child.on('exit', (code) => reject(new Error(`java exited (${code}): ${err}`)))
    setTimeout(() => { child.kill(); reject(new Error(`zotlet did not start within 60 s: ${err}`)) }, 60000).unref()
  })
}

/** In-memory word processor document answering the plugin RPCs (as in integration.test.js). */
export function fakeDocument({ outputFormat = 'rtf', data = '' } = {}) {
  const doc = { data, fields: [], cursor: null, alerts: [], completed: 0, bibliographyStyle: null, answer: 1 }
  let next = 1
  const field = (id) => doc.fields.find((f) => f.id === id)
  doc.handle = (method, args) => {
    switch (method.replace('_', '.')) {
      case 'Application.getActiveDocument': return [3, 'doc-1', { outputFormat }]
      case 'Document.getDocumentData': return doc.data
      case 'Document.setDocumentData': doc.data = args[1]; return null
      case 'Document.cursorInField': { const f = doc.cursor && field(doc.cursor); return f ? [f.id, f.code, 0] : null }
      case 'Document.insertField': { const f = { id: `f${next++}`, code: '', text: '' }; doc.fields.push(f); return [f.id, f.code, 0] }
      case 'Document.getFields': return [doc.fields.map((f) => f.id), doc.fields.map((f) => f.code), doc.fields.map(() => 0)]
      case 'Field.setCode': field(args[1]).code = args[2]; return null
      case 'Field.setText': field(args[1]).text = args[2]; return null
      case 'Field.removeCode': field(args[1]).code = ''; return null
      case 'Document.setBibliographyStyle': doc.bibliographyStyle = args.slice(1); return null
      case 'Document.displayAlert': doc.alerts.push(args[1]); return doc.answer
      case 'Document.complete': doc.completed++; return null
      default: throw new Error(`unexpected RPC ${method}`)
    }
  }
  return doc
}

export const frame = (id, value) => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(8)
  header.writeUInt32BE(id); header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

/** Answer the next picker the server opens: pick/get, then pick/done with `choose(spec)`. */
export async function answerPicker(server, choose) {
  for (let k = 0; !server.opened.length; k++) {
    if (k > 3000) throw new Error(`${server.name}: picker was never opened`)
    await new Promise((r) => setTimeout(r, 10))
  }
  const url = new URL(server.opened.shift())
  const headers = { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }
  const id = url.searchParams.get('id')
  const spec = await (await fetch(new URL('/api/pick/get', url), { method: 'POST', headers, body: JSON.stringify({ id }) })).json()
  const answer = choose(spec)
  await fetch(new URL('/api/pick/done', url), { method: 'POST', headers, body: JSON.stringify({ id, ...(answer || { cancel: true }) }) })
  return spec
}

/** One command over TCP 23116, as LibreOffice / GenOffice send it. Resolves with the picker spec (if any). */
export async function tcpCommand(server, doc, command, choose) {
  const sock = net.connect(server.tcp, '127.0.0.1')
  let buffer = Buffer.alloc(0), spec = null
  const done = new Promise((resolve, reject) => {
    sock.on('error', reject)
    sock.on('close', resolve)
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32BE(4)) {
        const id = buffer.readUInt32BE(), length = buffer.readUInt32BE(4)
        const [method, args] = JSON.parse(buffer.subarray(8, 8 + length).toString())
        buffer = buffer.subarray(8 + length)
        let reply
        try { reply = JSON.stringify(doc.handle(method, args) ?? null) } catch (e) { reply = `ERR:${e.message}` }
        const body = Buffer.from(reply), header = Buffer.alloc(8)
        header.writeUInt32BE(id); header.writeUInt32BE(body.length, 4)
        sock.write(Buffer.concat([header, body]))
        // LibreOffice keeps the connection; the command is over with Document.complete.
        if (method === 'Document_complete') setTimeout(() => sock.end(), 20)
      }
    })
  })
  const picked = choose ? answerPicker(server, choose).then((s) => { spec = s }) : Promise.resolve()
  sock.write(frame(0, { command }))
  await Promise.all([done, picked])
  return spec
}

export function unzip(buffer) {
  const files = {}
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let p = buffer.readUInt32LE(end + 16)
  for (let k = buffer.readUInt16LE(end + 10); k > 0; k--) {
    const size = buffer.readUInt32LE(p + 20), nameLength = buffer.readUInt16LE(p + 28), extra = buffer.readUInt16LE(p + 30), comment = buffer.readUInt16LE(p + 32)
    const offset = buffer.readUInt32LE(p + 42), name = buffer.toString('utf8', p + 46, p + 46 + nameLength)
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    files[name] = zlib.inflateRawSync(buffer.subarray(start, start + size)).toString('utf8')
    p += 46 + nameLength + extra + comment
  }
  return files
}

