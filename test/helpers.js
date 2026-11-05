import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zotlet-test-'))
}

/**
 * A fake `fetch` serving DOI and PubMed lookups from a table. Records requested URLs.
 * `pubmedSearch` maps "<term>[<field>]" (NCBI E-utilities) to PMIDs; `unreachable` hosts fail like a dead network.
 */
export function fakeFetch({ dois = {}, pmids = {}, pubmedSearch = {}, unreachable = [] } = {}) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    const u = new URL(url)
    if (unreachable.includes(u.hostname)) throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } })
    let body
    if (u.hostname === 'eutils.ncbi.nlm.nih.gov') {
      const term = u.searchParams.get('term') || ''
      body = { esearchresult: { idlist: pubmedSearch[term.toLowerCase()] || [] } }
    } else if (u.hostname === 'doi.org') body = dois[decodeURIComponent(u.pathname.slice(1)).toLowerCase()]
    else if (u.hostname === 'api.crossref.org') body = dois[decodeURIComponent(u.pathname.replace(/^\/works\//, '').replace(/\/transform\/.*$/, '')).toLowerCase()]
    else if (u.hostname === 'api.ncbi.nlm.nih.gov') body = pmids[u.searchParams.get('id')]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  fn.calls = calls
  return fn
}

/** A small but well-formed PDF whose pages draw `pages` (content stream operators), Flate-compressed. */
export function makePdf({ pages = [], xmp = '', info = '' } = {}) {
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  const stream = (dict, data, compress = true) => {
    const bytes = compress ? zlib.deflateSync(Buffer.from(data, 'latin1')) : Buffer.from(data, 'latin1')
    return Buffer.concat([Buffer.from(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')])
  }
  const font = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))
  const kids = pages.map((ops) => {
    const content = add(stream('', `BT /F1 9 Tf 50 750 Td ${ops} ET`))
    return add(Buffer.from(`<< /Type /Page /Parent PAGES /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  })
  const pagesId = objects.length + 1
  add(Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`))
  for (const k of kids) objects[k - 1] = Buffer.from(objects[k - 1].toString('latin1').replace('PAGES', `${pagesId} 0 R`), 'latin1')
  const meta = xmp ? add(stream('/Type /Metadata /Subtype /XML', xmp, false)) : null
  const catalog = add(Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R${meta ? ` /Metadata ${meta} 0 R` : ''} >>`))
  const infoId = add(Buffer.from(`<< /Producer (test) ${info} >>`))
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = []
  let length = parts[0].length
  objects.forEach((body, i) => {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')])
    parts.push(chunk)
    length += chunk.length
  })
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(parts)
}

