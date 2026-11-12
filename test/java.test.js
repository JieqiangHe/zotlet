// The Java version (java/src, for TBtools and computers without Node) against the Node version:
// the same requests and the same word-processor sessions go to both servers, and their answers,
// exports and documents must be the same. Skipped when no JDK is installed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { fixture, fakeFetch, tempDir, makePdf } from './helpers.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const JAR = path.join(ROOT, 'java', 'build', 'lib', 'zotlet.jar')
const ELSEVIER = '10.1016/j.plaphy.2026.111729'
const SECOND = {
  type: 'journal-article', title: ['Second paper'], DOI: '10.1038/s41586-020-0001-x', 'container-title': ['Nature'],
  author: [{ given: 'Ada', family: 'Lovelace', sequence: 'first', affiliation: [{ name: 'X' }], role: 'author' }],
  issued: { 'date-parts': [[2020, 1, 2]] }, volume: '577', page: '1-5',
}
const fixtureText = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const APA = fixtureText('styles/apa.csl')
const DEPENDENT = fixtureText('dependent-style.csl')
const INDEX = [
  { title: 'Plant Physiology and Biochemistry', name: 'plant-physiology-and-biochemistry', dependent: 1, categories: { format: 'author-date', fields: ['botany'] }, updated: '2018-02-16T12:00:00+00:00' },
  { title: 'Elsevier - Harvard (with titles)', name: 'elsevier-harvard', dependent: 0, categories: { format: 'author-date', fields: ['generic-base'] } },
  { title: 'Nature', name: 'nature', dependent: 0, categories: { format: 'numeric', fields: ['science'] } },
  { title: 'broken', name: '../evil' },
]

// One fake internet for both servers: Node calls it directly, Java through a local HTTP mock.
const lookups = fakeFetch({ dois: { [ELSEVIER]: fixture('elsevier-crossref.json'), [SECOND.DOI]: SECOND }, pmids: { 31452104: fixture('pubmed.json') } })
async function internet(url, init) {
  if (url === 'https://www.zotero.org/styles-files/styles.json') return Response.json(INDEX)
  if (url === 'https://www.zotero.org/styles/plant-physiology-and-biochemistry') return new Response(DEPENDENT)
  if (url === 'https://www.zotero.org/styles/elsevier-harvard') return new Response(fixtureText('styles/elsevier-harvard.csl'))
  if (url.startsWith('https://www.zotero.org/') || url.startsWith('https://raw.githubusercontent.com/')) return new Response('not found', { status: 404 })
  return lookups(url, init)
}

const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0
let skip = !hasJava && 'no JDK installed'
if (!skip) {
  const built = spawnSync('sh', [path.join(ROOT, 'scripts', 'build-java.sh')], { cwd: ROOT, encoding: 'utf8' })
  if (built.status !== 0) skip = `the Java build failed: ${built.stderr || built.stdout}`
}

let mock
const servers = {}

/** The Node server, as the other tests start it. */
async function nodeServer(dir, { libreOffice = false } = {}) {
  const opened = []
  const server = await startServer({
    port: 0, dir, store: createStore({ dir }), fetchImpl: internet, quiet: true, openUrl: (url) => opened.push(url),
    integration: { tcpPort: 0, httpPort: 0, detectClient: async () => (libreOffice ? { pid: 1, command: 'soffice' } : null) },
  })
  return {
    name: 'node', url: server.url, token: server.token, opened,
    tcp: server.integration.tcp.address().port, http: server.integration.http.address().port,
    close: () => { server.close(); server.closeAllConnections() },
  }
}

/** The Java server, started like the launcher does (ZOTLET_HOME is the folder holding .zotlet). */
function javaServer(dir, { libreOffice = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-jar', JAR, 'web', '--port', '0', '--tcp-port', '0', '--http-port', '0'], {
      env: { ...process.env, ZOTLET_HOME: path.dirname(dir), ZOTLET_FETCH_BASE: `http://127.0.0.1:${mock.address().port}`,
        ZOTLET_PICKER: 'web', ZOTLET_OPEN_LOG: 'stdout', ZOTLET_TEST_CLIENT: libreOffice ? 'soffice' : '', NO_COLOR: '1' },
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
  })
}

