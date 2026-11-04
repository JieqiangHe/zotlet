// File-based persistence for the library (CSL-JSON array) and projects.
//
// * library.json  — an array of CSL-JSON items. Item IDs are never changed and
//                   fields zotlet does not know about are written back untouched.
// * web-state.json — { version, projects: [{ id, name, itemIds, created }], … }.
//                   Unknown top-level keys and unknown project keys are preserved.
//
// Every mutation re-reads the files, applies the change and writes atomically
// (temp file + rename), serialized through one queue, so edits made by the CLI
// in between are never lost.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { citationKey, normalizeDOI } from './metadata.js'

export function dataDir(env = process.env) {
  return path.join(env.ZOTLET_HOME || os.homedir(), '.zotlet')
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const userError = (message, status = 400) => Object.assign(new Error(message), { status })

async function readJSON(file, fallback) {
  let text
  try { text = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
  if (!text.trim()) return fallback
  try { return JSON.parse(text) } catch { throw new Error(`${file} is not valid JSON. Fix or move it, then reload.`) }
}

async function writeJSON(file, value) {
  let target = file
  try { target = await fs.realpath(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(temp, target)
  } finally { await fs.rm(temp, { force: true }) }
}

const sameDOI = (a, b) => !!a && !!b && normalizeDOI(a).toLowerCase() === normalizeDOI(b).toLowerCase()

export function findDuplicate(items, item) {
  return items.find((entry) => (item.DOI && sameDOI(entry.DOI, item.DOI))
    || (item.PMID && entry.PMID && String(entry.PMID) === String(item.PMID)))
}

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw userError('Enter a project name')
  const value = name.replace(/\s+/g, ' ').trim()
  if (value.length > 120) throw userError('Project names are limited to 120 characters')
  return value
}

export function createStore({ dir = dataDir(), libraryFile = process.env.ZOTLET_LIB || path.join(dir, 'library.json'), now = () => new Date() } = {}) {
  const stateFile = path.join(dir, 'web-state.json')
  let queue = Promise.resolve()

  async function load() {
    const items = await readJSON(libraryFile, [])
    if (!Array.isArray(items)) throw new Error(`${libraryFile} must contain a JSON array of CSL items`)
    const state = await readJSON(stateFile, {})
    if (!plain(state)) throw new Error(`${stateFile} must contain a JSON object`)
    state.version ??= 1
    state.projects = Array.isArray(state.projects) ? state.projects.filter((p) => plain(p) && typeof p.id === 'string') : []
    for (const p of state.projects) {
      p.name = typeof p.name === 'string' && p.name.trim() ? p.name : 'Untitled'
      p.itemIds = Array.isArray(p.itemIds) ? [...new Set(p.itemIds.filter((id) => typeof id === 'string'))] : []
    }
    return { items, state }
  }

  // Runs `change` against freshly loaded data and writes back only what changed.
  function mutate(change) {
    const task = queue.then(async () => {
      const data = await load()
      const beforeItems = JSON.stringify(data.items), beforeState = JSON.stringify(data.state)
      const result = await change(data)
      if (JSON.stringify(data.items) !== beforeItems) await writeJSON(libraryFile, data.items)
      if (JSON.stringify(data.state) !== beforeState) await writeJSON(stateFile, data.state)
      return result
    })
    queue = task.catch(() => {})
    return task
  }

  const usedIds = (items) => new Set(items.map((i) => i?.id).filter((id) => id !== undefined && id !== null).map(String))

  function project(state, id) {
    const p = state.projects.find((x) => x.id === id)
    if (!p) throw userError('Project not found', 404)
    return p
  }

  function snapshotOf({ items, state }) {
    // Items without a usable id cannot be addressed; give them a view-only key.
    const ids = usedIds(items)
    const visible = items.filter(plain).map((item) => (typeof item.id === 'string' && item.id ? item : { ...item, id: String(item.id ?? citationKey(item, ids)) }))
    const known = new Set(visible.map((i) => i.id))
    return {
      items: visible,
      projects: state.projects.map((p) => ({ id: p.id, name: p.name, created: p.created || null, itemIds: p.itemIds.filter((id) => known.has(id)) })),
      paths: { library: libraryFile, state: stateFile },
    }
  }

  return {
    libraryFile, stateFile,
    async snapshot() { await queue; return snapshotOf(await load()) },
    async items() { await queue; return (await load()).items },

    /** Add normalized items; duplicates (same DOI or PMID) are reported, not added. */
    addItems(newItems, { projectId } = {}) {
      return mutate(({ items, state }) => {
        const target = projectId ? project(state, projectId) : null
        const ids = usedIds(items)
        return newItems.map((incoming) => {
          const duplicate = findDuplicate(items, incoming)
          let item = duplicate
          if (!item) {
            const { id: _ignored, ...fields } = incoming
            item = { id: citationKey(fields, ids), ...fields }
            ids.add(item.id)
            items.push(item)
          }
          const id = String(item.id)
          if (target && !target.itemIds.includes(id)) target.itemIds.push(id)
          return { status: duplicate ? 'duplicate' : 'added', id, item }
        })
      })
    },

    /** Merge `fields` into an item. `null` removes a field; unknown fields are kept. */
    updateItem(id, fields) {
      return mutate(({ items }) => {
        const index = items.findIndex((i) => plain(i) && i.id === id)
        if (index < 0) throw userError('Reference not found', 404)
        const next = { ...items[index] }
        for (const [key, value] of Object.entries(fields)) {
          if (key === 'id') continue
          if (value === null || value === undefined) delete next[key]
          else next[key] = value
        }
        const duplicate = findDuplicate(items.filter((_, i) => i !== index), next)
        if (duplicate) throw userError(`That DOI/PMID already belongs to "${duplicate.id}"`, 409)
        items[index] = next
        return next
      })
    },

    deleteItems(ids) {
      const remove = new Set(ids)
      return mutate(({ items, state }) => {
        const before = items.length
        for (let i = items.length - 1; i >= 0; i--) if (plain(items[i]) && remove.has(items[i].id)) items.splice(i, 1)
        for (const p of state.projects) p.itemIds = p.itemIds.filter((id) => !remove.has(id))
        return { removed: before - items.length }
      })
    },

    createProject(name) {
      return mutate(({ state }) => {
        const value = cleanName(name)
        if (state.projects.some((p) => p.name.toLowerCase() === value.toLowerCase())) throw userError(`A project named "${value}" already exists`, 409)
        const p = { id: randomUUID(), name: value, itemIds: [], created: now().toISOString() }
        state.projects.push(p)
        return p
      })
    },

    renameProject(id, name) {
      return mutate(({ state }) => {
        const p = project(state, id), value = cleanName(name)
        if (state.projects.some((x) => x !== p && x.name.toLowerCase() === value.toLowerCase())) throw userError(`A project named "${value}" already exists`, 409)
        p.name = value
        return p
      })
    },

    deleteProject(id) {
      return mutate(({ state }) => {
        project(state, id)
        state.projects = state.projects.filter((p) => p.id !== id)
        if (state.activeProject === id) state.activeProject = null
        return { ok: true }
      })
    },

    addToProject(id, itemIds) {
      return mutate(({ items, state }) => {
        const p = project(state, id), known = usedIds(items)
        let added = 0
        for (const itemId of itemIds) if (known.has(itemId) && !p.itemIds.includes(itemId)) { p.itemIds.push(itemId); added++ }
        return { added }
      })
    },

    removeFromProject(id, itemIds) {
      return mutate(({ state }) => {
        const p = project(state, id), remove = new Set(itemIds), before = p.itemIds.length
        p.itemIds = p.itemIds.filter((x) => !remove.has(x))
        return { removed: before - p.itemIds.length }
      })
    },
  }
}
