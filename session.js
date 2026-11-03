// Shared library, native picker and transport-independent document session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { styleCatalog, readStyle, hasStyle, styleURI, resolveStyle } from './style-catalog.js'

const CSL = createRequire(import.meta.url)('citeproc')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(process.env.ZOTLET_HOME || os.homedir(), '.zotlet')
export const LIB = process.env.ZOTLET_LIB || path.join(HOME, 'library.json')
export const SCHEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'
const DEFAULT_STYLE = 'nature'

const paint = (code) => (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s))
export const tty = { dim: paint(2), bold: paint(1), green: paint(32), red: paint(31), yellow: paint(33) }

const rid = () => Math.random().toString(36).slice(2, 10)
const zkey = (s) => {
  const a = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
  let h = 0n
  for (let k = 0; k < s.length; k++) h += BigInt(s.charCodeAt(k)) * 31n ** BigInt(k)
  return Array.from({ length: 8 }, (_, k) => a[Number((h / 33n ** BigInt(k)) % 33n)]).join('')
}
export const uri = (id) => `http://zotero.org/users/local/zotlet/items/${zkey(id)}`
export const loadLib = () => (fs.existsSync(LIB) ? JSON.parse(fs.readFileSync(LIB, 'utf8')) : [])
export const year = (it) => it.issued?.['date-parts']?.[0]?.[0] ?? 'n.d.'
export const authors = (it) => {
  const a = it.author || []
  const fam = (x) => x.family || x.literal || ''
  return !a.length ? 'Anon.' : a.length === 1 ? fam(a[0]) : a.length === 2 ? `${fam(a[0])} & ${fam(a[1])}` : `${fam(a[0])} et al.`
}

// ---------- bundled styles (styles/*.csl) and locale ----------
export function styles() {
  return styleCatalog().map(({ id, title }) => ({ id, title }))
}
const styleXml = readStyle
const LOCALE = fs.readFileSync(path.join(HERE, 'locales', 'locales-en-US.xml'), 'utf8')
const styleId = (data) => resolveStyle(/<style id="([^"]+)"/.exec(data || '')?.[1])

// ---------- native picker (picker.jxa) ----------
export const ui = {
  pick(spec) {
    const tmp = path.join(os.tmpdir(), `zotlet-${process.pid}.json`)
    fs.writeFileSync(tmp, JSON.stringify(spec))
    try {
      return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', path.join(HERE, 'picker.jxa'), tmp],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')
    } catch (e) {
      const why = String(e.stderr || e.message).split('\n').filter((l) => l.trim() && !/TSM|IMK|CapsLock/.test(l)).pop() || 'unknown error'
      throw new Error(`The picker window failed to open: ${why}`)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  },
}

const searchText = (it) => [it.id, it.title, it['container-title'], it.DOI, year(it),
  ...(it.author || []).map((a) => `${a.family || a.literal || ''} ${a.given || ''}`)].join(' ').toLowerCase()

function pickItems(pool, selected, style) {
  if (!pool.length) throw new Error('Your library is empty. Add papers first:  zotlet add <DOI or PMID>')
  const st = styles()
  const r = ui.pick({
    mode: 'cite',
    placeholder: 'Search papers',
    selected,
    styles: st.map((s) => s.title),
    style: Math.max(0, st.findIndex((s) => s.id === style)),
    items: [...pool].reverse().map((it) => ({
      id: it.id,
      title: it.title || '(untitled)',
      sub: [authors(it), year(it), it['container-title']].filter(Boolean).join(' · '),
      key: it.id,
      search: searchText(it),
    })),
  })
  if (!r) return null
  return { items: r.ids.map((id) => pool.find((it) => it.id === id)).filter(Boolean), style: st[r.style]?.id || style }
}

function pickStyle(current) {
  const st = styles()
  const r = ui.pick({
    mode: 'style',
    placeholder: 'Citation style',
    selected: [current],
    items: st.map((s) => ({ id: s.id, title: s.title, sub: '', key: s.id === current ? 'current' : '', search: `${s.id} ${s.title}`.toLowerCase() })),
  })
  return r?.ids?.[0] ?? null
}

// ---------- formatting ----------
const parseCode = (code) => {
  try { return JSON.parse(code.slice(code.indexOf('{'), code.lastIndexOf('}') + 1)) } catch { return null }
}
const prefXml = (id, fieldType = 'ReferenceMark', bibliographyStyleSet = true, sessionID = rid(), version = 'zotlet') =>
  `<data data-version="3" zotero-version="${version}"><session id="${sessionID}"/><style id="${styleURI(id).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" hasBibliography="1" bibliographyStyleHasBeenSet="${bibliographyStyleSet ? 1 : 0}"/><prefs><pref name="fieldType" value="${fieldType}"/></prefs></data>`

function readData(data) {
  try { const parsed = JSON.parse(data); if (parsed?.dataVersion === 4) return parsed } catch {}
  return null
}

