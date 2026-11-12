// zotlet end to end: API requests, exports, PDFs, style installs and word-processor sessions
// (GenOffice / LibreOffice over TCP, the HTTP protocol, Word documents written by Zotero) go to a
// real zotlet server, and every answer and resulting document must equal the recorded one in
// test/fixtures/golden.json. Those answers were recorded from the original Node implementation of
// zotlet (which the user ran with GenOffice), before it was removed. Skipped when no JDK is installed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fixture, fakeFetch, tempDir, makePdf } from './helpers.js'
import { buildOrSkip, startInternet, javaServer, fakeDocument, answerPicker, tcpCommand, unzip } from './zotlet.js'

const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'))
let current = { name: '', n: 0 }
/** The normalized `value` must equal the recorded answer for this step of the current test. */
function expectGolden(value, what = '') {
  const key = `${current.name} #${++current.n}`
  assert.deepEqual(normalize(value), golden[key], `${key} ${what}`.slice(0, 300))
}
const begin = (name) => { current = { name, n: 0 } }
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

// The fake internet zotlet's lookups and style downloads reach (through startInternet).
const lookups = fakeFetch({ dois: { [ELSEVIER]: fixture('elsevier-crossref.json'), [SECOND.DOI]: SECOND }, pmids: { 31452104: fixture('pubmed.json') } })
async function internet(url, init) {
  if (url === 'https://www.zotero.org/styles-files/styles.json') return Response.json(INDEX)
  if (url === 'https://www.zotero.org/styles/plant-physiology-and-biochemistry') return new Response(DEPENDENT)
  if (url === 'https://www.zotero.org/styles/elsevier-harvard') return new Response(fixtureText('styles/elsevier-harvard.csl'))
  if (url.startsWith('https://www.zotero.org/') || url.startsWith('https://raw.githubusercontent.com/')) return new Response('not found', { status: 404 })
  return lookups(url, init)
}

const skip = buildOrSkip()

let mock
const servers = {}

function prepare(dir, items) {
  fs.mkdirSync(path.join(dir, 'styles'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'styles', 'apa.csl'), APA)
  if (items) fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(items))
  return dir
}