function prepare(dir, items) {
  fs.mkdirSync(path.join(dir, 'styles'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'styles', 'apa.csl'), APA)
  if (items) fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(items))
  return dir
}

before(async () => {
  if (skip) return
  mock = http.createServer(async (req, res) => {
    try {
      const r = await internet(`https://${req.url.slice(1)}`, { headers: req.headers })
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain' })
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch { req.socket.destroy() }
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  for (const [name, start] of [['node', nodeServer], ['java', javaServer]]) {
    servers[name] = await start(prepare(path.join(tempDir(), '.zotlet')))
  }
})
after(() => {
  for (const s of Object.values(servers)) s.close()
  mock?.close()
})

async function call(server, route, body, { raw = false } = {}) {
  const res = await fetch(new URL(`api/${route}`, server.url), body === undefined
    ? { headers: { 'X-Zotlet-Token': server.token } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }, body: JSON.stringify(body) })
  if (raw) return res
  return { status: res.status, body: await res.json() }
}

/** Replace what is meant to differ (random ids, times, folders) by stable placeholders. */
function normalize(value, names = new Map()) {
  let text = JSON.stringify(value)
  const stable = (pattern, prefix) => {
    text = text.replace(pattern, (whole, id) => {
      if (!names.has(id)) names.set(id, `${prefix}${names.size}`)
      return whole.replace(id, names.get(id))
    })
  }
  stable(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g, 'uuid')
  stable(/\\"citationID\\":\\"([A-Za-z0-9]{8})\\"/g, 'cid')
  stable(/"citationID":"([A-Za-z0-9]{8})"/g, 'cid')
  stable(/session id=\\"([A-Za-z0-9]{8})\\"/g, 'sid')
  stable(/\\"sessionID\\":\\"([A-Za-z0-9]{8})\\"/g, 'sid')
  text = text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'TIME')
  text = text.replace(/"(library|state)":"[^"]*"/g, '"$1":"PATH"')
  return JSON.parse(text)
}

/** The same request to both servers; the normalized answers must be equal. Returns Node's. */
async function both(route, body) {
  const bodyFor = (s) => (typeof body === 'function' ? body(s) : body)
  const [a, b] = [await call(servers.node, route, bodyFor(servers.node)), await call(servers.java, route, bodyFor(servers.java))]
  assert.deepEqual(normalize(b), normalize(a), `${route} ${JSON.stringify(body)?.slice(0, 200)}`)
  return a
}

function unzip(buffer) {
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

test('API: imports, projects, edits, citations and errors answer the same', { skip }, async () => {
  await both('state')
  await both('import', { text: `https://doi.org/${ELSEVIER}\n${SECOND.DOI}, PMID: 31452104 not-an-id` })
  await both('import', { text: ELSEVIER.toUpperCase() })
  await both('import', { text: '' })
  await both('projects/create', { name: '  Review   paper ' })
  await both('projects/create', { name: 'review PAPER' })
  await both('projects/create', {})
  const projectId = async (s) => (await call(s, 'state')).body.projects[0].id
  const own = { node: await projectId(servers.node), java: await projectId(servers.java) }
  await both('projects/rename', (s) => ({ id: own[s.name], name: 'Review paper v2' }))
  await both('projects/create', { name: 'Second project' })
  await both('projects/rename', (s) => ({ id: own[s.name], name: 'SECOND project' }))
  await both('projects/rename', { id: 'nope', name: 'x' })
  // The project ids differ between the servers; use each one's own.
  await both('import', (s) => ({ text: SECOND.DOI, projectId: own[s.name] }))
  await both('projects/add', (s) => ({ id: own[s.name], itemIds: ['zhang2026', 'nope'] }))
  await both('projects/add', (s) => ({ id: own[s.name], itemIds: 'zhang2026' }))
  await both('projects/remove', (s) => ({ id: own[s.name], itemIds: ['zhang2026'] }))
  await both('state')
  await both('projects/delete', (s) => ({ id: own[s.name] }))
  await both('projects/delete', (s) => ({ id: own[s.name] }))
  await both('state')
  await both('cite', { style: 'nature' })
  await both('cite', { style: 'apa', ids: ['zhang2026', 'lovelace2020'] })
  await both('cite', { style: 'cell', ids: ['lovelace2020'] })
  await both('cite', { style: 'nature', ids: [] })
  await both('cite', { style: 'unknown' })
  await both('items/create', { fields: { title: 'Hand-made <i>TeX</i>', author: [{ family: 'Knuth', given: 'Donald', junk: 1 }, 'Org Name'], issued: { 'date-parts': [['1984', '13']] }, type: 'book', volume: 12 } })
  await both('items/create', { fields: { title: 'Dup', DOI: ELSEVIER } })
  await both('items/create', { fields: { volume: '1' } })
  await both('items/update', { id: 'knuth1984', fields: { title: 'The TeXbook', publisher: 'Addison-Wesley', volume: null } })
  await both('items/update', { id: 'knuth1984', fields: { title: '' } })
  await both('items/update', { id: 'knuth1984', fields: { bogus: 'x' } })
  await both('items/update', { id: 'missing', fields: { title: 'x' } })
  await both('import-csl', { items: [{ type: 'book', title: 'From Zotero', author: [{ family: 'Elsewhere', given: 'E', 'dropping-particle': 'van' }], issued: { 'date-parts': [[2001]] }, extra: 'x' }, { nope: 1 }, 'x', { title: ['', 'Array title'], DOI: 'doi:10.5555/ABC.' }] })
  await both('import-csl', { items: [] })
  await both('items/delete', { ids: ['knuth1984'] })
  await both('state')

  // Exports: every format, byte for byte (the zip by content).
  const ids = (await call(servers.node, 'state')).body.items.map((i) => i.id)
  for (const format of ['json', 'bibtex', 'ris', 'zip']) {
    for (const scope of [{ ids, name: 'library' }, { ids: ids.slice(0, 1), name: 'Thesis / ch. 1' }, { name: 'Ünïcode “quotes”' }]) {
      const [a, b] = [await call(servers.node, 'export', { format, ...scope }, { raw: true }), await call(servers.java, 'export', { format, ...scope }, { raw: true })]
      for (const h of ['content-type', 'content-disposition', 'x-item-count']) assert.equal(b.headers.get(h), a.headers.get(h), `${format} ${h}`)
      const [x, y] = [Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())]
      if (format === 'zip') assert.deepEqual(unzip(y), unzip(x))
      else assert.equal(y.toString('utf8'), x.toString('utf8'), `${format} ${scope.name}`)
    }
  }
  await both('export', { format: 'docx', ids })
  for (const s of Object.values(servers)) {
    const res = await call(s, 'state', undefined, { raw: true })
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/)
  }
})

