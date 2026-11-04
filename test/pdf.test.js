// PDFs dropped on the list: DOI extraction and the import API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractDOI } from '../src/pdf.js'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { fixture, fakeFetch, tempDir, makePdf } from './helpers.js'

const ELSEVIER = '10.1016/j.plaphy.2026.111729'

const ARTICLE = makePdf({
  pages: [
    // DOI split across kerned pieces, as publishers' PDFs do, with a word glued after a gap.
    `[(Plant Physiology and Biochemistry 2026)-250(https://doi.org/10.1016/j.pla)12(phy.2026.111729)-300(Received)]TJ`,
    `(References) Tj [(1. Smith, J. doi:10.1038/s41586-020-0001-x)]TJ (2. Doe, R. https://doi.org/10.1126/science.abc1234.) Tj`,
    `(Footer: https://doi.org/10.1016/j.plaphy.2026.111729)Tj`,
  ],
})

test('extracts the article DOI from page text, ignoring the reference list', () => {
  assert.deepEqual(extractDOI(ARTICLE), { doi: ELSEVIER, source: 'text' })
})

test('XMP / document info metadata wins over text', () => {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><prism:doi>10.1093/plcell/koab001</prism:doi><dc:identifier>doi:10.1093/plcell/koab001</dc:identifier></rdf:Description></rdf:RDF></x:xmpmeta>`
  assert.deepEqual(extractDOI(makePdf({ pages: ['(see 10.1038/s41586-020-0001-x)Tj'], xmp })), { doi: '10.1093/plcell/koab001', source: 'metadata' })
  assert.equal(extractDOI(makePdf({ pages: ['(x)Tj'], info: '/doi (10.1186/1752-2897-4-1)' })).doi, '10.1186/1752-2897-4-1')
})

test('keeps balanced parentheses, cuts PDF syntax, finds nothing when there is no DOI', () => {
  assert.equal(extractDOI(makePdf({ pages: ['(doi:10.1016/S0092-8674\\(00\\)80001-X)Tj (doi:10.1016/S0092-8674\\(00\\)80001-X)Tj'] })).doi, '10.1016/S0092-8674(00)80001-X')
  assert.equal(extractDOI(makePdf({ pages: ['(Just a preprint, no identifier. Version 10.2 of 2024/05.)Tj'] })), null)
  assert.equal(extractDOI(Buffer.from('not a pdf')), null)
})

test('API: a dropped PDF is imported by its DOI and not kept', async () => {
  const dir = tempDir()
  const server = await startServer({ port: 0, dir, store: createStore({ dir }), quiet: true,
    fetchImpl: fakeFetch({ dois: { [ELSEVIER]: fixture('elsevier-crossref.json') } }) })
  const drop = async (bytes, name = 'paper.pdf', query = '') => {
    const res = await fetch(new URL(`api/pdf/import${query}`, server.url), { method: 'POST', body: bytes,
      headers: { 'X-Zotlet-Token': server.token, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(name) } })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status })
    return data
  }
  try {
    const first = await drop(ARTICLE, '1-s2.0 paper.pdf')
    assert.deepEqual([first.status, first.doi, first.file], ['added', ELSEVIER, '1-s2.0 paper.pdf'])
    assert.match(first.title, /Arabidopsis/)
    assert.equal((await drop(ARTICLE)).status, 'duplicate')
    assert.equal((await drop(makePdf({ pages: ['(Notes)Tj'] }))).status, 'no-doi')
    const unknown = await drop(makePdf({ pages: ['(doi:10.9999/does-not-exist)Tj'] }))
    assert.deepEqual([unknown.status, unknown.doi], ['error', '10.9999/does-not-exist'])
    await assert.rejects(drop(Buffer.from('hello')), (e) => e.status === 400)
    await assert.rejects(drop(ARTICLE, 'p.pdf', '?projectId=nope'), (e) => e.status === 404)

    const items = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
    assert.equal(items.length, 1)
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)), [], 'no PDF is stored')
  } finally { server.close(); server.closeAllConnections() }
})