export function bibliographyStyle([meta]) {
  const tabs = []
  let first = 0, indent = 0
  if (meta.hangingindent) { indent = 720; first = -720 }
  else if (meta['second-field-align']) {
    const at = 24 + meta.maxoffset * 120
    first = -at
    if (meta['second-field-align'] === 'margin') tabs.push(0)
    else { indent = at; tabs.push(at) }
  }
  return [first, indent, 240 * meta.linespacing, 240 * meta.entryspacing, tabs, tabs.length]
}

function render(xml, items, cites, mode) {
  const e = new CSL.Engine({ retrieveLocale: () => LOCALE, retrieveItem: (id) => items[id] }, xml)
  e.setOutputFormat(mode)
  const out = e.rebuildProcessorState(cites.map((c) => ({
    citationID: c.j.citationID,
    citationItems: c.j.citationItems.map(({ itemData, uris, ...ci }) => ci),
    properties: { noteIndex: 0 },
  })), mode)
  let bib = false
  try { bib = e.makeBibliography() } catch {}
  return [Object.fromEntries(out.map(([cid, , s]) => [cid, s])), bib]
}

function bibRtf([meta, entries]) {
  const n = meta['second-field-align'] ? Math.max(480, meta.maxoffset * 150) : 720
  const indent = meta.hangingindent || meta['second-field-align'] ? `\\li${n}\\fi-${n} ` : ''
  return `{\\rtf ${indent}${entries.map((s) => s.replace(/\s+$/, '')).join('\\par ')}}`
}

async function refresh(doc, style, call, options) {
  const [ids, codes] = await call('Document.getFields', [doc, options.fieldType])
  const libMap = Object.fromEntries(loadLib().map((i) => [i.id, i]))
  const items = {}, cites = [], bibs = [], seen = new Set()
  ids.forEach((id, k) => {
    const code = codes[k]
    if (/^ITEM/.test(code)) {
      const j = parseCode(code)
      if (!j) return
      if (!j.citationID || seen.has(j.citationID)) j.citationID = rid()
      seen.add(j.citationID)
      for (const ci of j.citationItems) {
        ci.itemData = { ...(libMap[ci.id] || ci.itemData), id: ci.id }
        ci.uris ??= [uri(ci.id)]
        items[ci.id] = ci.itemData
      }
      cites.push({ id, j })
    } else if (/^BIBL/.test(code)) bibs.push(id)
  })
  if (!cites.length) return 0
  const xml = styleXml(style)
  const [formatted, bib] = render(xml, items, cites, options.outputFormat)
  const [txt] = render(xml, items, cites, 'text')
  for (const { id, j } of cites) {
    const r = formatted[j.citationID]
    j.properties = { formattedCitation: r, plainCitation: txt[j.citationID], noteIndex: 0 }
    j.schema = SCHEMA
    const text = options.outputFormat === 'rtf' ? (r.startsWith('{\\rtf') ? r : `{\\rtf ${r}}`) : r
    await call('Field.setText', [doc, id, text, true])
    await call('Field.setCode', [doc, id, `ITEM CSL_CITATION ${JSON.stringify(j)}`])
  }
  for (const id of bibs) {
    if (bib && options.setBibliographyStyle && !options.bibliographyStyleSet) {
      await call('Document.setBibliographyStyle', [doc, ...bibliographyStyle(bib)])
      options.bibliographyStyleSet = true
    }
    const text = !bib ? '' : options.outputFormat === 'rtf' ? bibRtf(bib) : bib[0].bibstart + bib[1].join('') + bib[0].bibend
    await call('Field.setText', [doc, id, text, true])
  }
  return cites.length
}