before(async () => {
  if (skip) return
  mock = await startInternet(internet)
  servers.app = await javaServer(prepare(path.join(tempDir(), '.zotlet')), { fetchBase: mock.base })
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

/** A request whose normalized answer must equal the recorded one. */
async function ask(route, body) {
  const s = servers.app
  const answer = await call(s, route, typeof body === 'function' ? body(s) : body)
  expectGolden(answer, `${route} ${JSON.stringify(typeof body === 'function' ? body(s) : body)}`)
  return answer
}

test('API: imports, projects, edits, citations and errors', { skip }, async (t) => {
  begin(t.name)
  await ask('state')
  await ask('import', { text: `https://doi.org/${ELSEVIER}\n${SECOND.DOI}, PMID: 31452104 not-an-id` })
  await ask('import', { text: ELSEVIER.toUpperCase() })
  await ask('import', { text: '' })
  await ask('projects/create', { name: '  Review   paper ' })
  await ask('projects/create', { name: 'review PAPER' })
  await ask('projects/create', {})
  const projectId = async (s) => (await call(s, 'state')).body.projects[0].id
  const own = { app: await projectId(servers.app) }
  await ask('projects/rename', (s) => ({ id: own.app, name: 'Review paper v2' }))
  await ask('projects/create', { name: 'Second project' })
  await ask('projects/rename', (s) => ({ id: own.app, name: 'SECOND project' }))
  await ask('projects/rename', { id: 'nope', name: 'x' })
  // The project ids differ between the servers; use each one's own.
  await ask('import', (s) => ({ text: SECOND.DOI, projectId: own.app }))
  await ask('projects/add', (s) => ({ id: own.app, itemIds: ['zhang2026', 'nope'] }))
  await ask('projects/add', (s) => ({ id: own.app, itemIds: 'zhang2026' }))
  await ask('projects/remove', (s) => ({ id: own.app, itemIds: ['zhang2026'] }))
  await ask('state')
  await ask('projects/delete', (s) => ({ id: own.app }))
  await ask('projects/delete', (s) => ({ id: own.app }))
  await ask('state')
  await ask('cite', { style: 'nature' })
  await ask('cite', { style: 'apa', ids: ['zhang2026', 'lovelace2020'] })
  await ask('cite', { style: 'cell', ids: ['lovelace2020'] })
  await ask('cite', { style: 'nature', ids: [] })
  await ask('cite', { style: 'unknown' })
  await ask('items/create', { fields: { title: 'Hand-made <i>TeX</i>', author: [{ family: 'Knuth', given: 'Donald', junk: 1 }, 'Org Name'], issued: { 'date-parts': [['1984', '13']] }, type: 'book', volume: 12 } })
  await ask('items/create', { fields: { title: 'Dup', DOI: ELSEVIER } })
  await ask('items/create', { fields: { volume: '1' } })
  await ask('items/update', { id: 'knuth1984', fields: { title: 'The TeXbook', publisher: 'Addison-Wesley', volume: null } })
  await ask('items/update', { id: 'knuth1984', fields: { title: '' } })
  await ask('items/update', { id: 'knuth1984', fields: { bogus: 'x' } })
  await ask('items/update', { id: 'missing', fields: { title: 'x' } })
  await ask('import-csl', { items: [{ type: 'book', title: 'From Zotero', author: [{ family: 'Elsewhere', given: 'E', 'dropping-particle': 'van' }], issued: { 'date-parts': [[2001]] }, extra: 'x' }, { nope: 1 }, 'x', { title: ['', 'Array title'], DOI: 'doi:10.5555/ABC.' }] })
  await ask('import-csl', { items: [] })
  await ask('items/delete', { ids: ['knuth1984'] })
  await ask('state')

  // Exports: every format, byte for byte (the zip by content).
  const ids = (await call(servers.app, 'state')).body.items.map((i) => i.id)
  for (const format of ['json', 'bibtex', 'ris', 'zip']) {
    for (const scope of [{ ids, name: 'library' }, { ids: ids.slice(0, 1), name: 'Thesis / ch. 1' }, { name: 'Ünïcode “quotes”' }]) {
      const res = await call(servers.app, 'export', { format, ...scope }, { raw: true })
      const headers = Object.fromEntries(['content-type', 'content-disposition', 'x-item-count'].map((h) => [h, res.headers.get(h)]))
      const bytes = Buffer.from(await res.arrayBuffer())
      expectGolden({ headers, body: format === 'zip' ? unzip(bytes) : bytes.toString('utf8') }, `export ${format} ${scope.name}`)
    }
  }
  await ask('export', { format: 'docx', ids })
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

test('API: PDFs dropped on the list import by DOI', { skip }, async (t) => {
  begin(t.name)
  const pdf = makePdf({ pages: [`[(Plant Physiology and Biochemistry 2026)-250(https://doi.org/10.1016/j.pla)12(phy.2026.111729)-300(Received)]TJ`, `(Footer: https://doi.org/10.1016/j.plaphy.2026.111729)Tj`] })
  const xmp = makePdf({ pages: ['(see 10.1038/s41586-020-0001-x)Tj'], xmp: '<x:xmpmeta><rdf:RDF><rdf:Description><prism:doi>10.1093/plcell/koab001</prism:doi></rdf:Description></rdf:RDF></x:xmpmeta>' })
  const none = makePdf({ pages: ['(no identifier here)Tj'] })
  for (const [body, name] of [[pdf, 'Zhang 2026.pdf'], [xmp, 'meta.pdf'], [none, 'none.pdf'], [Buffer.from('hello'), 'fake.pdf']]) {
    const s = servers.app
    const res = await fetch(new URL('api/pdf/import', s.url), { method: 'POST', body, headers: { 'Content-Type': 'application/pdf', 'X-Zotlet-Token': s.token, 'X-File-Name': encodeURIComponent(name) } })
    expectGolden([res.status, await res.json()], name)
  }
})

test('styles: search, install a journal style with its parent, add a file, remove', { skip }, async (t) => {
  begin(t.name)
  await ask('styles/search', { query: '' })
  await ask('styles/search', { query: 'plant' })
  await ask('styles/install', { name: 'plant-physiology-and-biochemistry' })
  await ask('styles/install', { name: 'no-such-style' })
  await ask('styles/remove', { id: 'elsevier-harvard' })
  await ask('cite', { style: 'plant-physiology-and-biochemistry', ids: ['zhang2026'] })
  await ask('styles/add', { xml: APA.replace('http://www.zotero.org/styles/apa', 'http://www.zotero.org/styles/apa-copy').replace(/<title>[^<]*/, '<title>APA copy') })
  await ask('styles/add', { xml: '<not-a-style/>' })
  await ask('styles/add', { xml: fixtureText('styles/apa.csl').replace('http://www.zotero.org/styles/apa', 'http://www.zotero.org/styles/nature') })
  await ask('styles/remove', { id: 'plant-physiology-and-biochemistry' })
  await ask('styles/remove', { id: 'nature' })
  await ask('state')
})

// ---------- word processors ----------

const ITEMS = [
  { id: 'lovelace2020', type: 'article-journal', title: 'Second paper', 'container-title': 'Nature',
    author: [{ family: 'Lovelace', given: 'Ada' }], issued: { 'date-parts': [[2020]] }, volume: '577', page: '1-5', DOI: '10.1/love' },
  { id: 'hopper2019', type: 'article-journal', title: 'A <i>compiler</i> paper', 'container-title': 'Science',
    author: [{ family: 'Hopper', given: 'Grace' }], issued: { 'date-parts': [[2019]] }, volume: '1', page: '2-3', DOI: '10.1/hopper' },
  { id: 'hopper2019a', type: 'book', title: 'Another one', author: [{ family: 'Hopper', given: 'Grace' }], issued: { 'date-parts': [[2019]] }, publisher: 'Navy' },
]

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

/** Run document steps against a fresh server; after every step the document must equal the recorded one. */
async function sameDocuments(label, { libreOffice = false, transport = tcpCommand, outputFormat = 'rtf', data = '', steps }) {
  const server = await javaServer(prepare(path.join(tempDir(), '.zotlet'), ITEMS), { libreOffice, fetchBase: mock.base })
  try {
    const doc = fakeDocument({ outputFormat, data })
    for (const [k, step] of steps.entries()) {
      step.before?.(doc)
      const spec = await transport(server, doc, step.command, step.choose)
      expectGolden(snapshot(doc, spec && { ...spec, styles: spec.styles.map((s) => s.id) }), `${label}, step ${k + 1} (${step.command})`)
      step.check?.(doc)
    }
    return doc
  } finally {
    server.close()
  }
}

const cite = (ids, style) => () => (style ? { ids, style } : { ids })
const codeOf = (f) => JSON.parse(f.code.slice(f.code.indexOf('{')))

test('GenOffice (TCP): cite, bibliography, edit, style change, refresh, unlink', { skip }, async (t) => {
  begin(t.name)
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

test('LibreOffice (TCP, newer data format): bookmarks for Word, bibliography paragraph style', { skip }, async (t) => {
  begin(t.name)
  await sameDocuments('LibreOffice TCP', { libreOffice: true, steps: [
    { command: 'setDocPrefs', choose: () => ({ style: 'apa', bookmarks: true }), check: (d) => assert.match(d.data, /<pref name="fieldType" value="Bookmark"\/>/) },
    { command: 'addEditCitation', choose: cite(['hopper2019', 'hopper2019a']) },
    { command: 'addEditBibliography', check: (d) => assert.ok(d.bibliographyStyle) },
    { command: 'setDocPrefs', choose: () => ({ style: 'cell', bookmarks: false }) },
    { command: 'refresh' },
  ] })
})

test('Word documents written by Zotero: field type kept, items matched by DOI, embedded data refreshed', { skip }, async (t) => {
  begin(t.name)
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

test('a document whose style is not installed is downloaded first, or left alone', { skip }, async (t) => {
  begin(t.name)
  const data = (style) => `<data data-version="3" zotero-version="7.0"><session id="s0000001"/><style id="http://www.zotero.org/styles/${style}" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="ReferenceMark"/></prefs></data>`
  await sameDocuments('missing style, downloadable', { data: data('elsevier-harvard'), steps: [{ command: 'addEditCitation', choose: cite(['hopper2019']) }] })
  await sameDocuments('missing style, not downloadable', { data: data('no-such-style'), steps: [{ command: 'addEditCitation' }] })
})

test('HTTP citing protocol (23119): the execCommand / respond loop', { skip }, async (t) => {
  begin(t.name)
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

// ---------- data files and lookups (checked directly, not against recordings) ----------

test('library files: ids and unknown fields survive every write; a corrupt file is never overwritten', { skip }, async () => {
  const dir = path.join(tempDir(), '.zotlet')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([
    { id: 'keep-me', type: 'book', title: 'Old', note_from_zotero: 'x', author: [{ family: 'Van', 'non-dropping-particle': 'de', given: 'A' }] },
    { id: 42, type: 'book', title: 'Numeric id from an old version' },
  ]))
  fs.writeFileSync(path.join(dir, 'web-state.json'), JSON.stringify({ version: 1, roots: ['/old'], activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Old project', itemIds: ['keep-me', 'keep-me', 'gone'], color: 'red' }] }))
  const s = await javaServer(dir, { fetchBase: mock.base })
  try {
    assert.equal((await call(s, 'items/update', { id: 'keep-me', fields: { title: 'New' } })).status, 200)
    assert.equal((await call(s, 'projects/rename', { id: 'p1', name: 'Renamed' })).status, 200)
    const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
    assert.deepEqual(lib[0], { id: 'keep-me', type: 'book', title: 'New', note_from_zotero: 'x', author: [{ family: 'Van', 'non-dropping-particle': 'de', given: 'A' }] })
    assert.equal(lib[1].id, 42, 'ids are never changed')
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'web-state.json'), 'utf8'))
    assert.deepEqual(state.roots, ['/old'])
    assert.equal(state.activeProject, 'p1')
    assert.deepEqual(state.projects[0], { id: 'p1', name: 'Renamed', itemIds: ['keep-me', 'gone'], color: 'red' })
    assert.equal((await call(s, 'projects/delete', { id: 'p1' })).status, 200)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'web-state.json'), 'utf8')).activeProject, null)

    fs.writeFileSync(path.join(dir, 'library.json'), '[{"id": "broken"')
    const res = await call(s, 'items/create', { fields: { title: 'Must not be written' } })
    assert.equal(res.status, 500)
    assert.match(res.body.error, /library\.json is not valid JSON/)
    assert.equal(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'), '[{"id": "broken"', 'left as it was')
  } finally { s.close() }
})

test('DOI lookup falls back to PubMed when doi.org and Crossref cannot be reached', { skip }, async () => {
  const doi = '10.1038/s41467-019-11806-2'
  const record = { ...fixture('pubmed.json'), DOI: doi }
  const offline = await startInternet(fakeFetch({ unreachable: ['doi.org', 'api.crossref.org'],
    pubmedSearch: { [`${doi.toLowerCase()}[doi]`]: ['31452104'] }, pmids: { 31452104: record } }))
  const s = await javaServer(prepare(path.join(tempDir(), '.zotlet')), { fetchBase: offline.base })
  try {
    const { body } = await call(s, 'import', { text: doi })
    assert.equal(body.results[0].status, 'added', JSON.stringify(body))
    const item = (await call(s, 'state')).body.items[0]
    assert.equal(item.PMID, '31452104')
    assert.equal(item.DOI.toLowerCase(), doi.toLowerCase())
  } finally { s.close(); offline.close() }
})
