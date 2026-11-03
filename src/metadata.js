// DOI / PMID parsing, lookup and CSL-JSON normalization.
//
// Remote metadata (Crossref, DataCite, PubMed) carries many fields that are
// not part of a clean CSL item: author objects with `sequence`, `affiliation`,
// `ORCID`, `role`…, date objects with `timestamp`, titles as arrays, JATS
// markup in abstracts. Everything that enters the library goes through
// `normalizeItem`, so stored items are always plain, valid CSL-JSON.

export const CSL_TYPES = new Set([
  'article', 'article-journal', 'article-magazine', 'article-newspaper', 'bill', 'book', 'broadcast', 'chapter',
  'classic', 'collection', 'dataset', 'document', 'entry', 'entry-dictionary', 'entry-encyclopedia', 'event',
  'figure', 'graphic', 'hearing', 'interview', 'legal_case', 'legislation', 'manuscript', 'map', 'motion_picture',
  'musical_score', 'pamphlet', 'paper-conference', 'patent', 'performance', 'periodical', 'personal_communication',
  'post', 'post-weblog', 'regulation', 'report', 'review', 'review-book', 'software', 'song', 'speech', 'standard',
  'thesis', 'treaty', 'webpage',
])

// Crossref / DataCite type names that sometimes leak through content negotiation.
const TYPE_ALIASES = {
  'journal-article': 'article-journal', 'proceedings-article': 'paper-conference', 'book-chapter': 'chapter',
  'book-section': 'chapter', 'book-part': 'chapter', 'edited-book': 'book', 'monograph': 'book',
  'reference-book': 'book', 'posted-content': 'article', 'dissertation': 'thesis', 'journal': 'periodical',
  'report-component': 'report', 'component': 'article', 'peer-review': 'review', 'reference-entry': 'entry',
  'misc': 'article', 'other': 'article',
}

const TEXT_FIELDS = ['title', 'container-title', 'container-title-short', 'collection-title', 'volume', 'issue', 'page',
  'number', 'edition', 'DOI', 'PMID', 'PMCID', 'URL', 'ISSN', 'ISBN', 'publisher', 'publisher-place', 'abstract',
  'language', 'note', 'genre', 'event-title', 'event-place']
const NAME_FIELDS = ['author', 'editor', 'container-author', 'translator']
const DATE_FIELDS = ['issued', 'accessed']
const NAME_KEYS = ['family', 'given', 'literal', 'suffix', 'dropping-particle', 'non-dropping-particle']

/** Every field a library item may carry after normalization (plus `id`). */
export const ITEM_FIELDS = new Set(['type', ...TEXT_FIELDS, ...NAME_FIELDS, ...DATE_FIELDS])

const squash = (value) => value.replace(/\s+/g, ' ').trim()

export function cleanName(name) {
  if (typeof name === 'string') return squash(name) ? { literal: squash(name) } : null
  if (!name || typeof name !== 'object' || Array.isArray(name)) return null
  const out = {}
  for (const key of NAME_KEYS) if (typeof name[key] === 'string' && squash(name[key])) out[key] = squash(name[key])
  if (!out.family && !out.literal) {
    // Organisations arrive as { name: "…" } from Crossref; a lone given name is kept as a literal.
    const fallback = typeof name.name === 'string' && squash(name.name) ? squash(name.name) : out.given
    if (!fallback) return null
    delete out.given
    out.literal = fallback
  }
  if (out.literal) for (const key of Object.keys(out)) if (key !== 'literal') delete out[key]
  return out
}

export function cleanDate(date) {
  if (typeof date === 'string' || typeof date === 'number') {
    const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(String(date).trim())
    if (m) return { 'date-parts': [[m[1], m[2], m[3]].filter(Boolean).map(Number)] }
    return String(date).trim() ? { literal: String(date).trim() } : null
  }
  if (!date || typeof date !== 'object') return null
  const first = Array.isArray(date['date-parts']) ? date['date-parts'][0] : null
  if (Array.isArray(first)) {
    const parts = []
    for (const part of first) {
      const n = typeof part === 'string' ? Number(part.trim()) : part
      if (!Number.isInteger(n) || n <= 0) break
      parts.push(n)
    }
    if (parts.length && parts[0] >= 1 && parts[0] <= 9999) {
      if (parts[1] > 12) parts.length = 1
      if (parts[2] > 31) parts.length = 2
      return { 'date-parts': [parts] }
    }
  }
  if (typeof date.literal === 'string' && date.literal.trim()) return { literal: date.literal.trim() }
  if (typeof date.raw === 'string') return cleanDate(date.raw)
  if (typeof date['date-time'] === 'string') return cleanDate(date['date-time'])
  return null
}

