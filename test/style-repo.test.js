// Style repository: search the Zotero style index, install (with parent), add a file, remove.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createStyleRepository, validateStyle, INDEX_URL } from '../src/style-repo.js'
import { listStyles, formatCitations, BUILTIN_STYLES } from '../src/citations.js'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const DEPENDENT = fs.readFileSync(new URL('./fixtures/dependent-style.csl', import.meta.url), 'utf8')
const NATURE = fs.readFileSync(path.join(BUILTIN_STYLES, 'nature.csl'), 'utf8')
const ELSEVIER_HARVARD = fs.readFileSync(new URL('./fixtures/styles/elsevier-harvard.csl', import.meta.url), 'utf8')
// An independent style that is not bundled, and a journal style that depends on it.
const PARENT = NATURE.replace(/<title>[^<]*<\/title>/, '<title>Test Parent Style</title>')
  .replace(/<id>[^<]*<\/id>/, '<id>http://www.zotero.org/styles/test-parent</id>')
const CHILD = DEPENDENT.replace('Plant Physiology and Biochemistry', 'Journal of Tests')
  .replace(/plant-physiology-and-biochemistry/g, 'journal-of-tests').replace('styles/elsevier-harvard', 'styles/test-parent')

const INDEX = [
  { title: 'Plant Physiology and Biochemistry', name: 'plant-physiology-and-biochemistry', dependent: 1, categories: { format: 'author-date', fields: ['botany'] }, updated: '2018-02-16T12:00:00+00:00', href: 'https://www.zotero.org/styles/plant-physiology-and-biochemistry' },
  { title: 'Plant Physiology', name: 'plant-physiology', dependent: 0, categories: { format: 'author-date', fields: ['botany'] }, updated: '2020-01-01T00:00:00+00:00' },
  { title: 'Journal of Tests', name: 'journal-of-tests', dependent: 1, categories: { format: 'numeric', fields: ['science'] } },
  { title: 'Nature', name: 'nature', dependent: 0, categories: { format: 'numeric', fields: ['science'] } },
  { title: 'broken', name: '../evil' },
]

function fakeNet({ offline = false } = {}) {
  const files = { 'elsevier-harvard': ELSEVIER_HARVARD, 'plant-physiology-and-biochemistry': DEPENDENT, 'journal-of-tests': CHILD, 'test-parent': PARENT, 'plant-physiology': NATURE.replace(/styles\/nature</, 'styles/plant-physiology<') }
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    if (offline) throw new TypeError('fetch failed')
    if (url === INDEX_URL) return Response.json(INDEX)
    const name = String(url).replace(/\.csl$/, '').split('/').pop()
    if (String(url).startsWith('https://www.zotero.org/styles/') && files[name]) return new Response(files[name])
    return new Response('not found', { status: 404 })
  }
  fn.calls = calls
  return fn
}

function setup(options) {
  const dir = tempDir(), userDir = path.join(dir, 'styles')
  const fetchImpl = fakeNet(options)
  return { dir, userDir, fetchImpl, repo: createStyleRepository({ userDir, fetchImpl }) }
}

test('search ranks title matches first and marks installed styles', async () => {
  const { repo, fetchImpl } = setup()
  const { total, results } = await repo.search('plant physiology')
  assert.equal(total, 2)
  assert.deepEqual(results.map((r) => r.name), ['plant-physiology', 'plant-physiology-and-biochemistry'])
  assert.equal(results[1].dependent, true)
  assert.equal(results[1].format, 'author-date')
  assert.equal(results[1].updated, '2018-02-16')
  const nature = (await repo.search('nature')).results[0]
  assert.deepEqual([nature.installed, nature.builtin], [true, true])
  assert.equal((await repo.search('')).results.some((r) => r.name === '../evil'), false, 'unsafe names are dropped')
  assert.equal(fetchImpl.calls.filter((u) => u === INDEX_URL).length, 1, 'index is cached')
})

