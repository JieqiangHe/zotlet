// Linked PDFs: DOI extraction, locating the dropped file on disk, the API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractDOI, locatePdf, checkPdfPath, sha256 } from '../src/pdf.js'
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

test('locatePdf finds the dropped file by name and content, not by name alone', async () => {
  const home = tempDir()
  const bytes = makePdf({ pages: ['(a)Tj'] })
  fs.mkdirSync(path.join(home, 'Downloads', 'old'), { recursive: true })
  fs.mkdirSync(path.join(home, 'Documents', 'papers', '2026'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Downloads', 'old', 'paper.pdf'), makePdf({ pages: ['(b)Tj'] })) // same name, other file
  const real = path.join(home, 'Documents', 'papers', '2026', 'paper.pdf')
  fs.writeFileSync(real, bytes)
  const roots = ['Downloads', 'Desktop', 'Documents'].map((d) => path.join(home, d))
  assert.equal(await locatePdf({ name: 'paper.pdf', size: bytes.length, hash: sha256(bytes) }, { roots, useSpotlight: false }), real)
  assert.equal(await locatePdf({ name: 'missing.pdf', size: 1, hash: 'x' }, { roots, useSpotlight: false }), null)
  assert.equal(await locatePdf({ name: '../paper.pdf', size: 1, hash: 'x' }, { roots, useSpotlight: false }), null)
})

test('checkPdfPath accepts real PDF paths only', async () => {
  const dir = tempDir(), file = path.join(dir, 'My Paper.pdf')
  fs.writeFileSync(file, makePdf())
  assert.equal(await checkPdfPath(`"${file}"`), file)
  assert.equal(await checkPdfPath(`file://${encodeURI(file)}`), file)
  await assert.rejects(checkPdfPath('paper.pdf'), /full path/)
  await assert.rejects(checkPdfPath(path.join(dir, 'nope.pdf')), /No file/)
  await assert.rejects(checkPdfPath(dir), /folder/)
})

test('API: drop a PDF → reference imported and file path linked; open, relink, unlink', async () => {
  const dir = tempDir(), disk = path.join(dir, 'Downloads')
  fs.mkdirSync(disk)
  const pdfPath = path.join(disk, '1-s2.0-S0981942826001.pdf')
  fs.writeFileSync(pdfPath, ARTICLE)
  const opened = []
  const server = await startServer({
    port: 0, dir, store: createStore({ dir }), quiet: true,
    fetchImpl: fakeFetch({ dois: { [ELSEVIER]: fixture('elsevier-crossref.json') } }),
    locate: (file, options) => locatePdf(file, { ...options, roots: [disk], useSpotlight: false }),
    openPath: async (file) => { opened.push(file) },
  })
  const headers = { 'X-Zotlet-Token': server.token }
  const drop = async (bytes, name, query = '') => {
    const res = await fetch(new URL(`api/pdf/import${query}`, server.url), { method: 'POST', body: bytes,
      headers: { ...headers, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(name), 'X-File-Size': String(bytes.length) } })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status })
    return data
  }
  const call = async (route, body) => {
    const res = await fetch(new URL(`api/${route}`, server.url), body === undefined ? { headers }
      : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status })
    return data
  }
  try {
    const first = await drop(ARTICLE, path.basename(pdfPath))
    assert.equal(first.status, 'added')
    assert.equal(first.doi, ELSEVIER)
    assert.equal(first.path, pdfPath)
    let state = await call('state')
    assert.equal(state.pdfs[first.id], pdfPath)
    assert.equal(state.items.length, 1)
    assert.equal(Object.keys(state.items[0]).some((k) => /pdf/i.test(k)), false, 'library.json stays CSL-JSON')

    // Dropping it again finds the existing reference.
    assert.equal((await drop(ARTICLE, path.basename(pdfPath))).status, 'duplicate')
    assert.equal((await call('state')).items.length, 1)

    await call('pdf/open', { id: first.id })
    assert.deepEqual(opened, [pdfPath])

    // A PDF without a DOI is reported, nothing is imported.
    const plainPdf = makePdf({ pages: ['(Notes)Tj'] })
    fs.writeFileSync(path.join(disk, 'notes.pdf'), plainPdf)
    const none = await drop(plainPdf, 'notes.pdf')
    assert.deepEqual([none.status, none.path], ['no-doi', path.join(disk, 'notes.pdf')])

    // Dropped on a row: only link.
    const linked = await drop(plainPdf, 'notes.pdf', `?itemId=${first.id}`)
    assert.deepEqual([linked.status, linked.path], ['linked', path.join(disk, 'notes.pdf')])
    assert.equal((await call('state')).pdfs[first.id], path.join(disk, 'notes.pdf'))

    // A file that cannot be found on disk is imported but not linked.
    const elsewhere = await drop(makePdf({ pages: ['(doi:10.1016/j.plaphy.2026.111729)Tj'] }), 'not-on-disk.pdf')
    assert.deepEqual([elsewhere.status, elsewhere.path], ['duplicate', null])

    // Moved file: opening says so; linking by path fixes it.
    fs.renameSync(path.join(disk, 'notes.pdf'), path.join(dir, 'moved.pdf'))
    await assert.rejects(call('pdf/open', { id: first.id }), (e) => e.status === 410 && /no longer at/.test(e.message))
    await call('pdf/link', { id: first.id, path: path.join(dir, 'moved.pdf') })
    await call('pdf/open', { id: first.id })
    await assert.rejects(call('pdf/link', { id: first.id, path: 'relative.pdf' }), (e) => e.status === 400)

    await call('pdf/unlink', { id: first.id })
    assert.equal((await call('state')).pdfs[first.id], undefined)
    await assert.rejects(call('pdf/open', { id: first.id }), (e) => e.status === 404)

    // Deleting the reference forgets its PDF.
    await call('pdf/link', { id: first.id, path: pdfPath })
    await call('items/delete', { ids: [first.id] })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'web-state.json'), 'utf8')).pdfs, {})
    assert.ok(fs.existsSync(pdfPath), 'the PDF itself is never touched')

    await assert.rejects(drop(Buffer.from('hello'), 'x.pdf'), (e) => e.status === 400)
  } finally { server.close(); server.closeAllConnections() }
})
