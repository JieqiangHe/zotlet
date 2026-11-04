import zlib from 'node:zlib'
// CSL JSON, BibTeX and RIS export.

const year = (item) => item.issued?.['date-parts']?.[0]?.[0]
const dateParts = (item) => item.issued?.['date-parts']?.[0] || []
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '')

export function toCSLJSON(items) {
  return JSON.stringify(items, null, 2) + '\n'
}

// ---------- BibTeX ----------

const BIBTEX_TYPES = {
  'article-journal': 'article', 'article-magazine': 'article', 'article-newspaper': 'article', article: 'article',
  book: 'book', chapter: 'incollection', 'paper-conference': 'inproceedings', report: 'techreport',
  thesis: 'phdthesis', manuscript: 'unpublished',
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const escapeTeX = (text) => text
  .replace(/\\/g, '\\textbackslash ')
  .replace(/([{}&%$#_])/g, '\\$1')
  .replace(/~/g, '\\textasciitilde{}')
  .replace(/\^/g, '\\textasciicircum{}')

const TEX_TAGS = { i: '\\textit{', b: '\\textbf{', sub: '\\textsubscript{', sup: '\\textsuperscript{' }

/** Escape TeX specials; CSL rich text (<i>, <b>, <sub>, <sup>) becomes the matching TeX command. */
export function bibtexEscape(value) {
  let out = '', depth = 0
  for (const part of String(value).split(/(<\/?(?:i|b|sub|sup)>)/i)) {
    const tag = /^<(\/?)(i|b|sub|sup)>$/i.exec(part)
    if (!tag) out += escapeTeX(part.replace(/<[^>]+>/g, ''))
    else if (!tag[1]) { out += TEX_TAGS[tag[2].toLowerCase()]; depth++ }
    else if (depth > 0) { out += '}'; depth-- }
  }
  return (out + '}'.repeat(depth)).replace(/\s+/g, ' ').trim()
}

const bibName = (n) => {
  if (n.literal) return `{${bibtexEscape(n.literal)}}`
  const family = [n['non-dropping-particle'], n.family].filter(Boolean).join(' ')
  const given = [n.given, n['dropping-particle']].filter(Boolean).join(' ')
  const parts = [family, n.suffix, given].filter(Boolean).map(bibtexEscape)
  return parts.join(', ')
}

export function bibtexKey(id, used) {
  let key = String(id ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_:.-]/g, '') || 'ref'
  if (!/^[A-Za-z]/.test(key)) key = `ref${key}`
  let candidate = key
  for (let n = 2; used.has(candidate); n++) candidate = `${key}_${n}`
  used.add(candidate)
  return candidate
}

function bibtexEntry(item, used) {
  const type = BIBTEX_TYPES[item.type] || 'misc'
  const fields = []
  const add = (name, value, { raw = false, protect = false } = {}) => {
    if (value === undefined || value === null || value === '') return
    const text = raw ? String(value) : bibtexEscape(value)
    if (text) fields.push([name, protect ? `{${text}}` : text])
  }
  if (item.author?.length) add('author', item.author.map(bibName).join(' and '), { raw: true })
  if (item.editor?.length) add('editor', item.editor.map(bibName).join(' and '), { raw: true })
  add('title', item.title, { protect: true })
  const container = item['container-title']
  if (type === 'article') add('journal', container)
  else if (type === 'incollection' || type === 'inproceedings') add('booktitle', container)
  else if (container) add('howpublished', container)
  add('year', year(item))
  const month = dateParts(item)[1]
  if (month >= 1 && month <= 12) fields.push(['month', MONTHS[month - 1]])
  add('volume', item.volume)
  add('number', item.issue || (type === 'techreport' ? item.number : undefined))
  add('pages', item.page && String(item.page).replace(/\s*[-–—]+\s*/g, '--'))
  if (type === 'techreport') add('institution', item.publisher)
  else if (type === 'phdthesis') add('school', item.publisher)
  else add('publisher', item.publisher)
  add('address', item['publisher-place'])
  add('edition', item.edition)
  add('isbn', item.ISBN)
  add('issn', item.ISSN)
  add('doi', item.DOI, { raw: true })
  add('url', item.URL, { raw: true })
  add('pmid', item.PMID, { raw: true })
  add('pmcid', item.PMCID, { raw: true })
  add('abstract', item.abstract)
  add('note', item.note)
  const body = fields.map(([k, v]) => `  ${k.padEnd(9)} = {${v}}`).join(',\n')
  return `@${type}{${bibtexKey(item.id, used)},\n${body}\n}\n`
}

export function toBibTeX(items) {
  const used = new Set()
  return items.map((item) => bibtexEntry(item, used)).join('\n')
}

// ---------- RIS ----------

const RIS_TYPES = {
  'article-journal': 'JOUR', 'article-magazine': 'MGZN', 'article-newspaper': 'NEWS', article: 'JOUR', book: 'BOOK',
  chapter: 'CHAP', 'paper-conference': 'CPAPER', report: 'RPRT', thesis: 'THES', dataset: 'DATA', webpage: 'ELEC',
  patent: 'PAT', manuscript: 'UNPB', software: 'COMP',
}

const risName = (n) => n.literal || [[n['non-dropping-particle'], n.family].filter(Boolean).join(' '), n.given, n.suffix].filter(Boolean).join(', ')
const risText = (s) => stripTags(s).replace(/\s+/g, ' ').trim()

function risEntry(item) {
  const lines = [['TY', RIS_TYPES[item.type] || 'GEN']]
  const add = (tag, value) => { if (value !== undefined && value !== null && risText(value)) lines.push([tag, risText(value)]) }
  for (const n of item.author || []) add('AU', risName(n))
  for (const n of item.editor || []) add('A2', risName(n))
  add('TI', item.title)
  if (item.type === 'article-journal' || item.type === 'article') add('JO', item['container-title'])
  add('T2', item['container-title'])
  add('J2', item['container-title-short'])
  const [y, m, d] = dateParts(item)
  if (y) {
    add('PY', y)
    add('DA', [y, m ? String(m).padStart(2, '0') : '', d ? String(d).padStart(2, '0') : '', ''].join('/'))
  }
  add('VL', item.volume)
  add('IS', item.issue)
  if (item.page) {
    const [start, end] = String(item.page).split(/\s*[-–—]+\s*/)
    add('SP', start)
    add('EP', end)
  }
  add('PB', item.publisher)
  add('CY', item['publisher-place'])
  add('SN', item.ISSN || item.ISBN)
  add('DO', item.DOI)
  add('UR', item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''))
  if (item.PMID) add('AN', `PMID:${item.PMID}`)
  add('AB', item.abstract)
  add('N1', item.note)
  add('ID', item.id)
  lines.push(['ER', ''])
  return lines.map(([tag, value]) => `${tag}  - ${value}`).join('\r\n') + '\r\n'
}

export function toRIS(items) {
  return items.map(risEntry).join('\r\n')
}

// ---------- zip (all formats at once) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A minimal zip writer (deflate, UTF-8 names). `files` is [[name, string | Buffer]]. */
export function zip(files, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const parts = [], central = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const packed = zlib.deflateRawSync(data), nameBytes = Buffer.from(name, 'utf8'), crc = crc32(data)
    const local = Buffer.alloc(30), dir = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10)
    dir.writeUInt16LE(time, 12); dir.writeUInt16LE(day, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42)
    parts.push(local, nameBytes, packed)
    central.push(dir, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

const README = (name, n) => `${name} — ${n} reference${n === 1 ? '' : 's'} exported from zotlet

${name}.ris   RIS: Zotero, EndNote, Mendeley, most reference managers
${name}.json  CSL JSON: Zotero, and zotlet itself (drop it on the zotlet list)
${name}.bib   BibTeX: LaTeX

Into Zotero: File → Import… → choose ${name}.ris (or ${name}.json).
Documents written with zotlet keep a full copy of every cited reference, so Zotero can
refresh them in Word or LibreOffice even before the references are imported.
`.replace(/\n/g, '\r\n')

/** Everything at once: one zip with CSL JSON, BibTeX and RIS. */
export function toZip(items, name = 'references') {
  return zip([[`${name}.ris`, toRIS(items)], [`${name}.json`, toCSLJSON(items)], [`${name}.bib`, toBibTeX(items)], ['README.txt', README(name, items.length)]])
}

export const FORMATS = {
  zip: { label: 'All formats (.zip)', extension: 'zip', mime: 'application/zip', render: toZip },
  json: { label: 'CSL JSON', extension: 'json', mime: 'application/vnd.citationstyles.csl+json', render: toCSLJSON },
  bibtex: { label: 'BibTeX', extension: 'bib', mime: 'application/x-bibtex', render: toBibTeX },
  ris: { label: 'RIS', extension: 'ris', mime: 'application/x-research-info-systems', render: toRIS },
}
