// Citation formatting with citeproc-js.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const CSL = createRequire(import.meta.url)('citeproc')
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const BUILTIN_STYLES = path.join(ROOT, 'styles')
const LOCALE = fs.readFileSync(path.join(ROOT, 'locales', 'locales-en-US.xml'), 'utf8')

// Order of the style menu; anything else follows alphabetically.
const PREFERRED = ['nature', 'science', 'cell', 'pnas', 'the-lancet', 'plos', 'apa', 'chicago-author-date',
  'harvard-cite-them-right', 'elsevier-harvard', 'american-medical-association', 'nlm-citation-sequence', 'ieee']
// Short names for the style menu (full titles are long, e.g. "APA Style 7th edition").
const LABELS = {
  nature: 'Nature', science: 'Science', cell: 'Cell', pnas: 'PNAS', 'the-lancet': 'The Lancet', plos: 'PLOS',
  apa: 'APA 7th', 'chicago-author-date': 'Chicago (author-date)', 'harvard-cite-them-right': 'Harvard',
  'elsevier-harvard': 'Elsevier Harvard', 'american-medical-association': 'AMA', 'nlm-citation-sequence': 'Vancouver', ieee: 'IEEE',
}
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/i

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")

function readTitle(xml) {
  const m = /<info>[\s\S]*?<title>([^<]+)<\/title>/.exec(xml)
  return m ? decode(m[1].trim()) : null
}

/** Parse the <info> block of a CSL style. `parent` is set for dependent styles. */
export function styleInfo(xml) {
  if (typeof xml !== 'string' || !/<style\b[^>]*xmlns="http:\/\/purl\.org\/net\/xbiblio\/csl"/.test(xml)) return null
  const info = /<info>([\s\S]*?)<\/info>/.exec(xml)?.[1] || ''
  const uri = /<id>([^<]+)<\/id>/.exec(info)?.[1].trim()
  let parent = null
  for (const link of info.match(/<link\b[^>]*>/g) || []) {
    if (/\brel="independent-parent"/.test(link)) parent = decode(/\bhref="([^"]+)"/.exec(link)?.[1] || '') || null
  }
  return { title: readTitle(xml), uri: uri ? decode(uri) : null, parent,
    format: /<category\b[^>]*citation-format="([^"]+)"/.exec(info)?.[1] || null }
}

export const SAFE_STYLE_ID = SAFE_ID
export const styleIdFromURI = (uri) => String(uri || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()

/**
 * Installed styles: bundled ones first, then ~/.zotlet/styles. A dependent style (most journal
 * styles) renders with its parent's file, so `file` is always the file to format with;
 * `path` is the style's own file. Dependents whose parent is not installed are left out.
 */
export function listStyles(userDir) {
  const found = new Map(), dependents = []
  for (const dir of [BUILTIN_STYLES, userDir].filter(Boolean)) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      const id = name.slice(0, -4)
      if (!name.endsWith('.csl') || !SAFE_ID.test(id) || found.has(id) || dependents.some((d) => d.id === id)) continue
      const file = path.join(dir, name)
      try {
        const info = styleInfo(fs.readFileSync(file, 'utf8'))
        if (!info) continue
        const title = info.title || id
        const entry = { id, title, label: LABELS[id] || title, file, path: file, builtin: dir === BUILTIN_STYLES,
          uri: info.uri || `http://www.zotero.org/styles/${id}`, format: info.format }
        if (info.parent) dependents.push({ ...entry, parent: info.parent })
        else found.set(id, entry)
      } catch { /* unreadable style: skip */ }
    }
  }
  for (const dep of dependents) {
    const parent = found.get(styleIdFromURI(dep.parent)) || [...found.values()].find((s) => s.uri === dep.parent)
    if (parent) found.set(dep.id, { ...dep, file: parent.file, parent: parent.id, format: dep.format || parent.format })
  }
  const rank = (id) => (PREFERRED.includes(id) ? PREFERRED.indexOf(id) : PREFERRED.length)
  return [...found.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.title.localeCompare(b.title))
}

// Copy so citeproc's in-place annotations never leak back into the library.
function engineItem(item) {
  const copy = structuredClone(item)
  copy.id = String(copy.id)
  for (const key of ['author', 'editor', 'container-author', 'translator']) {
    if (Array.isArray(copy[key])) copy[key] = copy[key].filter((n) => n && typeof n === 'object')
  }
  return copy
}

export function makeEngine(xml, items, format) {
  const byId = new Map(items.map((i) => [String(i.id), engineItem(i)]))
  const sys = { retrieveLocale: () => LOCALE, retrieveItem: (id) => byId.get(String(id)) }
  const engine = new CSL.Engine(sys, xml, 'en-US', true)
  engine.setOutputFormat(format)
  return engine
}

/**
 * Format `items` (in that order) with the style `styleId`.
 * Returns { style, citation: {html, text}, bibliography: {html, text, entries} }.
 */
export function formatCitations({ styleId, items, userDir }) {
  const style = listStyles(userDir).find((s) => s.id === styleId)
  if (!style) throw Object.assign(new Error(`Unknown citation style "${styleId}"`), { status: 400 })
  if (!items.length) throw Object.assign(new Error('No references to format'), { status: 400 })
  const xml = fs.readFileSync(style.file, 'utf8')
  const ids = items.map((i) => String(i.id))
  const out = { style: { id: style.id, title: style.title } }
  for (const format of ['html', 'text']) {
    const engine = makeEngine(xml, items, format)
    engine.updateItems(ids)
    const cluster = engine.makeCitationCluster(ids.map((id) => ({ id })))
    let bib = false
    try { bib = engine.makeBibliography() } catch { bib = false }
    const entries = bib ? bib[1].map((e) => e.trim()) : []
    if (format === 'html') {
      out.citation = { html: cluster }
      out.bibliography = { html: entries.length ? `<div class="csl-bib-body">${entries.join('\n')}</div>` : '', entries: entries.length }
    } else {
      out.citation.text = cluster.trim()
      out.bibliography.text = entries.join('\n')
    }
  }
  return out
}
