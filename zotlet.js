#!/usr/bin/env node
// zotlet: a tiny local reference manager with Zotero-compatible citations.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fetchItem, mkkey } from './metadata.js'
import { serve, styles, LIB, SCHEMA, uri, loadLib, tty, authors, year } from './server.js'

const rid = () => Math.random().toString(36).slice(2, 10)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function save(lib) {
  fs.mkdirSync(path.dirname(LIB), { recursive: true })
  fs.writeFileSync(LIB, JSON.stringify(lib, null, 2))
}

async function add(idents) {
  const lib = loadLib()
  let added = 0
  for (const ident of idents) {
    let it
    try { it = await fetchItem(ident.trim()) } catch (e) { console.log(`${tty.red('✗')} ${ident}  ${tty.dim(e.message)}`); continue }
    const dup = it.DOI && lib.find((i) => (i.DOI || '').toLowerCase() === it.DOI.toLowerCase())
    if (dup) { console.log(`${tty.yellow('•')} ${tty.bold(dup.id)}  ${tty.dim('already in library')}`); continue }
    it.id = mkkey(it, lib)
    lib.push(it)
    added++
    console.log(`${tty.green('✓')} ${tty.bold(it.id)}  ${clip(`${authors(it)} ${year(it)} · ${it.title || ''}`, 70)}`)
  }
  if (added) save(lib)
  console.log(tty.dim(`${added} added · ${lib.length} in library`))
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function ls(q) {
  const lib = loadLib()
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = lib.filter((i) => { const t = JSON.stringify(i).toLowerCase(); return words.every((w) => t.includes(w)) })
  const w = Math.max(...hits.map((i) => i.id.length), 4)
  const cols = process.stdout.columns || 100
  for (const i of hits) {
    const meta = `${authors(i)} ${year(i)}`
    console.log(`${tty.bold(i.id.padEnd(w))}  ${tty.dim(clip(meta, 24).padEnd(24))}  ${clip(i.title || '', Math.max(20, cols - w - 30))}`)
  }
  console.log(tty.dim(`${hits.length} of ${lib.length} items${q ? ` matching "${q}"` : ''}`))
}

// ---------- docx ----------
const r = (x) => `<w:r>${x}</w:r>`
const t = (s) => r(`<w:t xml:space="preserve">${esc(s)}</w:t>`)
const field = (instr, shown) => r('<w:fldChar w:fldCharType="begin"/>') + r(`<w:instrText xml:space="preserve"> ${esc(instr)} </w:instrText>`) +
  r('<w:fldChar w:fldCharType="separate"/>') + t(shown) + r('<w:fldChar w:fldCharType="end"/>')

function short(i) {
  const a = i.author || [{}]
  let fam = a[0].family || a[0].literal || 'Anon'
  fam += a.length > 2 ? ' et al.' : a.length === 2 ? ` & ${a[1].family || ''}` : ''
  return `${fam}, ${i.issued?.['date-parts']?.[0]?.[0] ?? 'n.d.'}`
}

function cite(items) {
  const shown = `(${items.map(short).join('; ')})`
  const c = { citationID: rid(), properties: { formattedCitation: shown, plainCitation: shown, noteIndex: 0 },
    citationItems: items.map((i) => ({ id: i.id, uris: [uri(i.id)], itemData: i })), schema: SCHEMA }
  return field(`ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(c)}`, shown)
}

function zip(files) {
  const parts = [], central = []
  let off = 0
  for (const [name, str] of files) {
    const data = Buffer.from(str), comp = zlib.deflateRawSync(data), n = Buffer.from(name), crc = zlib.crc32(data)
    const h = Buffer.alloc(30), c = Buffer.alloc(46)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt16LE(33, 12)
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt16LE(33, 14)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42)
    parts.push(h, n, comp)
    central.push(c, n)
    off += 30 + n.length + comp.length
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10)
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, e])
}

function docx(src, out, style = 'nature') {
  const lib = Object.fromEntries(loadLib().map((i) => [i.id, i]))
  const paras = fs.readFileSync(src, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).map((line) => {
    if (line.trim() === '[bibliography]')
      return field('ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY', '[Bibliography: Refresh in Zotero]')
    let runs = '', pos = 0
    for (const m of line.matchAll(/\[(@[^\]]+)\]/g)) {
      const keys = m[1].split(';').map((k) => k.trim().replace(/^@/, ''))
      const miss = keys.filter((k) => !lib[k])
      if (miss.length) { console.error(tty.red(`Not in library: ${miss.join(', ')}`)); process.exit(1) }
      runs += t(line.slice(pos, m.index)) + cite(keys.map((k) => lib[k]))
      pos = m.index + m[0].length
    }
    return runs + t(line.slice(pos))
  })
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const O = 'application/vnd.openxmlformats-officedocument'
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const pref = `<data data-version="3" zotero-version="zotlet"><session id="${rid()}"/><style id="http://www.zotero.org/styles/${style}" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/></prefs></data>`
  const props = (pref.match(/.{1,255}/gs) || []).map((c, k) =>
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${k + 2}" name="ZOTERO_PREF_${k + 1}"><vt:lpwstr>${esc(c)}</vt:lpwstr></property>`).join('')
  fs.writeFileSync(out, zip([
    ['[Content_Types].xml', `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${O}.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="${O}.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/docProps/custom.xml" ContentType="${O}.custom-properties+xml"/></Types>`],
    ['_rels/.rels', `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="${R}/custom-properties" Target="docProps/custom.xml"/></Relationships>`],
    ['word/document.xml', `${X}<w:document ${W}><w:body>${paras.map((p) => `<w:p>${p}</w:p>`).join('')}<w:sectPr/></w:body></w:document>`],
    ['word/styles.xml', `${X}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`],
    ['word/_rels/document.xml.rels', `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ['docProps/custom.xml', `${X}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${props}</Properties>`],
  ]))
  console.log(`${tty.green('✓')} ${out}  ${tty.dim('open it in GenOffice and press Refresh')}`)
}

const HELP = `${tty.bold('zotlet')} ${tty.dim('— a tiny local reference manager with Zotero-compatible citations')}

${tty.bold('Usage')}
  zotlet add <DOI|PMID>...            fetch metadata into your library
  zotlet ls [words]                   list or search the library
  zotlet docx <draft.txt> <out.docx> [--style nature|science|cell]
                                       turn a plain-text draft into a .docx with live citations
  zotlet server                       start TCP 23116 and HTTP 23119 (quit Zotero first)
  zotlet web                          serve local management on 23121 and start citations

${tty.bold('Drafts')}
  One paragraph per line. Cite with [@key] or [@key1; @key2].
  A line containing only [bibliography] marks where the reference list goes.

${tty.bold('Styles')}
  ${styles().map((s) => s.id).join(', ')}  ${tty.dim('— add more by dropping a .csl file into the styles folder')}

${tty.dim(`Library: ${LIB}`)}`

const [cmd, ...a] = process.argv.slice(2)
if (cmd === 'add' && a.length) await add(a)
else if (cmd === 'ls') ls(a.join(' '))
else if (cmd === 'docx' && a.length >= 2) {
  const i = a.indexOf('--style')
  docx(a[0], a[1], i >= 0 ? a[i + 1] : 'nature')
} else if (cmd === 'server') await serve().ready.catch(() => { process.exitCode = 1 })
else if (cmd === 'web') {
  const { serveWeb } = await import('./web/server.js')
  await serveWeb(23121, { autoCitations: true }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
else {
  console.log(HELP)
  process.exit(cmd && !['-h', '--help', 'help'].includes(cmd) ? 1 : 0)
}
