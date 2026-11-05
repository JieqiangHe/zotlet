// Native citation picker on macOS (src/quickformat.jxa.js, run with the built-in osascript),
// like Zotero's quick format bar. Other platforms, or any failure, use the browser picker instead.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

export const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'quickformat.jxa.js')

const plain = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const yearOf = (i) => i.issued?.['date-parts']?.[0]?.[0] ?? i.issued?.literal ?? ''
const nameOf = (n) => (n ? n.literal || [n['non-dropping-particle'], n.family].filter(Boolean).join(' ') : '')
function authorsShort(item) {
  const a = item.author || item.editor || []
  if (!a.length) return ''
  if (a.length === 1) return nameOf(a[0])
  if (a.length === 2) return `${nameOf(a[0])} & ${nameOf(a[1])}`
  return `${nameOf(a[0])} et al.`
}

/** The picker request in the plain shape the native script needs (labels prepared here). */
export function nativeSpec(spec, styles, projects = []) {
  const out = { mode: spec.mode === 'style' ? 'style' : 'cite', style: spec.style, askStyle: !!spec.askStyle,
    styles: styles.map(({ id, label }) => ({ id, label })) }
  if (out.mode === 'style') {
    if (typeof spec.bookmarks === 'boolean') { out.bookmarks = spec.bookmarks; out.bookmarksLocked = !!spec.bookmarksLocked }
    return out
  }
  const inProjects = new Map()
  for (const p of projects) for (const id of p.itemIds || []) inProjects.set(id, [...(inProjects.get(id) || []), p.name])
  // Newest first, like the library list.
  out.items = [...(spec.items || [])].reverse().map((item) => {
    const id = String(item.id), who = authorsShort(item), year = String(yearOf(item))
    const journal = plain(item['container-title'] || item.publisher || '')
    return {
      id, title: plain(item.title) || '(untitled)',
      detail: [who, year].filter(Boolean).join(' '),
      short: [who.replace(/ et al\.$/, ' et al.') || plain(item.title).slice(0, 24), year].filter(Boolean).join(' '),
      search: [id, plain(item.title), journal, year, item.DOI, item.PMID, ...(item.author || []).map((n) => `${n.given || ''} ${nameOf(n)}`),
        ...(inProjects.get(id) || [])].filter(Boolean).join(' ').toLowerCase(),
    }
  })
  out.selected = (spec.selected || []).map(String)
  return out
}

/** Check what the native picker returned against the request. null = cancelled. */
export function parseResult(stdout, spec, styleIds) {
  const text = String(stdout || '').trim()
  if (!text) return null
  let value
  try { value = JSON.parse(text) } catch { throw new Error(`The picker returned something unexpected: ${text.slice(0, 120)}`) }
  const style = typeof value?.style === 'string' && styleIds.includes(value.style) ? value.style : undefined
  if (spec.mode === 'style') {
    if (!style) return null
    return typeof value.bookmarks === 'boolean' ? { style, bookmarks: value.bookmarks } : { style }
  }
  const known = new Set((spec.items || []).map((i) => String(i.id)))
  const ids = Array.isArray(value?.ids) ? value.ids.map(String).filter((id) => known.has(id)) : []
  if (!ids.length) return null
  return style ? { ids, style } : { ids }
}

/** Show the native picker. Resolves to the choice, or null if cancelled; rejects if it cannot run. */
export async function nativePick(spec, styles, { projects, run = runScript, tmp = os.tmpdir() } = {}) {
  const file = path.join(tmp, `zotlet-pick-${randomBytes(8).toString('hex')}.json`)
  await fs.writeFile(file, JSON.stringify(nativeSpec(spec, styles, projects)), { mode: 0o600 })
  try {
    return parseResult(await run(file), spec, styles.map((s) => s.id))
  } finally { await fs.rm(file, { force: true }) }
}

function runScript(file) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', SCRIPT, file], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().split('\n').pop() || 'osascript failed'))
        else resolve(stdout)
      })
  })
}

/** The native picker is used on macOS unless ZOTLET_PICKER=web. */
export const nativeAvailable = (platform = process.platform, env = process.env) => platform === 'darwin' && env.ZOTLET_PICKER !== 'web'
