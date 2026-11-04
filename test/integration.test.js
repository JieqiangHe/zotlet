// Word / LibreOffice / GenOffice integration: the document session and both transports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { runSession, lsofClient, itemURI, resolveStyle, SCHEMA } from '../src/integration.js'
import { listStyles } from '../src/citations.js'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const ITEMS = [
  { id: 'lovelace2020', type: 'article-journal', title: 'Second paper', 'container-title': 'Nature',
    author: [{ family: 'Lovelace', given: 'Ada' }], issued: { 'date-parts': [[2020]] }, volume: '577', page: '1-5' },
  { id: 'hopper2019', type: 'article-journal', title: 'A <i>compiler</i> paper', 'container-title': 'Science',
    author: [{ family: 'Hopper', given: 'Grace' }], issued: { 'date-parts': [[2019]] }, volume: '1', page: '2-3' },
]

/** In-memory word processor document answering the plugin RPCs. */
function fakeDocument({ outputFormat = 'rtf', data = '' } = {}) {
  const doc = { data, fields: [], cursor: null, alerts: [], completed: 0, bibliographyStyle: null }
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
      case 'Document.displayAlert': doc.alerts.push(args[1]); return 1
      case 'Document.complete': doc.completed++; return null
      default: throw new Error(`unexpected RPC ${method}`)
    }
  }
  doc.rpc = async (method, args) => doc.handle(method, args)
  return doc
}

const styles = () => listStyles()
const ctx = (pick) => ({ items: async () => ITEMS, styles, pick })
const codeOf = (f) => JSON.parse(f.code.slice(f.code.indexOf('{')))

