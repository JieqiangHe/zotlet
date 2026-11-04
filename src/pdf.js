// Linked PDFs: find the DOI inside a PDF, find where a dropped PDF lives on disk, open it.
//
// zotlet never copies or stores PDFs. A browser does not reveal the path of a dropped file,
// so the page sends the bytes once; the server reads the DOI from them and finds the original
// file on disk by name, then confirms it by comparing a SHA-256 of the contents.
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const MAX_INFLATED = 80 * 1024 * 1024

// Crossref's recommended pattern, plus cleanup of what PDFs put around it.
const DOI_RE = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi

function cleanDOI(raw) {
  let doi = raw.replace(/[.,;:]+$/, '')
  // Cut at the first ")" without an opening partner (the end of a PDF string, "...)Tj").
  let depth = 0
  for (let k = 0; k < doi.length; k++) {
    if (doi[k] === '(') depth++
    else if (doi[k] === ')' && --depth < 0) { doi = doi.slice(0, k); break }
  }
  doi = doi.replace(/[.,;:]+$/, '')
  // Publisher PDFs often glue the next word on ("...111729Received"); a DOI suffix rarely ends in a capitalised word.
  doi = doi.replace(/(\d)(?:Received|Available|Accepted|Published|Copyright|Contents|Keywords|Article|Abstract|E-mail|Email|www)[a-z]*$/i, '$1')
  return /^10\.\d{4,9}\/\S{2,}$/.test(doi) ? doi : null
}

/** Inflate every FlateDecode stream (page contents, object streams, XMP). */
function streams(latin1, bytes) {
  const out = []
  let total = 0, from = 0
  for (;;) {
    const start = latin1.indexOf('stream', from)
    if (start < 0) break
    from = start + 6
    if (latin1.slice(start - 3, start) === 'end') continue
    let dataStart = start + 6
    if (latin1[dataStart] === '\r') dataStart++
    if (latin1[dataStart] === '\n') dataStart++
    const end = latin1.indexOf('endstream', dataStart)
    if (end < 0) break
    const dict = latin1.slice(Math.max(0, latin1.lastIndexOf('<<', start - 1) - 1), start)
    from = end + 9
    if (!/\/FlateDecode/.test(dict) || /\/Subtype\s*\/Image/.test(dict)) continue
    try {
      const data = zlib.inflateSync(bytes.subarray(dataStart, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      total += data.length
      if (total > MAX_INFLATED) break
      out.push(data.toString('latin1'))
    } catch { /* not zlib data, or encrypted */ }
  }
  return out
}

/** Join the pieces of a text-showing array: [(10.1016/j.)-250(plaphy)] → 10.1016/j.plaphy */
function joinText(s) {
  return s
    .replace(/\\([()\\])/g, '$1')
    .replace(/<([0-9a-fA-F\s]{4,})>/g, (m, hex) => {
      const clean = hex.replace(/\s+/g, '')
      if (clean.length % 2) return m
      const text = Buffer.from(clean, 'hex').toString('latin1')
      return /^[\x20-\x7e]+$/.test(text) ? `(${text})` : m
    })
    // Kerning inside TJ arrays: a large negative number is a word gap, anything else joins.
    .replace(/\)\s*(-?\d+(?:\.\d+)?)\s*\(/g, (m, n) => (Number(n) <= -150 ? ' ' : ''))
}

const META_PATTERNS = [
  /<(?:prism|pdfx|crossmark):doi>\s*(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.[^<\s]+)\s*<\//gi,
  /<dc:identifier>\s*(?:<rdf:Bag>\s*<rdf:li>)?\s*(?:doi:\s*|info:doi\/|https?:\/\/(?:dx\.)?doi\.org\/)(10\.[^<\s]+)/gi,
  /\/(?:doi|DOI)\s*\((10\.[^)]+)\)/g,
  /prism:doi="(10\.[^"]+)"/gi,
]

/**
 * Find the DOI of the article in a PDF. Metadata (XMP, document info) wins; otherwise the DOI
 * that occurs most often (journals print it in the header or footer of each page), with the
 * earliest one breaking ties. Returns { doi, source } or null.
 */
