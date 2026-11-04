import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startServer, validateFields } from '../src/server.js'
import { createStore } from '../src/store.js'
import { fixture, fakeFetch, tempDir } from './helpers.js'

const ELSEVIER = '10.1016/j.plaphy.2026.111729'
let server, dir, base, fetchMock

const second = {
  type: 'journal-article', title: ['Second paper'], DOI: '10.1038/s41586-020-0001-x', 'container-title': ['Nature'],
  author: [{ given: 'Ada', family: 'Lovelace', sequence: 'first', affiliation: [{ name: 'X' }], role: 'author' }],
  issued: { 'date-parts': [[2020, 1, 2]] }, volume: '577', page: '1-5',
}

before(async () => {
  dir = tempDir()
  fetchMock = fakeFetch({
    dois: { [ELSEVIER]: fixture('elsevier-crossref.json'), [second.DOI]: second },
    pmids: { 31452104: fixture('pubmed.json') },
  })
  server = await startServer({ port: 0, dir, store: createStore({ dir }), fetchImpl: fetchMock, quiet: true })
  base = server.url
})
after(() => { server.close(); server.closeAllConnections() })

async function call(route, body, { token = server.token, raw = false } = {}) {
  const res = await fetch(new URL(`api/${route}`, base), body === undefined
    ? { headers: { 'X-Zotlet-Token': token } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': token }, body: JSON.stringify(body) })
  if (raw) return res
  const data = await res.json()
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status })
  return data
}

test('serves the page with a session token and static assets', async () => {
  const html = await (await fetch(base)).text()
  assert.ok(html.includes(server.token))
  for (const asset of ['app.js', 'style.css', 'theme.js']) assert.equal((await fetch(new URL(asset, base))).status, 200, asset)
  assert.equal((await fetch(new URL('../package.json', base))).status, 404)
})

test('API rejects missing tokens and foreign Host headers', async () => {
  await assert.rejects(call('state', undefined, { token: 'nope' }), (e) => e.status === 403)
  // fetch() cannot spoof Host, so use a raw request (DNS-rebinding protection).
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/ping', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject)
  })
  assert.equal(status, 403)
})

test('acceptance: Elsevier DOI imports without author-validation errors', async () => {
  const { results } = await call('import', { text: `https://doi.org/${ELSEVIER}\n${second.DOI}, PMID: 31452104 not-an-id` })
  assert.deepEqual(results.map((r) => r.status), ['added', 'added', 'added', 'error'])
  assert.equal(results[3].message, 'Not a DOI or PMID')
  const { items } = await call('state')
  const zhang = items.find((i) => i.DOI === ELSEVIER)
  assert.equal(zhang.id, 'zhang2026')
  for (const name of zhang.author) for (const key of Object.keys(name)) assert.ok(['family', 'given', 'literal', 'non-dropping-particle'].includes(key), key)

  // Re-importing is detected as a duplicate (case-insensitive DOI).
  const again = await call('import', { text: ELSEVIER.toUpperCase() })
  assert.deepEqual(again.results.map((r) => [r.status, r.id]), [['duplicate', 'zhang2026']])
  assert.equal((await call('state')).items.length, 3)
})

test('acceptance: create, rename and delete a project', async () => {
  const p = await call('projects/create', { name: 'Review paper' })
  await assert.rejects(call('projects/create', { name: 'review PAPER' }), (e) => e.status === 409)
  await call('projects/rename', { id: p.id, name: 'Review paper v2' })
  let { projects } = await call('state')
  assert.deepEqual(projects.map((x) => x.name), ['Review paper v2'])
  await call('projects/delete', { id: p.id })
  projects = (await call('state')).projects
  assert.deepEqual(projects, [])
  await assert.rejects(call('projects/rename', { id: p.id, name: 'x' }), (e) => e.status === 404)
})