test('addEditCitation inserts a live citation, bibliography and refresh format it', async () => {
  const doc = fakeDocument()
  const asked = []
  const pick = async (spec) => { asked.push(spec); return { ids: ['lovelace2020', 'hopper2019'], style: 'nature' } }
  const note = await runSession('addEditCitation', doc.rpc, {}, ctx(pick))
  assert.match(note, /lovelace2020, hopper2019/)
  assert.equal(asked[0].mode, 'cite')
  assert.deepEqual(asked[0].items.map((i) => i.id), ['lovelace2020', 'hopper2019'])
  assert.equal(doc.fields.length, 1)
  const [cite] = doc.fields
  assert.match(cite.code, /^ITEM CSL_CITATION \{/)
  const json = codeOf(cite)
  assert.equal(json.schema, SCHEMA)
  assert.deepEqual(json.citationItems.map((c) => c.id), ['lovelace2020', 'hopper2019'])
  assert.deepEqual(json.citationItems[0].uris, [itemURI('lovelace2020')])
  assert.ok(json.properties.plainCitation, 'formatted text stored in the code')
  assert.match(cite.text, /^\{\\rtf /)
  assert.match(doc.data, /styles\/nature/)
  assert.equal(doc.completed, 1)

  await runSession('addEditBibliography', doc.rpc, {}, ctx(pick))
  const bib = doc.fields.find((f) => /^BIBL/.test(f.code))
  assert.ok(bib, 'bibliography field inserted')
  assert.match(bib.text, /Lovelace/)
  assert.match(bib.text, /Hopper/)
  assert.match(bib.text, /\\i\{?\s*compiler|\\i compiler|compiler/)
  assert.equal(asked.length, 1, 'bibliography does not open the picker')
})

test('editing a citation keeps its id and locator; setDocPrefs changes the style', async () => {
  const doc = fakeDocument()
  await runSession('addEditCitation', doc.rpc, {}, ctx(async () => ({ ids: ['lovelace2020'] })))
  const [f] = doc.fields
  const first = codeOf(f)
  first.citationItems[0].locator = '12'
  f.code = `ITEM CSL_CITATION ${JSON.stringify(first)}`
  doc.cursor = f.id
  let spec
  await runSession('addEditCitation', doc.rpc, {}, ctx(async (s) => { spec = s; return { ids: ['lovelace2020', 'hopper2019'] } }))
  assert.deepEqual(spec.selected, ['lovelace2020'])
  assert.equal(doc.fields.length, 1, 'edited in place')
  const edited = codeOf(f)
  assert.equal(edited.citationID, first.citationID)
  assert.equal(edited.citationItems[0].locator, '12')
  assert.equal(edited.citationItems.length, 2)

  const before = f.text
  await runSession('setDocPrefs', doc.rpc, {}, ctx(async (s) => { assert.equal(s.mode, 'style'); return { style: 'apa' } }))
  assert.match(doc.data, /styles\/apa/)
  assert.notEqual(f.text, before, 'refreshed in the new style')
  assert.match(f.text, /Lovelace/)
})

test('cancelling the picker leaves the document untouched; refresh uses library edits', async () => {
  const doc = fakeDocument()
  assert.equal(await runSession('addEditCitation', doc.rpc, {}, ctx(async () => null)), 'cancelled')
  assert.equal(doc.fields.length, 0)
  assert.equal(doc.completed, 1, 'transaction is always completed')

  await runSession('addEditCitation', doc.rpc, {}, ctx(async () => ({ ids: ['hopper2019'], style: 'apa' })))
  const renamed = [{ ...ITEMS[1], author: [{ family: 'Renamed', given: 'G' }] }]
  await runSession('refresh', doc.rpc, {}, { items: async () => renamed, styles, pick: async () => null })
  assert.match(doc.fields[0].text, /Renamed/)
})

test('citations from documents written by Zotero refresh from their embedded data', async () => {
  const doc = fakeDocument({ data: '<data data-version="3"><session id="abc"/><style id="http://www.zotero.org/styles/apa" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/></prefs></data>' })
  doc.fields.push({ id: 'z1', text: 'old', code: `ITEM CSL_CITATION ${JSON.stringify({ citationID: 'x', properties: {}, citationItems: [{ id: 42, uris: ['http://zotero.org/users/1/items/AAAA'], itemData: { id: 42, type: 'book', title: 'From Zotero', author: [{ family: 'Elsewhere', given: 'E' }], issued: { 'date-parts': [[2001]] } } }] })}` })
  const note = await runSession('refresh', doc.rpc, {}, ctx(async () => null))
  assert.match(note, /1 citation · apa/)
  assert.match(doc.fields[0].text, /Elsewhere/)
  assert.equal(doc.alerts.length, 0)
})

test('HTML documents (HTTP protocol) get HTML text and the style in document data', async () => {
  const doc = fakeDocument({ outputFormat: 'html' })
  await runSession('addEditCitation', doc.rpc, { fieldType: 'Http', outputFormat: 'html', modernData: true, finalCommit: true, setBibliographyStyle: true },
    ctx(async () => ({ ids: ['hopper2019'], style: 'nature' })))
  assert.doesNotMatch(doc.fields[0].text, /\\rtf/)
  assert.match(doc.data, /styles\/nature/)
})

test('style URIs resolve to installed styles', () => {
  assert.equal(resolveStyle('http://www.zotero.org/styles/nature', styles()), 'nature')
  assert.equal(resolveStyle('http://www.zotero.org/styles/unknown-style', styles()), null)
})

test('lsofClient finds the unique owner of the peer socket', () => {
  const out = 'p101\ncsoffice\nn127.0.0.1:50000->127.0.0.1:23116\np7\nczotlet\nn127.0.0.1:23116->127.0.0.1:50000\n'
  const socket = { remoteAddress: '127.0.0.1', remotePort: 50000, localAddress: '127.0.0.1', localPort: 23116 }
  assert.deepEqual(lsofClient(out, socket), { pid: 101, command: 'soffice' })
})

// ---------- end to end through the real server ----------

async function startWithIntegration() {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(ITEMS))
  const opened = []
  const server = await startServer({
    port: 0, dir, store: createStore({ dir }), quiet: true,
    integration: { tcpPort: 0, httpPort: 0, detectClient: async () => null },
    openUrl: (url) => opened.push(url),
  })
  return { server, opened }
}

async function answerPicker(server, opened, choose) {
  for (let k = 0; !opened.length; k++) {
    if (k > 500) throw new Error('picker was never opened')
    await new Promise((r) => setTimeout(r, 10))
  }
  const url = new URL(opened.shift())
  assert.equal(url.pathname, '/pick.html')
  const headers = { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }
  const page = await fetch(url)
  assert.ok((await page.text()).includes(server.token), 'picker page carries the token')
  const id = url.searchParams.get('id')
  const spec = await (await fetch(new URL('/api/pick/get', url), { method: 'POST', headers, body: JSON.stringify({ id }) })).json()
  const res = await fetch(new URL('/api/pick/done', url), { method: 'POST', headers, body: JSON.stringify({ id, ...choose(spec) }) })
  assert.equal(res.status, 200)
  return spec
}

test('TCP transport (Word): picker page answers addEditCitation', async () => {
  const { server, opened } = await startWithIntegration()
  try {
    const doc = fakeDocument()
    const sock = net.connect(server.integration.tcp.address().port, '127.0.0.1')
    const frame = (id, value) => {
      const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(8)
      header.writeUInt32BE(id); header.writeUInt32BE(body.length, 4)
      return Buffer.concat([header, body])
    }
    const ended = new Promise((resolve) => sock.on('close', resolve))
    let buffer = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32BE(4)) {
        const id = buffer.readUInt32BE(), length = buffer.readUInt32BE(4)
        const [method, args] = JSON.parse(buffer.subarray(8, 8 + length).toString())
        buffer = buffer.subarray(8 + length)
        sock.write(frame(id, doc.handle(method, args) ?? null))
      }
    })
    sock.write(frame(0, { command: 'addEditCitation' }))
    const spec = await answerPicker(server, opened, (s) => ({ ids: [s.items[0].id], style: 'science' }))
    assert.equal(spec.mode, 'cite')
    assert.deepEqual(spec.items.map((i) => i.id).sort(), ['hopper2019', 'lovelace2020'])
    assert.ok(spec.styles.length >= 13)
    await ended
    assert.equal(doc.fields.length, 1)
    assert.match(doc.fields[0].code, /^ITEM CSL_CITATION/)
    assert.match(doc.data, /styles\/science/)
  } finally { server.close() }
})

