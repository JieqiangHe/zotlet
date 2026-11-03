// The public catalogue and selected CSL files are fetched on demand; no bundled mirror.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_HOME, styleCatalog } from '../style-catalog.js'
import { describeStyle, resolveAlias, styleMetadata } from './xml.js'
import { getStyle, saveStyle } from './styles.js'

const INDEX = 'https://www.zotero.org/styles-files/styles.json'
const slug = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,150}$/.test(value)
const styleURL = (name) => `https://www.zotero.org/styles/${name}`
function trusted(url) {
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && ((parsed.hostname === 'www.zotero.org' && (/^\/styles\/[a-z0-9-]+$/.test(parsed.pathname) || parsed.href === INDEX))
      || (parsed.hostname === 'raw.githubusercontent.com' && parsed.pathname.startsWith('/citation-style-language/styles/')))
}
async function download(url, maximum, request) {
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!trusted(url)) throw new Error('The style source is outside the official repository')
    const response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(20000),
      // The official style endpoint returns 406 for a vendor-only Accept header.
      headers: { Accept: url === INDEX ? 'application/json' : '*/*', 'User-Agent': 'zotlet/0.1' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel()
      if (!location) throw new Error('Missing style redirect location')
      url = new URL(location, url).href; continue
    }
    if (!response.ok) throw new Error(`Style repository returned HTTP ${response.status}`)
    let length = 0; const chunks = []
    for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw new Error('The style response is too large'); chunks.push(Buffer.from(chunk)) }
    return Buffer.concat(chunks).toString('utf8')
  }
  throw new Error('Too many style redirects')
}
export function createStyleRepository({ home = DATA_HOME, request = (...args) => fetch(...args) } = {}) {
  const cacheFile = path.join(home, 'styles-index.json')
  let cache = null, pending = null
  const normalize = (entries) => {
    if (!Array.isArray(entries)) throw new Error('Invalid style catalogue')
    return entries.filter((entry) => slug(entry.name) && typeof entry.title === 'string').map((entry) => ({
      name: entry.name, title: entry.title, shortTitle: entry.titleShort || entry.shortTitle || '', dependent: !!entry.dependent,
      format: entry.categories?.format || entry.format || '', fields: entry.categories?.fields || entry.fields || [], updated: entry.updated || '',
    }))
  }
  const index = async (refresh = false) => {
    if (pending) return pending
    if (cache && !refresh) return cache
    pending = (async () => {
      if (!refresh) {
        try { const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')); cache = { entries: normalize(saved.entries), fetchedAt: saved.fetchedAt }; return cache }
        catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not read style catalogue: ${error.message}`) }
      }
      const entries = normalize(JSON.parse(await download(INDEX, 12 * 1024 * 1024, request)))
      const value = { entries, fetchedAt: new Date().toISOString() }
      await fs.mkdir(home, { recursive: true })
      const temporary = path.join(home, `.style-index-${randomUUID()}.tmp`)
      try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, cacheFile) }
      finally { await fs.rm(temporary, { force: true }) }
      cache = value; return value
    })().finally(() => { pending = null })
    return pending
  }
  const resolve = async (name, seen = new Set()) => {
    if (!slug(name) || seen.has(name) || seen.size > 8) throw new Error('Invalid or cyclic parent style')
    seen.add(name)
    const xml = await download(styleURL(name), 1024 * 1024, request), meta = describeStyle(xml)
    if (meta.uri !== `http://www.zotero.org/styles/${name}`) throw new Error('The downloaded style ID does not match its catalogue entry')
    if (!meta.parent) { styleMetadata(xml); return xml }
    const parentName = /^http:\/\/www\.zotero\.org\/styles\/([a-z0-9-]+)$/.exec(meta.parent)?.[1]
    if (!parentName) throw new Error('This alias does not name an official parent style')
    return resolveAlias(xml, await resolve(parentName, seen))
  }
  return {
    async search(query = '', { refresh = false } = {}) {
      const data = await index(refresh), terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean), installed = new Set(styleCatalog().flatMap((style) => [style.id, style.uri]))
      const matches = data.entries.filter((entry) => terms.every((term) => `${entry.name} ${entry.title} ${entry.shortTitle}`.toLowerCase().includes(term)))
      return { results: matches.slice(0, 60).map((entry) => ({ ...entry, installed: installed.has(entry.name) || installed.has(`http://www.zotero.org/styles/${entry.name}`), supported: entry.format !== 'note', source: styleURL(entry.name) })),
        total: matches.length, fetchedAt: data.fetchedAt, source: INDEX }
    },
    async install(name, expectedRevision, items) {
      const entry = (await index()).entries.find((style) => style.name === name)
      if (!entry) throw new Error('Choose a style from the official catalogue')
      if (entry.format === 'note') throw new Error('Note styles require a document workflow that is not implemented')
      const existing = styleCatalog().find((style) => style.id === name)
      if (existing?.builtin) return { style: getStyle(name), alreadyInstalled: true }
      const xml = await resolve(name)
      return { style: await saveStyle({ xml, expectedRevision }, items), alreadyInstalled: false }
    },
  }
}
