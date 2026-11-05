// The native macOS citation picker: request/response handling, fallback to the browser picker.
// (The Cocoa window itself only runs on macOS; here it is syntax-checked.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { nativeSpec, parseResult, nativePick, nativeAvailable, SCRIPT } from '../src/quickformat.js'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const ITEMS = [
  { id: 'he2023', type: 'article-journal', title: '4-methylumbelliferone (4-MU) enhances drought tolerance of apple', 'container-title': 'Horticulture Research',
    author: [{ family: 'He', given: 'Jieqiang' }, { family: 'Ma', given: 'Fengwang' }, { family: 'Li', given: 'C' }], issued: { 'date-parts': [[2023]] }, DOI: '10.1093/hr/uhad099' },
  { id: 'zhi2025', type: 'article-journal', title: '<i>MdKIN10</i>-mediated phosphorylation of MdMIEL1', 'container-title': 'The Plant Cell',
    author: [{ family: 'Zhi', given: 'Fang' }], issued: { 'date-parts': [[2025]] } },
]
const STYLES = [{ id: 'nature', label: 'Nature' }, { id: 'cell', label: 'Cell' }]

test('the request carries plain labels, newest first, searchable by project name', () => {
  const spec = nativeSpec({ mode: 'cite', style: 'nature', askStyle: true, items: ITEMS, selected: ['he2023'] }, STYLES, [{ name: 'Cold paper', itemIds: ['zhi2025'] }])
  assert.deepEqual(spec.items.map((i) => i.id), ['zhi2025', 'he2023'])
  assert.equal(spec.items[0].title, 'MdKIN10-mediated phosphorylation of MdMIEL1')
  assert.equal(spec.items[0].detail, 'Zhi 2025')
  assert.equal(spec.items[1].short, 'He et al. 2023')
  assert.match(spec.items[0].search, /cold paper/)
  assert.match(spec.items[1].search, /10\.1093\/hr\/uhad099/)
  assert.deepEqual([spec.askStyle, spec.selected, spec.styles], [true, ['he2023'], STYLES])
  const style = nativeSpec({ mode: 'style', style: 'cell', bookmarks: false, bookmarksLocked: true }, STYLES)
  assert.deepEqual(style, { mode: 'style', style: 'cell', askStyle: false, styles: STYLES, bookmarks: false, bookmarksLocked: true })
})

test('answers are checked against the request', () => {
  const cite = { mode: 'cite', items: ITEMS }
  assert.equal(parseResult('', cite, ['nature']), null, 'cancelled')
  assert.deepEqual(parseResult('{"ids":["zhi2025","ghost"],"style":"nature"}\n', cite, ['nature']), { ids: ['zhi2025'], style: 'nature' })
  assert.deepEqual(parseResult('{"ids":["he2023"],"style":"apa"}', cite, ['nature']), { ids: ['he2023'] }, 'unknown style ignored')
  assert.equal(parseResult('{"ids":[]}', cite, ['nature']), null)
  assert.deepEqual(parseResult('{"style":"cell","bookmarks":true}', { mode: 'style' }, ['cell']), { style: 'cell', bookmarks: true })
  assert.throws(() => parseResult('execution error: -1743', cite, []), /unexpected/)
})

test('nativePick hands the script a temporary request file and removes it', async () => {
  const tmp = tempDir()
  let seen
  const result = await nativePick({ mode: 'cite', items: ITEMS }, STYLES, { tmp, run: async (file) => { seen = JSON.parse(fs.readFileSync(file, 'utf8')); return '{"ids":["he2023"]}' } })
  assert.deepEqual(result, { ids: ['he2023'] })
  assert.equal(seen.items.length, 2)
  assert.deepEqual(fs.readdirSync(tmp), [])
  assert.equal(nativeAvailable('darwin', {}), true)
  assert.equal(nativeAvailable('darwin', { ZOTLET_PICKER: 'web' }), false)
  assert.equal(nativeAvailable('linux', {}), false)
})

test('the macOS script is valid JavaScript', () => {
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('server: the native picker is used first; if it fails, the browser picker opens', async () => {
  const dir = tempDir(), opened = [], activated = []
  let native = async () => ({ ids: ['x'] })
  const server = await startServer({ port: 0, dir, store: createStore({ dir }), quiet: true, openUrl: (url) => opened.push(url),
    focus: { front: async () => 'cn.genoffice.app', activate: (app) => activated.push(app) },
    nativePicker: (...args) => native(...args) })
  try {
    assert.deepEqual(await server.pick({ mode: 'cite', items: [] }), { ids: ['x'] })
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual([opened.length, activated], [0, ['cn.genoffice.app']], 'no browser; back to the word processor')

    native = async () => { throw new Error('osascript: not allowed') }
    const pending = server.pick({ mode: 'style', style: 'nature' })
    for (let k = 0; !opened.length && k < 200; k++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(opened.length, 1, 'fell back to the browser picker')
    const id = new URL(opened[0]).searchParams.get('id')
    await fetch(new URL('api/pick/done', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }, body: JSON.stringify({ id, cancel: true }) })
    assert.equal(await pending, null)
  } finally { server.close(); server.closeAllConnections() }
})