test('the index falls back to the saved copy when offline', async () => {
  const { userDir } = setup()
  await createStyleRepository({ userDir, fetchImpl: fakeNet() }).search('x')
  const offline = createStyleRepository({ userDir, fetchImpl: fakeNet({ offline: true }), now: () => Date.now() + 3 * 86400000 })
  assert.equal((await offline.search('plant')).total, 2)
  const empty = setup({ offline: true })
  await assert.rejects(empty.repo.search('x'), /Cannot reach www\.zotero\.org/)
})

test('installing an Elsevier journal style downloads its parent (Elsevier Harvard is not built in)', async () => {
  const { repo, userDir } = setup()
  const installed = await repo.install('plant-physiology-and-biochemistry')
  assert.deepEqual(installed, { id: 'plant-physiology-and-biochemistry', title: 'Plant Physiology and Biochemistry', parent: 'elsevier-harvard' })
  const style = listStyles(userDir).find((s) => s.id === installed.id)
  assert.equal(style.file, path.join(userDir, 'elsevier-harvard.csl'), 'renders with the downloaded parent')
  const out = formatCitations({ styleId: installed.id, userDir, items: [{ id: 'a', type: 'article-journal', title: 'T', author: [{ family: 'Zhang', given: 'L' }], issued: { 'date-parts': [[2026]] }, 'container-title': 'J' }] })
  assert.match(out.citation.text, /Zhang/)
  assert.match(out.citation.text, /2026/)
})

test('installing a journal style also installs a missing parent; remove respects dependents', async () => {
  const { repo, userDir } = setup()
  const installed = await repo.install('journal-of-tests')
  assert.equal(installed.parent, 'test-parent')
  assert.ok(fs.existsSync(path.join(userDir, 'test-parent.csl')))
  await assert.rejects(repo.remove('test-parent'), /Used by "Journal of Tests"/)
  await assert.rejects(repo.remove('nature'), /Built-in styles cannot be removed/)
  await repo.remove('journal-of-tests')
  await repo.remove('test-parent')
  assert.deepEqual(fs.readdirSync(userDir), [])
  await assert.rejects(repo.install('no-such-style'), /not found/)
  await assert.rejects(repo.install('../x'), /Invalid style name/)
})

test('adding a .csl file validates it', async () => {
  const { repo, userDir } = setup()
  await assert.rejects(repo.addFile('<html></html>'), /not a CSL style/)
  await assert.rejects(repo.addFile(NATURE), /built-in style/)
  await assert.rejects(repo.addFile(CHILD), /needs its parent style "test-parent"/)
  const added = await repo.addFile(PARENT)
  assert.equal(added.id, 'test-parent')
  assert.ok(listStyles(userDir).some((s) => s.id === 'test-parent' && !s.builtin))
  assert.equal((await repo.addFile(CHILD)).parent, 'test-parent')
  assert.throws(() => validateStyle(NATURE.replace(/<citation\b[\s\S]*<\/citation>/, '')), /no <citation>/)
})

test('API: search, install, add and remove styles', async () => {
  const dir = tempDir()
  const server = await startServer({ port: 0, dir, store: createStore({ dir }), fetchImpl: fakeNet(), quiet: true })
  const call = async (route, body) => {
    const res = await fetch(new URL(`api/${route}`, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status })
    return data
  }
  try {
    assert.equal((await call('styles/search', { query: 'tests' })).results[0].name, 'journal-of-tests')
    const res = await call('styles/install', { name: 'journal-of-tests' })
    assert.ok(res.styles.some((s) => s.id === 'journal-of-tests' && s.parent === 'test-parent'))
    assert.match((await call('cite', { style: 'journal-of-tests', ids: [] }).catch((e) => e)).message, /No references/)
    await assert.rejects(call('styles/remove', { id: 'test-parent' }), (e) => e.status === 409)
    assert.equal((await call('styles/remove', { id: 'journal-of-tests' })).styles.some((s) => s.id === 'journal-of-tests'), false)
    await assert.rejects(call('styles/add', { xml: 'nope' }), (e) => e.status === 400)
  } finally { server.close(); server.closeAllConnections() }
})