const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, code) => {
  const c = code.toLowerCase()
  if (c[0] === '#') {
    const n = c[1] === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10)
    try { return String.fromCodePoint(n) } catch { return whole }
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[c]
})

/** Strip JATS / HTML markup from abstracts. */
export function plainText(value) {
  return squash(decodeEntities(String(value)
    .replace(/<(?:jats:)?title>\s*(?:abstract|summary)\s*<\/(?:jats:)?title>/gi, '')
    .replace(/<\/(?:jats:)?(?:p|sec|title)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')))
}

/** Remove markup that citeproc cannot render, keeping its supported inline tags. */
export function cleanTitle(value) {
  return squash(String(value)
    .replace(/<(\/?)(?:jats:|mml:)?(i|italic)>/gi, '<$1i>')
    .replace(/<(\/?)(?:jats:|mml:)?(b|bold)>/gi, '<$1b>')
    .replace(/<(\/?)(?:jats:|mml:)?(sub|sup)>/gi, '<$1$2>')
    .replace(/<(?!\/?(?:i|b|sub|sup)>)[^>]+>/gi, ''))
}

export function normalizeDOI(value) {
  if (typeof value !== 'string') return ''
  let doi = value.trim()
  try { doi = decodeURIComponent(doi) } catch { /* keep as typed */ }
  doi = doi.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()
  const m = /10\.\d{4,9}\/\S+/.exec(doi)
  return m ? m[0].replace(/[.,;:)\]}>'"]+$/, '') : ''
}

/**
 * Turn any CSL-ish record into a clean library item (without `id`).
 * Unknown remote fields are dropped; this is only applied to *incoming*
 * metadata, never to items already in the library.
 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Lookup returned no metadata')
  const item = {}
  let type = typeof raw.type === 'string' ? raw.type.trim() : ''
  type = TYPE_ALIASES[type] || type
  item.type = CSL_TYPES.has(type) ? type : 'article-journal'

  for (const key of TEXT_FIELDS) {
    let value = raw[key]
    if (Array.isArray(value)) value = value.find((v) => typeof v === 'string' && v.trim()) ?? ''
    if (typeof value === 'number') value = String(value)
    if (typeof value !== 'string') continue
    value = key === 'abstract' ? plainText(value) : key === 'title' || key === 'container-title' ? cleanTitle(decodeEntities(value)) : squash(value)
    if (value) item[key] = value
  }
  if (!item.page && typeof raw['article-number'] === 'string' && raw['article-number'].trim()) item.page = raw['article-number'].trim()
  if (item.DOI) item.DOI = normalizeDOI(item.DOI) || item.DOI
  if (item.PMID) item.PMID = item.PMID.replace(/\D/g, '') || undefined
  if (!item.PMID) delete item.PMID

  for (const key of NAME_FIELDS) {
    if (!Array.isArray(raw[key])) continue
    const names = raw[key].map(cleanName).filter(Boolean)
    if (names.length) item[key] = names
  }

  const issued = cleanDate(raw.issued) || cleanDate(raw['published-print']) || cleanDate(raw['published-online'])
    || cleanDate(raw.published) || cleanDate(raw.created)
  if (issued) item.issued = issued
  const accessed = cleanDate(raw.accessed)
  if (accessed) item.accessed = accessed

  if (!item.title) throw new Error('The record has no title')
  return item
}

// ---------- identifiers ----------

/**
 * Split pasted text into DOI / PMID requests.
 * Returns [{ input, kind: 'doi'|'pmid'|'invalid', value }] without duplicates.
 */
export function parseIdentifiers(text) {
  if (typeof text !== 'string') return []
  const prepared = text
    .replace(/\bpmid\s*[:#]?\s*(?=\d)/gi, 'PMID:')
    .replace(/\bdoi\s*:\s*/gi, 'doi:')
  const tokens = prepared.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
  const out = [], seen = new Set()
  for (const input of tokens) {
    let kind = 'invalid', value = input
    const pubmed = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(input)
    const pmid = /^PMID:(\d{1,9})$/i.exec(input) || /^(\d{1,9})$/.exec(input)
    if (pubmed || pmid) { kind = 'pmid'; value = (pubmed || pmid)[1] }
    else if (normalizeDOI(input)) { kind = 'doi'; value = normalizeDOI(input) }
    const key = `${kind}:${value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ input, kind, value })
  }
  return out
}

// ---------- remote lookup ----------

const USER_AGENT = 'zotlet/1.0 (personal reference manager)'

async function getJSON(fetchImpl, url, accept) {
  let response
  try {
    response = await fetchImpl(url, { headers: { Accept: accept, 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
  } catch (error) {
    const host = new URL(url).hostname
    throw new Error(error.name === 'TimeoutError' ? `${host} did not answer in time` : `Cannot reach ${host} (${error.cause?.code || error.message}). Check your internet connection.`)
  }
  if (response.status === 404) throw Object.assign(new Error('Not found'), { status: 404 })
  if (!response.ok) throw new Error(`Lookup failed (HTTP ${response.status})`)
  const text = await response.text()
  try { return JSON.parse(text) } catch { throw new Error('The lookup service returned something other than JSON') }
}

const doiPath = (doi) => doi.split('/').map(encodeURIComponent).join('/')

export async function lookupDOI(doi, fetchImpl = fetch) {
  const errors = []
  for (const url of [`https://doi.org/${doiPath(doi)}`,
    `https://api.crossref.org/works/${doiPath(doi)}/transform/application/vnd.citationstyles.csl+json`]) {
    try {
      const data = await getJSON(fetchImpl, url, 'application/vnd.citationstyles.csl+json')
      const item = normalizeItem(data)
      item.DOI = item.DOI || doi
      return item
    } catch (error) { errors.push(error) }
  }
  if (errors.every((e) => e.status === 404)) throw new Error(`DOI ${doi} was not found`)
  throw errors.find((e) => e.status !== 404) || errors[0]
}

export async function lookupPMID(pmid, fetchImpl = fetch) {
  let data
  try {
    data = await getJSON(fetchImpl, `https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pubmed/?format=csl&id=${pmid}`, 'application/json')
  } catch (error) {
    if (error.status === 404) throw new Error(`PMID ${pmid} was not found`)
    throw error
  }
  if (Array.isArray(data)) data = data[0]
  if (!data || typeof data !== 'object' || (!data.title && !data.DOI)) throw new Error(`PMID ${pmid} was not found`)
  let item
  const doi = normalizeDOI(data.DOI || '')
  if (doi) {
    // Crossref metadata is usually richer (full journal names, pages); keep PubMed IDs on top.
    try { item = await lookupDOI(doi, fetchImpl) } catch { /* fall back to PubMed */ }
  }
  item ||= normalizeItem(data)
  item.PMID = pmid
  if (typeof data.PMCID === 'string' && data.PMCID.trim()) item.PMCID = data.PMCID.trim()
  return item
}

export function lookupIdentifier({ kind, value }, fetchImpl = fetch) {
  if (kind === 'doi') return lookupDOI(value, fetchImpl)
  if (kind === 'pmid') return lookupPMID(value, fetchImpl)
  return Promise.reject(new Error('Not a DOI or PMID'))
}

// ---------- citation keys ----------

const ascii = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function citationKey(item, usedIds) {
  const first = (item.author || item.editor || [])[0] || {}
  const name = ascii(first.family || first.literal || '').slice(0, 24) || ascii(item.title || '').slice(0, 12) || 'ref'
  const year = item.issued?.['date-parts']?.[0]?.[0] ?? ''
  const base = `${name}${year}`
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds)
  if (!used.has(base)) return base
  for (let n = 0; ; n++) {
    let suffix = '', k = n
    do { suffix = String.fromCharCode(97 + (k % 26)) + suffix; k = Math.floor(k / 26) - 1 } while (k >= 0)
    if (!used.has(base + suffix)) return base + suffix
  }
}
