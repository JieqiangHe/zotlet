// Citation style repository, like Zotero's "Get additional styles…".
//
// The index is Zotero's list of the ~10,000 styles in the official CSL repository. Styles are
// downloaded from zotero.org (falling back to the CSL repository on GitHub) into ~/.zotlet/styles.
// A dependent (journal) style needs its parent style, which is installed along with it.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { listStyles, styleInfo, styleIdFromURI, SAFE_STYLE_ID, makeEngine } from './citations.js'

export const INDEX_URL = 'https://www.zotero.org/styles-files/styles.json'
const STYLE_URLS = (name) => [
  `https://www.zotero.org/styles/${name}`,
  `https://raw.githubusercontent.com/citation-style-language/styles/master/${name}.csl`,
  `https://raw.githubusercontent.com/citation-style-language/styles/master/dependent/${name}.csl`,
]
const INDEX_MAX_AGE = 24 * 60 * 60 * 1000
const MAX_STYLE_BYTES = 1_000_000

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

/** Reduce one entry of Zotero's styles.json to what the UI needs. */
function indexEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name : styleIdFromURI(raw.href)
  if (!SAFE_STYLE_ID.test(name || '') || typeof raw.title !== 'string') return null
  const categories = raw.categories && typeof raw.categories === 'object' ? raw.categories : {}
  return {
    name, title: raw.title.trim(),
    titleShort: typeof raw.titleShort === 'string' ? raw.titleShort : '',
    dependent: !!Number(raw.dependent),
    format: typeof categories.format === 'string' ? categories.format : '',
    fields: Array.isArray(categories.fields) ? categories.fields.filter((f) => typeof f === 'string') : [],
    updated: typeof raw.updated === 'string' ? raw.updated.slice(0, 10) : '',
  }
}

/** Check that `xml` is a usable CSL style. Returns its info. */
export function validateStyle(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw fail('The file is empty')
  if (Buffer.byteLength(xml) > MAX_STYLE_BYTES) throw fail('The style file is too large')
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('Style files with a DOCTYPE are not supported')
  const info = styleInfo(xml)
  if (!info) throw fail('This is not a CSL style (.csl) file')
  if (!info.parent) {
    if (!/<citation\b/.test(xml)) throw fail('This style has no <citation> section')
    try { makeEngine(xml, [], 'html') } catch (error) { throw fail(`citeproc cannot read this style: ${error.message}`) }
  }
  return info
}

