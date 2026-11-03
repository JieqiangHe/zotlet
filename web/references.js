// Web writes preserve item IDs and unknown existing fields. CLI import behavior is unchanged.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { LIB } from '../session.js'
import { KEEP, fetchItem, mkkey } from '../metadata.js'

const revision = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const conflict = (message) => Object.assign(new Error(message), { status: 409 })
const plain = (value) => value && !Array.isArray(value) && typeof value === 'object'
function validate(patch, creating = false) {
  if (!plain(patch)) throw new Error('Expected reference fields')
  for (const [key, value] of Object.entries(patch)) {
    if (!KEEP.has(key)) throw new Error(key === 'id' ? 'The citation key is kept stable and cannot be edited' : `Unsupported field: ${key}`)
    if (value === null) continue
    if (key === 'author' || key === 'editor') {
      if (!Array.isArray(value)) throw new Error('Authors must be a list')
      for (const name of value) {
        if (!plain(name)) throw new Error('Author entry must be an object')
        if (!(name.family || name.literal)) throw new Error('Author needs a family or literal name')
        // Drop any non-string extra fields so validation passes
        for (const k of Object.keys(name)) {
          if (!['family','given','literal'].includes(k) || typeof name[k] !== 'string') delete name[k]
        }
      }
    } else if (key === 'issued') {
      if (!plain(value) || (!value.literal && (!Array.isArray(value['date-parts']?.[0]) || !Number.isInteger(value['date-parts'][0][0])))) throw new Error('Enter a valid publication date')
    } else if (key === 'ISSN') {
      if (typeof value !== 'string' && (!Array.isArray(value) || value.some((part) => typeof part !== 'string'))) throw new Error('ISSN must be text or a list of text values')
    } else if (typeof value !== 'string') throw new Error(`${key} must be text`)
  }
  if ((creating || Object.hasOwn(patch, 'title')) && (typeof patch.title !== 'string' || !patch.title.trim())) throw new Error('A title is required')
}
export function createReferences({ library = LIB, lookup = fetchItem } = {}) {
  let writes = Promise.resolve()
  const read = async () => {
    let bytes
    try { bytes = await fs.readFile(library) } catch (error) { if (error.code !== 'ENOENT') throw error; bytes = Buffer.from('[]') }
    const items = JSON.parse(bytes)
    if (!Array.isArray(items) || items.some((item) => !plain(item) || typeof item.id !== 'string')) throw new Error('The library must contain CSL-JSON items with string IDs')
    return { items, bytes }
  }
  const mutate = (change) => {
    const result = writes.then(async () => {
      const current = await read(), items = structuredClone(current.items), value = change(items)
      if (JSON.stringify(items) === JSON.stringify(current.items)) return value
      let target = library
      try { target = await fs.realpath(library) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        try { if ((await fs.lstat(library)).isSymbolicLink()) throw new Error('The library symlink target is missing') } catch (failure) { if (failure.code !== 'ENOENT') throw failure }
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temp = path.join(path.dirname(target), `.zotlet-library-${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temp, JSON.stringify(items, null, 2), { flag: 'wx', mode: 0o600 })
        if (revision((await read()).bytes) !== revision(current.bytes)) throw conflict('The library changed while saving. Reload and try again')
        await fs.rename(temp, target)
      } finally { await fs.rm(temp, { force: true }) }
      return value
    })
    writes = result.catch(() => {})
    return result
  }
  const uniqueDOI = (items, item, except) => {
    const duplicate = item.DOI && items.find((entry) => entry.id !== except && (entry.DOI || '').toLowerCase() === item.DOI.toLowerCase())
    if (duplicate) throw conflict(`This DOI is already in the library as ${duplicate.id}`)
  }
  return {
    async get(id) {
      const item = (await read()).items.find((entry) => entry.id === id)
      if (!item) throw new Error('Reference not found')
      return { item, revision: revision(item) }
    },
    async importIdentifiers(input) {
      if (typeof input !== 'string') throw new Error('Enter a DOI or PMID, one per line')
      const identifiers = input.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      if (!identifiers.length || identifiers.length > 50) throw new Error('Enter between 1 and 50 identifiers, one per line')
      const results = []
      for (const identifier of identifiers) {
        try {
          const ident = identifier.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?(?:\?.*)?$/i, 'PMID:$1')
          const item = await lookup(ident)
          validate(item, true)
          const value = await mutate((items) => {
            const duplicate = item.DOI && items.find((entry) => (entry.DOI || '').toLowerCase() === item.DOI.toLowerCase())
            if (duplicate) return { status: 'duplicate', item: duplicate }
            const added = { ...item, id: mkkey(item, items) }
            items.push(added); return { status: 'added', item: added }
          })
          results.push({ identifier, ...value })
        } catch (error) { results.push({ identifier, status: 'error', message: error.message }) }
      }
      return { results }
    },
    async create(fields) {
      validate(fields, true)
      return mutate((items) => { uniqueDOI(items, fields); const item = { ...fields, id: mkkey(fields, items) }; items.push(item); return { item, revision: revision(item) } })
    },
    async update(id, patch, expectedRevision) {
      validate(patch)
      return mutate((items) => {
        const at = items.findIndex((entry) => entry.id === id)
        if (at < 0) throw new Error('Reference not found')
        if (revision(items[at]) !== expectedRevision) throw conflict('This reference changed. Reload it before saving')
        const item = { ...items[at] }
        for (const [key, value] of Object.entries(patch)) value === null ? delete item[key] : item[key] = value
        uniqueDOI(items, item, id); items[at] = item
        return { item, revision: revision(item) }
      })
    },
  }
}