test('API: security checks and the static page', { skip }, async () => {
  for (const s of Object.values(servers)) {
    const bad = await fetch(new URL('api/state', s.url), { headers: { 'X-Zotlet-Token': 'nope' } })
    assert.equal(bad.status, 403, s.name)
    const host = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: new URL(s.url).port, path: '/api/ping', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject)
    })
    assert.equal(host, 403, s.name)
    const html = await (await fetch(s.url)).text()
    assert.ok(html.includes(s.token))
    for (const asset of ['app.js', 'style.css', 'theme.js', 'pick.html', 'pick.js']) assert.equal((await fetch(new URL(asset, s.url))).status, 200, `${s.name} ${asset}`)
    assert.equal((await fetch(new URL('../package.json', s.url))).status, 404)
    const notJson = await fetch(new URL('api/import', s.url), { method: 'POST', headers: { 'X-Zotlet-Token': s.token, 'Content-Type': 'text/plain' }, body: 'x' })
    assert.equal(notJson.status, 415, s.name)
  }
})

test('API: PDFs dropped on the list import by DOI', { skip }, async () => {
  const pdf = makePdf({ pages: [`[(Plant Physiology and Biochemistry 2026)-250(https://doi.org/10.1016/j.pla)12(phy.2026.111729)-300(Received)]TJ`, `(Footer: https://doi.org/10.1016/j.plaphy.2026.111729)Tj`] })
  const xmp = makePdf({ pages: ['(see 10.1038/s41586-020-0001-x)Tj'], xmp: '<x:xmpmeta><rdf:RDF><rdf:Description><prism:doi>10.1093/plcell/koab001</prism:doi></rdf:Description></rdf:RDF></x:xmpmeta>' })
  const none = makePdf({ pages: ['(no identifier here)Tj'] })
  for (const [body, name] of [[pdf, 'Zhang 2026.pdf'], [xmp, 'meta.pdf'], [none, 'none.pdf'], [Buffer.from('hello'), 'fake.pdf']]) {
    const answers = []
    for (const s of [servers.node, servers.java]) {
      const res = await fetch(new URL('api/pdf/import', s.url), { method: 'POST', body, headers: { 'Content-Type': 'application/pdf', 'X-Zotlet-Token': s.token, 'X-File-Name': encodeURIComponent(name) } })
      answers.push([res.status, await res.json()])
    }
    assert.deepEqual(answers[1], answers[0], name)
  }
})