export function extractDOI(bytes) {
  const latin1 = bytes.toString('latin1')
  const texts = [latin1, ...streams(latin1, bytes)]
  const meta = new Map(), seen = new Map()
  let order = 0
  for (const raw of texts) {
    for (const re of META_PATTERNS) {
      for (const m of raw.matchAll(re)) {
        const doi = cleanDOI(m[1])
        if (doi) meta.set(doi.toLowerCase(), { doi, count: (meta.get(doi.toLowerCase())?.count || 0) + 1 })
      }
    }
    const text = joinText(raw)
    for (const m of text.matchAll(DOI_RE)) {
      const doi = cleanDOI(m[0])
      if (!doi) continue
      const key = doi.toLowerCase()
      const entry = seen.get(key) || { doi, count: 0, first: order++ }
      entry.count++
      seen.set(key, entry)
    }
  }
  if (meta.size) return { doi: [...meta.values()].sort((a, b) => b.count - a.count)[0].doi, source: 'metadata' }
  if (!seen.size) return null
  const best = [...seen.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]
  return { doi: best.doi, source: 'text' }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const SKIP_DIRS = new Set(['node_modules', 'Library', 'AppData', 'Applications', '$RECYCLE.BIN', 'System Volume Information', 'snap', 'go', '.Trash'])

/** Folders searched for a dropped file, most likely first. */
export function searchRoots(home = os.homedir(), platform = process.platform) {
  const roots = ['Downloads', 'Desktop', 'Documents'].map((d) => path.join(home, d))
  if (platform === 'darwin') roots.push(path.join(home, 'Library', 'Mobile Documents'), path.join(home, 'Library', 'CloudStorage'))
  roots.push(home)
  return roots
}

async function spotlight(name) {
  try {
    const { stdout } = await execute('/usr/bin/mdfind', ['-name', name], { encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024 })
    return stdout.split('\n').filter((p) => p && path.basename(p) === name)
  } catch { return [] }
}

/** Breadth-first search for files called `name`, within a time budget. */
async function walk(roots, name, { deadline, maxDepth = 6 }) {
  const found = [], visited = new Set()
  const queue = roots.map((dir) => ({ dir, depth: 0 }))
  while (queue.length && Date.now() < deadline) {
    const { dir, depth } = queue.shift()
    let real
    try { real = await fs.realpath(dir) } catch { continue }
    if (visited.has(real)) continue
    visited.add(real)
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === name) found.push(path.join(dir, entry.name))
      else if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return found
}

/**
 * Find the file on disk that has this name, size and content hash. Returns its absolute path or null.
 * On macOS Spotlight is asked first; then the usual folders are searched (a few seconds at most).
 */
export async function locatePdf({ name, size, hash }, { roots = searchRoots(), platform = process.platform, budgetMs = 6000, useSpotlight = platform === 'darwin' } = {}) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) return null
  const checked = new Set()
  const matches = async (file) => {
    if (checked.has(file)) return false
    checked.add(file)
    try {
      const stat = await fs.stat(file)
      return stat.isFile() && (!Number.isFinite(size) || stat.size === size) && await hashFile(file) === hash
    } catch { return false }
  }
  if (useSpotlight) for (const file of await spotlight(name)) if (await matches(file)) return file
  for (const file of await walk(roots, name, { deadline: Date.now() + budgetMs })) if (await matches(file)) return file
  return null
}

/** Check a path the user gave us: absolute, an existing file, a PDF. Returns the resolved path. */
export async function checkPdfPath(file) {
  if (typeof file !== 'string' || !file.trim()) throw Object.assign(new Error('Enter the full path of the PDF'), { status: 400 })
  let value = file.trim().replace(/^file:\/\//, '')
  try { value = decodeURIComponent(value) } catch { /* keep */ }
  value = value.replace(/^["']|["']$/g, '').replace(/^~(?=\/|\\|$)/, os.homedir())
  if (!path.isAbsolute(value)) throw Object.assign(new Error('Use the full path, e.g. /Users/you/Downloads/paper.pdf'), { status: 400 })
  let stat
  try { stat = await fs.stat(value) } catch { throw Object.assign(new Error(`No file at ${value}`), { status: 404 }) }
  if (!stat.isFile()) throw Object.assign(new Error('That path is a folder, not a PDF'), { status: 400 })
  if (!/\.pdf$/i.test(value)) throw Object.assign(new Error('Only PDF files can be linked'), { status: 400 })
  return path.resolve(value)
}

/** Open a file with the system's default application. */
export function openFile(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${file}"`]]
      : ['xdg-open', [file]]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' })
    child.once('error', (error) => reject(Object.assign(new Error(`Could not open the PDF: ${error.message}`), { status: 500 })))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** macOS: let the user pick a PDF in a native dialog. Resolves to a path, or null if cancelled. */
export async function choosePdf() {
  if (process.platform !== 'darwin') throw Object.assign(new Error('Paste the full path of the PDF instead'), { status: 400 })
  try {
    const { stdout } = await execute('/usr/bin/osascript', ['-e', 'activate', '-e', 'POSIX path of (choose file with prompt "Choose the PDF for this reference" of type {"com.adobe.pdf"})'], { encoding: 'utf8' })
    return stdout.trim() || null
  } catch (error) {
    if (/\(-128\)/.test(error.stderr || '')) return null
    throw Object.assign(new Error(`The file dialog failed: ${String(error.stderr || error.message).trim()}`), { status: 500 })
  }
}