export function createStyleRepository({ userDir, cacheFile = path.join(path.dirname(userDir), 'style-index.json'),
  fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cached = null // { at, entries }

  async function writeAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
    try { await fs.writeFile(temp, text); await fs.rename(temp, file) } finally { await fs.rm(temp, { force: true }) }
  }

  async function get(url) {
    let res
    try { res = await fetchImpl(url, { headers: { Accept: 'application/json, application/vnd.citationstyles.style+xml, text/xml, */*' }, signal: AbortSignal.timeout(20000) }) }
    catch (error) { throw fail(`Cannot reach ${new URL(url).hostname} (${error.cause?.code || error.message})`, 502) }
    return res
  }

  /** The style list, from memory, the network, or (offline) the last saved copy. */
  async function index({ refresh = false } = {}) {
    if (!refresh && cached && now() - cached.at < INDEX_MAX_AGE) return cached.entries
    let disk = null
    try { disk = JSON.parse(await fs.readFile(cacheFile, 'utf8')) } catch { /* no cache yet */ }
    if (!refresh && disk?.at && now() - disk.at < INDEX_MAX_AGE && Array.isArray(disk.entries)) {
      cached = disk
      return cached.entries
    }
    try {
      const res = await get(INDEX_URL)
      if (!res.ok) throw fail(`The style list could not be downloaded (HTTP ${res.status})`, 502)
      const raw = await res.json()
      if (!Array.isArray(raw)) throw fail('The style list has an unexpected format', 502)
      const entries = raw.map(indexEntry).filter(Boolean)
      cached = { at: now(), entries }
      await writeAtomic(cacheFile, JSON.stringify(cached)).catch(() => {})
      return entries
    } catch (error) {
      if (Array.isArray(disk?.entries)) { cached = { at: now(), entries: disk.entries }; return disk.entries }
      throw error
    }
  }

  async function search(query = '', { limit = 80, refresh = false } = {}) {
    const entries = await index({ refresh })
    const installed = new Map(listStyles(userDir).map((s) => [s.id, s]))
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
    const q = words.join(' ')
    const hits = []
    for (const e of entries) {
      const hay = `${e.title} ${e.titleShort} ${e.name} ${e.fields.join(' ')} ${e.format}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) continue
      const t = e.title.toLowerCase()
      // Exact and prefix title matches first, then independent styles before journal styles.
      const score = !q ? (e.dependent ? 1 : 0) : t === q || e.name === q || e.titleShort.toLowerCase() === q ? 0 : t.startsWith(q) ? 1 : e.dependent ? 3 : 2
      hits.push([score, e])
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title))
    return {
      total: hits.length,
      results: hits.slice(0, limit).map(([, e]) => ({ ...e, installed: installed.has(e.name), builtin: !!installed.get(e.name)?.builtin })),
    }
  }

  async function download(name) {
    if (!SAFE_STYLE_ID.test(name || '')) throw fail('Invalid style name')
    let lastError = null
    for (const url of STYLE_URLS(name)) {
      try {
        const res = await get(url)
        if (!res.ok) { lastError = fail(`Style "${name}" was not found (HTTP ${res.status})`, res.status === 404 ? 404 : 502); continue }
        const xml = await res.text()
        if (!styleInfo(xml)) { lastError = fail(`The download for "${name}" is not a CSL style`, 502); continue }
        return xml
      } catch (error) { lastError = error }
    }
    throw lastError || fail(`Style "${name}" could not be downloaded`, 502)
  }

  async function save(id, xml) {
    await writeAtomic(path.join(userDir, `${id}.csl`), xml)
  }

  /** Download and install a style (and its parent, for a journal style). */
  async function install(name) {
    const xml = await download(name)
    const info = validateStyle(xml)
    let parentId = null
    if (info.parent) {
      parentId = styleIdFromURI(info.parent)
      if (!listStyles(userDir).some((s) => s.id === parentId && !s.parent)) {
        if (!SAFE_STYLE_ID.test(parentId)) throw fail('The parent of this style has an invalid name', 502)
        const parentXml = await download(parentId)
        const parentInfo = validateStyle(parentXml)
        if (parentInfo.parent) throw fail('The parent of this style is itself a dependent style', 502)
        await save(parentId, parentXml)
      }
    }
    await save(name, xml)
    const style = listStyles(userDir).find((s) => s.id === name)
    if (!style) throw fail(`"${name}" was saved but could not be loaded`, 500)
    return { id: style.id, title: style.title, parent: style.parent || null }
  }

  /** Install a .csl file the user picked. Its id comes from the style's <id>, else its title. */
  async function addFile(xml) {
    const info = validateStyle(xml)
    const fromUri = styleIdFromURI(info.uri)
    const id = SAFE_STYLE_ID.test(fromUri) ? fromUri
      : String(info.title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
    if (!SAFE_STYLE_ID.test(id)) throw fail('Cannot derive a file name for this style; give it an <id> or <title>')
    const existing = listStyles(userDir).find((s) => s.id === id)
    if (existing?.builtin) throw fail(`"${existing.title}" is a built-in style and cannot be replaced`, 409)
    if (info.parent) {
      const parentId = styleIdFromURI(info.parent)
      if (!listStyles(userDir).some((s) => (s.id === parentId || s.uri === info.parent) && !s.parent)) {
        throw fail(`This journal style needs its parent style "${parentId}". Install that first (search for it above).`)
      }
    }
    await save(id, xml)
    const style = listStyles(userDir).find((s) => s.id === id)
    if (!style) throw fail('The style was saved but could not be loaded', 500)
    return { id: style.id, title: style.title, parent: style.parent || null }
  }

  /** Remove a style installed by the user. A parent still used by a journal style is kept. */
  async function remove(id) {
    const styles = listStyles(userDir)
    const style = styles.find((s) => s.id === id)
    if (!style) throw fail('That style is not installed', 404)
    if (style.builtin) throw fail('Built-in styles cannot be removed')
    const users = styles.filter((s) => s.parent === id)
    if (users.length) throw fail(`Used by ${users.map((s) => `"${s.title}"`).join(', ')}. Remove ${users.length === 1 ? 'that style' : 'those styles'} first.`, 409)
    await fs.rm(style.path, { force: true })
    return { id }
  }

  return { index, search, install, addFile, remove }
}