test('styles: search, install a journal style with its parent, add a file, remove', { skip }, async () => {
  await both('styles/search', { query: '' })
  await both('styles/search', { query: 'plant' })
  await both('styles/install', { name: 'plant-physiology-and-biochemistry' })
  await both('styles/install', { name: 'no-such-style' })
  await both('styles/remove', { id: 'elsevier-harvard' })
  await both('cite', { style: 'plant-physiology-and-biochemistry', ids: ['zhang2026'] })
  await both('styles/add', { xml: APA.replace('http://www.zotero.org/styles/apa', 'http://www.zotero.org/styles/apa-copy').replace(/<title>[^<]*/, '<title>APA copy') })
  await both('styles/add', { xml: '<not-a-style/>' })
  await both('styles/add', { xml: fixtureText('styles/apa.csl').replace('http://www.zotero.org/styles/apa', 'http://www.zotero.org/styles/nature') })
  await both('styles/remove', { id: 'plant-physiology-and-biochemistry' })
  await both('styles/remove', { id: 'nature' })
  await both('state')
})

// ---------- word processors ----------

const ITEMS = [
  { id: 'lovelace2020', type: 'article-journal', title: 'Second paper', 'container-title': 'Nature',
    author: [{ family: 'Lovelace', given: 'Ada' }], issued: { 'date-parts': [[2020]] }, volume: '577', page: '1-5', DOI: '10.1/love' },
  { id: 'hopper2019', type: 'article-journal', title: 'A <i>compiler</i> paper', 'container-title': 'Science',
    author: [{ family: 'Hopper', given: 'Grace' }], issued: { 'date-parts': [[2019]] }, volume: '1', page: '2-3', DOI: '10.1/hopper' },
  { id: 'hopper2019a', type: 'book', title: 'Another one', author: [{ family: 'Hopper', given: 'Grace' }], issued: { 'date-parts': [[2019]] }, publisher: 'Navy' },
]

