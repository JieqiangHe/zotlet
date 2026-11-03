import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zotlet-test-'))
}

/** A fake `fetch` serving DOI and PubMed lookups from a table. Records requested URLs. */
export function fakeFetch({ dois = {}, pmids = {} } = {}) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    const u = new URL(url)
    let body
    if (u.hostname === 'doi.org') body = dois[decodeURIComponent(u.pathname.slice(1)).toLowerCase()]
    else if (u.hostname === 'api.crossref.org') body = dois[decodeURIComponent(u.pathname.replace(/^\/works\//, '').replace(/\/transform\/.*$/, '')).toLowerCase()]
    else if (u.hostname === 'api.ncbi.nlm.nih.gov') body = pmids[u.searchParams.get('id')]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  fn.calls = calls
  return fn
}
