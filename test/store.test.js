import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('empty data folder starts cleanly', async () => {
  const store = createStore({ dir: tempDir() })
  const snap = await store.snapshot()
  assert.deepEqual(snap.items, [])
  assert.deepEqual(snap.projects, [])
})

test('existing item ids and unknown fields survive every write', async () => {
  const dir = tempDir()
  const lib = path.join(dir, 'library.json')
  fs.writeFileSync(lib, JSON.stringify([
    { id: 'MyKey_1', type: 'article-journal', title: 'Old', custom: { keep: true }, 'zotero-key': 'ABCD1234' },
    { id: 'other', title: 'Other', DOI: '10.1/X' },
  ]))
  fs.writeFileSync(path.join(dir, 'web-state.json'), JSON.stringify({
    version: 1, roots: ['/papers'], links: { MyKey_1: ['f1'] }, projects: [{ id: 'p1', name: 'Thesis', itemIds: ['MyKey_1'], color: 'red' }], activeProject: 'p1',
  }))
  const store = createStore({ dir })
  await store.updateItem('MyKey_1', { title: 'New title', volume: '3' })
  await store.addItems([{ type: 'book', title: 'Added', author: [{ family: 'Zed' }] }])
  await store.renameProject('p1', 'Thesis 2')

  const items = read(lib)
  assert.deepEqual(items[0], { id: 'MyKey_1', type: 'article-journal', title: 'New title', custom: { keep: true }, 'zotero-key': 'ABCD1234', volume: '3' })
  assert.equal(items[1].id, 'other')
  assert.equal(items[2].id, 'zed')
  const state = read(path.join(dir, 'web-state.json'))
  assert.deepEqual(state.roots, ['/papers'])
  assert.deepEqual(state.links, { MyKey_1: ['f1'] })
  assert.equal(state.projects[0].color, 'red')
  assert.equal(state.projects[0].name, 'Thesis 2')
})

test('update removes null fields and never changes the id', async () => {
  const dir = tempDir()
  const store = createStore({ dir })
  const [{ id }] = await store.addItems([{ title: 'T', volume: '1', author: [{ family: 'A' }] }])
  const next = await store.updateItem(id, { volume: null, id: 'hacked' })
  assert.equal(next.id, id)
  assert.ok(!('volume' in next))
})

test('duplicates by DOI (case-insensitive) or PMID are reported, not re-added', async () => {
  const store = createStore({ dir: tempDir() })
  const first = await store.addItems([{ title: 'A', DOI: '10.1000/ABC' }, { title: 'B', PMID: '123' }])
  const again = await store.addItems([{ title: 'A again', DOI: 'https://doi.org/10.1000/abc' }, { title: 'B again', PMID: '123' }])
  assert.deepEqual(again.map((r) => r.status), ['duplicate', 'duplicate'])
  assert.deepEqual(again.map((r) => r.id), first.map((r) => r.id))
  assert.equal((await store.snapshot()).items.length, 2)
  await assert.rejects(store.updateItem(first[1].id, { DOI: '10.1000/abc' }), /already belongs/)
})

test('projects: create, rename, delete, membership', async () => {
  const store = createStore({ dir: tempDir() })
  const [a, b] = await store.addItems([{ title: 'A', author: [{ family: 'A' }] }, { title: 'B', author: [{ family: 'B' }] }])
  const p = await store.createProject('  Grant   2026 ')
  assert.equal(p.name, 'Grant 2026')
  await assert.rejects(store.createProject('grant 2026'), /already exists/)
  await assert.rejects(store.createProject('   '), /Enter a project name/)
  assert.deepEqual(await store.addToProject(p.id, [a.id, b.id, 'missing', a.id]), { added: 2 })
  assert.deepEqual(await store.removeFromProject(p.id, [b.id]), { removed: 1 })
  const renamed = await store.renameProject(p.id, 'Grant')
  assert.equal(renamed.name, 'Grant')
  let snap = await store.snapshot()
  assert.deepEqual(snap.projects[0].itemIds, [a.id])

  // Deleting a reference also removes it from projects.
  await store.deleteItems([a.id])
  snap = await store.snapshot()
  assert.deepEqual(snap.projects[0].itemIds, [])

  await store.deleteProject(p.id)
  assert.deepEqual((await store.snapshot()).projects, [])
  await assert.rejects(store.deleteProject(p.id), /Project not found/)
  await assert.rejects(store.renameProject('nope', 'x'), /Project not found/)
})

test('concurrent writes are serialized, none are lost', async () => {
  const store = createStore({ dir: tempDir() })
  await Promise.all(Array.from({ length: 20 }, (_, n) => store.addItems([{ title: `T${n}`, author: [{ family: 'Same' }], issued: { 'date-parts': [[2020]] } }])))
  const { items } = await store.snapshot()
  assert.equal(items.length, 20)
  assert.equal(new Set(items.map((i) => i.id)).size, 20)
})

test('changes made by another process between writes are kept', async () => {
  const dir = tempDir()
  const store = createStore({ dir })
  await store.addItems([{ title: 'From web', author: [{ family: 'W' }] }])
  const lib = path.join(dir, 'library.json')
  fs.writeFileSync(lib, JSON.stringify([...read(lib), { id: 'cli1', title: 'From CLI' }]))
  await store.addItems([{ title: 'Web again', author: [{ family: 'V' }] }])
  assert.deepEqual(read(lib).map((i) => i.id), ['w', 'cli1', 'v'])
})

test('a corrupt library is reported instead of being overwritten', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'library.json'), '{ not json')
  const store = createStore({ dir })
  await assert.rejects(store.addItems([{ title: 'x' }]), /not valid JSON/)
  assert.equal(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'), '{ not json')
})

test('import time is recorded in web-state.json, not in library.json, and forgotten on delete', async () => {
  const dir = tempDir()
  let clock = Date.UTC(2026, 10, 5, 8, 0, 0)
  const store = createStore({ dir, now: () => new Date(clock) })
  const [a] = await store.addItems([{ type: 'book', title: 'First' }])
  clock += 60000
  const [b, dup] = await store.addItems([{ type: 'book', title: 'Second', DOI: '10.1/x' }, { type: 'book', title: 'Again', DOI: '10.1/X' }])
  assert.equal(dup.status, 'duplicate')
  const snap = await store.snapshot()
  assert.deepEqual(snap.added, { [a.id]: '2026-11-05T08:00:00.000Z', [b.id]: '2026-11-05T08:01:00.000Z' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')).some((i) => 'added' in i), false)
  await store.deleteItems([a.id])
  assert.deepEqual(Object.keys((await store.snapshot()).added), [b.id])
})