export async function runSession(cmd, call, session = {}) {
  const [, doc, capabilities] = await call('Application.getActiveDocument', [3])
  const options = { fieldType: 'ReferenceMark', outputFormat: 'rtf', supportedNotes: [], ...session, ...capabilities }
  const alert = (msg, buttons = 0) => call('Document.displayAlert', [doc, msg, 0, buttons])
  let note = '', mutated = false, serializeData
  if (options.finalCommit) {
    const invoke = call
    call = async (method, args) => {
      const value = await invoke(method, args)
      if (/^(Field\.(setText|setCode|removeCode|delete)|Document\.(insertField|convert|setBibliographyStyle))$/.test(method)) mutated = true
      return value
    }
  }
  try {
    if (options.modernData && !['addEditCitation', 'addEditBibliography', 'refresh', 'setDocPrefs', 'removeCodes'].includes(cmd)) throw new Error(`Unsupported command: ${cmd}`)
    if (!['rtf', 'html'].includes(options.outputFormat)) throw new Error(`Unsupported output format: ${options.outputFormat}`)
    const rawData = await call('Document.getDocumentData', [doc])
    if (options.modernData && typeof rawData !== 'string') throw new Error('Invalid document data: expected a string')
    const data = options.modernData ? readData(rawData) : null
    const stored = data ? resolveStyle(data.style?.styleID) : styleId(rawData)
    if (options.nativeFieldTypes) {
      const field = /<pref name="fieldType" value="([^"]+)"/.exec(rawData || '')?.[1]
      if (options.nativeFieldTypes.includes(field)) options.fieldType = field
    }
    options.bibliographyStyleSet = data ? !!data.style?.bibliographyStyleHasBeenSet : /bibliographyStyleHasBeenSet="1"/.test(rawData || '')
    let style = stored && hasStyle(stored) ? stored : DEFAULT_STYLE
    let sessionID = data?.sessionID || /<session id="([^"]+)"/.exec(rawData || '')?.[1]
    serializeData = () => {
      if (!options.modernData) return prefXml(style)
      sessionID ||= rid()
      if (!data) {
        let xml = prefXml(style, options.fieldType, options.bibliographyStyleSet, sessionID, options.version)
        const prefs = /<prefs>([\s\S]*?)<\/prefs>/.exec(rawData || '')
        if (prefs) {
          const field = `<pref name="fieldType" value="${options.fieldType}"/>`
          const existing = /<pref name="fieldType" value="[^"]*"\s*\/>/
          const retained = existing.test(prefs[1]) ? prefs[1].replace(existing, field) : prefs[1] + field
          xml = xml.replace(/<prefs>[\s\S]*?<\/prefs>/, `<prefs>${retained}</prefs>`)
        }
        return xml
      }
      return JSON.stringify({ style: { styleID: styleURI(style),
        ...(data.style?.locale ? { locale: data.style.locale } : {}), hasBibliography: true,
        bibliographyStyleHasBeenSet: options.bibliographyStyleSet },
        prefs: { ...data.prefs, fieldType: options.fieldType, noteType: 0 }, sessionID,
        zoteroVersion: options.version || 'zotlet', dataVersion: 4 })
    }
    const setStyle = async (s) => {
      if (s === stored && s === style) return
      style = s
      if (options.setBibliographyStyle) options.bibliographyStyleSet = false
      await call('Document.setDocumentData', [doc, serializeData()])
    }
    if (cmd === 'setDocPrefs') {
      const s = pickStyle(style)
      if (!s) return (note = 'cancelled')
      await setStyle(s)
    } else if (cmd === 'addEditCitation') {
      const cur = await call('Document.cursorInField', [doc, options.fieldType])
      const old = cur && /^ITEM/.test(cur[1]) ? parseCode(cur[1]) : null
      const pool = [...loadLib()]
      for (const ci of old?.citationItems || []) if (!pool.some((it) => it.id === ci.id)) pool.push({ ...ci.itemData, id: ci.id })
      const r = pickItems(pool, old ? old.citationItems.map((c) => c.id) : [], style)
      if (!r?.items.length) return (note = 'cancelled')
      await setStyle(r.style)
      const fieldId = old ? cur[0] : (await call('Document.insertField', [doc, options.fieldType, 0]))[0]
      const j = { citationID: old?.citationID || rid(), properties: { noteIndex: 0 },
        citationItems: r.items.map((it) => ({ id: it.id, uris: [uri(it.id)], itemData: it })), schema: SCHEMA }
      await call('Field.setCode', [doc, fieldId, `ITEM CSL_CITATION ${JSON.stringify(j)}`])
      note = r.items.map((it) => it.id).join(', ')
    } else if (cmd === 'addEditBibliography') {
      const [, codes] = await call('Document.getFields', [doc, options.fieldType])
      if (!codes.some((c) => /^BIBL/.test(c))) {
        const [id] = await call('Document.insertField', [doc, options.fieldType, 0])
        await call('Field.setCode', [doc, id, 'BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY'])
      }
    } else if (cmd === 'removeCodes') {
      if ((await alert('Convert all citations to plain text? They can no longer be refreshed or edited.', 1)) !== 1) return (note = 'cancelled')
      const [ids] = await call('Document.getFields', [doc, options.fieldType])
      for (const id of ids) await call('Field.removeCode', [doc, id])
      return (note = `${ids.length} fields unlinked`)
    }
    if (!stored) await setStyle(style)
    const n = await refresh(doc, style, call, options)
    note = [note, `${n} citation${n === 1 ? '' : 's'} · ${style}`].filter(Boolean).join('  ')
  } catch (e) {
    note = tty.red(e.message)
    await alert(`zotlet: ${e.message}`).catch(() => {})
  } finally {
    if (options.finalCommit && mutated && serializeData) {
      await call('Document.setDocumentData', [doc, serializeData()])
        .catch(async (error) => { note = tty.red(error.message); await alert(`zotlet: ${error.message}`).catch(() => {}) })
    }
    await call('Document.complete', [doc]).catch(() => {})
    return note
  }
}

