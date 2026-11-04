// Read the DOI of an article from its PDF, so a dropped PDF can be imported like a typed DOI.
// The PDF is only read in memory; it is never stored.
import zlib from 'node:zlib'

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