/** In-memory word processor document answering the plugin RPCs (as in integration.test.js). */
function fakeDocument({ outputFormat = 'rtf', data = '' } = {}) {
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

const frame = (id, value) => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(8)
  header.writeUInt32BE(id); header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

/** Answer the next picker the server opens: pick/get, then pick/done with `choose(spec)`. */
async function answerPicker(server, choose) {
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
async function tcpCommand(server, doc, command, choose) {
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

/** One command over the HTTP citing protocol (23119): each response carries the next RPC. */
async function httpCommand(server, doc, command, choose) {
  const base = `http://127.0.0.1:${server.http}/connector/`
  const post = async (route, body) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotero-Connector-API-Version': '3' }, body: JSON.stringify(body) })
    assert.equal(res.status, 200, `${server.name} ${route}`)
    return res.json()
  }
  let spec = null
  const picked = choose ? answerPicker(server, choose).then((s) => { spec = s }) : Promise.resolve()
  let step = await post('document/execCommand', { command, docId: 'doc-1' })
  while (step.command !== 'Document.complete') {
    let value = doc.handle(step.command, step.arguments)
    if (step.command === 'Application.getActiveDocument') value = { documentID: 'doc-1', outputFormat: 'html', processorName: 'GenOffice' }
    else if (step.command === 'Document.insertField' || step.command === 'Document.cursorInField') value = value && { id: value[0], code: value[1], noteIndex: 0 }
    else if (step.command === 'Document.getFields') value = value[0].map((id, k) => ({ id, code: value[1][k], noteIndex: 0 }))
    step = await post('document/respond', value)
  }
  doc.completed++
  await picked
  return spec
}

const snapshot = (doc, spec) => normalize({ data: doc.data, fields: doc.fields, alerts: doc.alerts, completed: doc.completed, bibliographyStyle: doc.bibliographyStyle, spec })

/** Run the same document steps against a Node and a Java server; compare after every step. */
async function sameDocuments(label, { libreOffice = false, transport = tcpCommand, outputFormat = 'rtf', data = '', steps }) {
  const pair = {}
  for (const [name, start] of [['node', nodeServer], ['java', javaServer]]) pair[name] = await start(prepare(path.join(tempDir(), '.zotlet'), ITEMS), { libreOffice })
  try {
    const docs = { node: fakeDocument({ outputFormat, data }), java: fakeDocument({ outputFormat, data }) }
    for (const [k, step] of steps.entries()) {
      const shots = {}
      for (const name of ['node', 'java']) {
        step.before?.(docs[name])
        const spec = await transport(pair[name], docs[name], step.command, step.choose)
        shots[name] = snapshot(docs[name], spec && { ...spec, styles: spec.styles.map((s) => s.id) })
      }
      assert.deepEqual(shots.java, shots.node, `${label}, step ${k + 1} (${step.command})`)
      step.check?.(docs.java)
    }
    return docs.java
  } finally {
    for (const s of Object.values(pair)) s.close()
  }
}

const cite = (ids, style) => () => (style ? { ids, style } : { ids })
const codeOf = (f) => JSON.parse(f.code.slice(f.code.indexOf('{')))

test('GenOffice (TCP): cite, bibliography, edit, style change, refresh, unlink', { skip }, async () => {
  await sameDocuments('GenOffice TCP', { steps: [
    { command: 'addEditCitation', choose: cite(['lovelace2020', 'hopper2019'], 'nature'), check: (d) => assert.match(d.fields[0].text, /^\{\\rtf /) },
    { command: 'addEditBibliography', check: (d) => assert.match(d.fields[1].text, /Lovelace/) },
    { command: 'addEditCitation', choose: cite(['hopper2019a']) },
    { command: 'addEditCitation', before: (d) => { const f = d.fields[0], j = codeOf(f); j.citationItems[0].locator = '12'; f.code = `ITEM CSL_CITATION ${JSON.stringify(j)}`; d.cursor = f.id },
      choose: cite(['lovelace2020', 'hopper2019', 'hopper2019a']) },
    { command: 'setDocPrefs', before: (d) => { d.cursor = null }, choose: () => ({ style: 'apa' }), check: (d) => assert.match(d.data, /styles\/apa/) },
    { command: 'refresh' },
    { command: 'addEditCitation', choose: () => null },
    { command: 'removeCodes', before: (d) => { d.answer = 0 } },
    { command: 'removeCodes', before: (d) => { d.answer = 1 }, check: (d) => assert.ok(d.fields.every((f) => !f.code)) },
  ] })
})

test('LibreOffice (TCP, newer data format): bookmarks for Word, bibliography paragraph style', { skip }, async () => {
  await sameDocuments('LibreOffice TCP', { libreOffice: true, steps: [
    { command: 'setDocPrefs', choose: () => ({ style: 'apa', bookmarks: true }), check: (d) => assert.match(d.data, /<pref name="fieldType" value="Bookmark"\/>/) },
    { command: 'addEditCitation', choose: cite(['hopper2019', 'hopper2019a']) },
    { command: 'addEditBibliography', check: (d) => assert.ok(d.bibliographyStyle) },
    { command: 'setDocPrefs', choose: () => ({ style: 'cell', bookmarks: false }) },
    { command: 'refresh' },
  ] })
})

test('Word documents written by Zotero: field type kept, items matched by DOI, embedded data refreshed', { skip }, async () => {
  const zoteroURI = 'http://zotero.org/users/123/items/ABCD1234'
  const data = '<data data-version="3" zotero-version="7.0.11"><session id="Zs1"/><style id="http://www.zotero.org/styles/apa" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="true"/></prefs></data>'
  const zoteroField = (d) => d.fields.push({ id: 'z1', text: 'old', code: `ITEM CSL_CITATION ${JSON.stringify({ citationID: 'c1', properties: {}, citationItems: [
    { id: 9876, uris: [zoteroURI], locator: '5', itemData: { id: 9876, type: 'article-journal', title: 'Zotero copy', DOI: 'https://doi.org/10.1/HOPPER', author: [{ family: 'Hopper', given: 'G' }], issued: { 'date-parts': [[2019]] } } },
    { id: 42, uris: ['http://zotero.org/users/123/items/ZZZZ'], itemData: { id: 42, type: 'book', title: 'Only in Zotero', author: [{ family: 'Elsewhere', given: 'E' }], issued: { 'date-parts': [[2001]] } } }] })}` })
  const doc = await sameDocuments('Zotero/Word document', { data, steps: [
    { command: 'refresh', before: zoteroField },
    { command: 'addEditCitation', before: (d) => { d.cursor = 'z1' }, choose: cite(['hopper2019', 'lovelace2020', '42']) },
    { command: 'addEditBibliography' },
  ] })
  assert.match(doc.data, /<pref name="fieldType" value="Field"\/>/)
  assert.deepEqual(codeOf(doc.fields[0]).citationItems[0].uris, [zoteroURI, 'http://zotero.org/users/local/zotlet/items/' + codeOf(doc.fields[0]).citationItems[0].uris[1].split('/').pop()])
})

test('a document whose style is not installed is downloaded first, or left alone', { skip }, async () => {
  const data = (style) => `<data data-version="3" zotero-version="7.0"><session id="s0000001"/><style id="http://www.zotero.org/styles/${style}" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="ReferenceMark"/></prefs></data>`
  await sameDocuments('missing style, downloadable', { data: data('elsevier-harvard'), steps: [{ command: 'addEditCitation', choose: cite(['hopper2019']) }] })
  await sameDocuments('missing style, not downloadable', { data: data('no-such-style'), steps: [{ command: 'addEditCitation' }] })
})

test('HTTP citing protocol (23119): the execCommand / respond loop', { skip }, async () => {
  await sameDocuments('HTTP', { transport: httpCommand, outputFormat: 'html', steps: [
    { command: 'addEditCitation', choose: cite(['hopper2019'], 'science') },
    { command: 'addEditBibliography' },
    { command: 'setDocPrefs', choose: () => ({ style: 'apa' }) },
  ] })
  for (const s of Object.values(servers)) {
    const base = `http://127.0.0.1:${s.http}/connector/`
    await assert.rejects(fetch(base + 'document/execCommand', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' }), s.name)
    assert.equal((await fetch(base + 'ping')).status, 200)
    assert.equal((await fetch(base + 'nothing')).status, 404)
  }
})