test('importing while a project is active adds to that project', async () => {
  const p = await call('projects/create', { name: 'Grant' })
  await call('import', { text: second.DOI, projectId: p.id }) // duplicate, still linked
  const { projects } = await call('state')
  const grant = projects.find((x) => x.id === p.id)
  assert.deepEqual(grant.itemIds, ['lovelace2020'])
  await call('projects/delete', { id: p.id })
})

test('acceptance: bibliography and every export format for library and a single project', async () => {
  const { items } = await call('state')
  const p = await call('projects/create', { name: 'Thesis / ch. 1' })
  await call('projects/add', { id: p.id, itemIds: ['zhang2026'] })
  const project = (await call('state')).projects.find((x) => x.id === p.id)

  const library = await call('cite', { style: 'nature', ids: items.map((i) => i.id) })
  assert.equal(library.bibliography.entries, items.length)
  const one = await call('cite', { style: 'apa', ids: project.itemIds })
  assert.equal(one.bibliography.entries, 1)
  assert.match(one.citation.text, /Zhang/)
  await assert.rejects(call('cite', { style: 'nature', ids: [] }), /No references/)

  for (const [format, ext, check] of [['json', 'json', (t) => JSON.parse(t).length], ['bibtex', 'bib', (t) => t.match(/^@/gm).length], ['ris', 'ris', (t) => t.match(/^TY {2}- /gm).length]]) {
    const all = await call('export', { format, ids: items.map((i) => i.id), name: 'library' }, { raw: true })
    assert.equal(all.status, 200)
    assert.match(all.headers.get('content-disposition'), new RegExp(`filename="library\\.${ext}"`))
    assert.equal(check(await all.text()), items.length)

    const proj = await call('export', { format, ids: project.itemIds, name: project.name }, { raw: true })
    assert.match(proj.headers.get('content-disposition'), new RegExp(`filename="Thesis ch\\. 1\\.${ext}"`))
    assert.equal(check(await proj.text()), 1)
  }
  const bad = await call('export', { format: 'docx', ids: ['zhang2026'] }, { raw: true })
  assert.equal(bad.status, 400)
})

test('manual create and edit keep ids and unknown fields', async () => {
  const created = await call('items/create', { fields: { title: 'Hand-made', author: [{ family: 'Knuth', given: 'Donald', junk: 1 }], issued: { 'date-parts': [[1984]] }, type: 'book' } })
  assert.equal(created.id, 'knuth1984')
  assert.deepEqual(created.item.author, [{ family: 'Knuth', given: 'Donald' }])

  // Add an unknown field behind the server's back, then edit through the API.
  const lib = path.join(dir, 'library.json')
  const items = JSON.parse(fs.readFileSync(lib, 'utf8'))
  items.find((i) => i.id === 'knuth1984').note_from_zotero = 'keep me'
  fs.writeFileSync(lib, JSON.stringify(items))

  const { item } = await call('items/update', { id: 'knuth1984', fields: { title: 'The TeXbook', publisher: 'Addison-Wesley', volume: null } })
  assert.equal(item.id, 'knuth1984')
  assert.equal(item.title, 'The TeXbook')
  assert.equal(item.note_from_zotero, 'keep me')
  await assert.rejects(call('items/update', { id: 'knuth1984', fields: { title: '' } }), /title is required/)
  await assert.rejects(call('items/update', { id: 'knuth1984', fields: { bogus: 'x' } }), /Unsupported field/)
  await assert.rejects(call('items/create', { fields: { title: 'Dup', DOI: ELSEVIER } }), (e) => e.status === 409)

  const { removed } = await call('items/delete', { ids: ['knuth1984'] })
  assert.equal(removed, 1)
})

test('validateFields normalizes like imports and marks cleared fields', () => {
  assert.deepEqual(validateFields({ title: ' A  title ', volume: '', DOI: 'https://doi.org/10.1234/x.' }), { title: 'A title', volume: null, DOI: '10.1234/x' })
  assert.throws(() => validateFields({ volume: '1' }, { creating: true }), /title is required/)
})