test('HTTP citing protocol (GenOffice): execCommand / respond loop', async () => {
  const { server, opened } = await startWithIntegration()
  try {
    const base = `http://127.0.0.1:${server.integration.http.address().port}/connector/`
    const doc = fakeDocument({ outputFormat: 'html' })
    const post = async (route, body) => {
      const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotero-Connector-API-Version': '3' }, body: JSON.stringify(body) })
      assert.equal(res.status, 200)
      return res.json()
    }
    const picked = answerPicker(server, opened, () => ({ ids: ['hopper2019'] }))
    let step = await post('document/execCommand', { command: 'addEditCitation', docId: 'doc-1' })
    while (step.command !== 'Document.complete') {
      let value = doc.handle(step.command, step.arguments)
      // The HTTP protocol uses objects instead of tuples.
      if (step.command === 'Application.getActiveDocument') value = { documentID: 'doc-1', outputFormat: 'html', processorName: 'GenOffice' }
      else if (step.command === 'Document.insertField' || step.command === 'Document.cursorInField') value = value && { id: value[0], code: value[1], noteIndex: 0 }
      else if (step.command === 'Document.getFields') value = value[0].map((id, k) => ({ id, code: value[1][k], noteIndex: 0 }))
      step = await post('document/respond', value)
    }
    await picked
    assert.equal(doc.fields.length, 1)
    assert.match(doc.fields[0].text, /1/)
    assert.match(doc.data, /styles\/nature/)
    // A browser page without the connector header is refused, like Zotero does.
    await assert.rejects(fetch(base + 'document/execCommand', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' }))
  } finally { server.close() }
})

test('the picker API refuses unknown requests', async () => {
  const { server } = await startWithIntegration()
  try {
    const res = await fetch(new URL('api/pick/get', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }, body: '{"id":"nope"}' })
    assert.equal(res.status, 410)
  } finally { server.close() }
})
