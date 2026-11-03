import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { USER_STYLES, styleCatalog, readStyle } from '../style-catalog.js'
import { styleMetadata } from './xml.js'

const revision = (xml) => createHash('sha256').update(xml).digest('hex')
const samples = [
  { id: 'sample-1', type: 'article-journal', title: 'A local library for better writing', author: [{ family: 'Smith', given: 'Anna' }], issued: { 'date-parts': [[2024]] }, 'container-title': 'Example Journal', volume: '12', page: '34-42', DOI: '10.0000/example1' },
  { id: 'sample-2', type: 'article-journal', title: 'Roots and their microbial neighbours', author: [{ family: 'Chen', given: 'Wei' }, { family: 'Jones', given: 'Alex' }], issued: { 'date-parts': [[2023]] }, 'container-title': 'Example Research', volume: '8', page: '101-109' },
]
export function previewStyle(xml, items = []) {
  styleMetadata(xml)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./style-worker.js', import.meta.url), { workerData: { xml, items: items.length ? items.slice(0, 8) : samples },
      resourceLimits: { maxOldGenerationSizeMb: 128 } })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); void worker.terminate()
      error ? reject(error) : resolve({ ...value, sample: !items.length })
    }
    const timer = setTimeout(() => finish(new Error('Style preview exceeded 5 seconds')), 5000)
    worker.once('message', (value) => finish(value.error ? new Error(value.error) : null, value))
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => { if (!settled) finish(new Error(`Style preview stopped (${code})`)) })
  })
}
export function getStyle(id) {
  const item = styleCatalog().find((s) => s.id === id)
  if (!item) throw new Error('Style not found')
  const xml = readStyle(id)
  return { ...item, xml, revision: revision(xml) }
}
let saves = Promise.resolve()
export function saveStyle(input, items) {
  const result = saves.then(() => persistStyle(input, items))
  saves = result.catch(() => {})
  return result
}
async function persistStyle({ xml, expectedRevision = null }, items) {
  const meta = styleMetadata(xml), existing = styleCatalog().find((s) => s.id === meta.id)
  if (existing?.builtin) throw new Error('Built-in styles are read-only. Save a copy with a new style ID')
  if (existing && expectedRevision !== revision(readStyle(meta.id))) throw new Error('This style already exists or changed. Reload it before replacing it')
  if (!existing && expectedRevision) throw new Error('This style no longer exists. Save it as a new style')
  await previewStyle(xml, items)
  // Recheck after worker validation so two concurrent saves cannot overwrite silently.
  const current = styleCatalog().find((s) => s.id === meta.id)
  if (!!current !== !!existing || (current && revision(readStyle(meta.id)) !== expectedRevision)) throw new Error('This style changed while being validated. Reload it')
  await fs.mkdir(USER_STYLES, { recursive: true })
  const file = path.join(USER_STYLES, `${meta.id}.csl`), temp = path.join(USER_STYLES, `.${randomUUID()}.tmp`)
  try { await fs.writeFile(temp, xml, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }) }
  return getStyle(meta.id)
}
