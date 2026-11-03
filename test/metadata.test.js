import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeItem, parseIdentifiers, cleanName, cleanDate, normalizeDOI, citationKey, lookupDOI, lookupPMID } from '../src/metadata.js'
import { fixture, fakeFetch } from './helpers.js'

const ALLOWED_NAME_KEYS = new Set(['family', 'given', 'literal', 'suffix', 'dropping-particle', 'non-dropping-particle'])

test('Elsevier Crossref record normalizes to clean CSL (authors lose sequence/affiliation/ORCID)', () => {
  const item = normalizeItem(fixture('elsevier-crossref.json'))
  assert.equal(item.type, 'article-journal')
  assert.equal(item.DOI, '10.1016/j.plaphy.2026.111729')
  assert.equal(item.title, 'Transcriptomic and metabolomic insights into <i>Arabidopsis</i> responses to combined drought & heat stress')
  assert.equal(item['container-title'], 'Plant Physiology and Biochemistry')
  assert.equal(item.ISSN, '0981-9428')
  assert.equal(item.page, '111729')
  assert.deepEqual(item.issued, { 'date-parts': [[2026, 3]] })
  assert.equal(item.abstract, 'Plants face combined stresses.')
  assert.equal(item.author.length, 5)
  for (const name of item.author) {
    for (const key of Object.keys(name)) assert.ok(ALLOWED_NAME_KEYS.has(key), `unexpected author key ${key}`)
    for (const value of Object.values(name)) assert.equal(typeof value, 'string')
  }
  assert.deepEqual(item.author[0], { family: 'Zhang', given: 'Wei' })
  assert.deepEqual(item.author[2], { family: 'Beethoven', given: 'Ludwig', 'non-dropping-particle': 'van' })
  assert.deepEqual(item.author[3], { literal: 'Plant Stress Consortium' })
  for (const junk of ['indexed', 'license', 'link', 'assertion', 'score', 'reference-count', 'issn-type', 'created', 'published-print']) {
    assert.ok(!(junk in item), `${junk} should be dropped`)
  }
})

test('names: strings, lone given names, garbage', () => {
  assert.deepEqual(cleanName('WHO'), { literal: 'WHO' })
  assert.deepEqual(cleanName({ given: 'Plato', sequence: 'first' }), { literal: 'Plato' })
  assert.equal(cleanName({ sequence: 'first', affiliation: [] }), null)
  assert.equal(cleanName(null), null)
  assert.deepEqual(cleanName({ family: '  Smith ', given: 'J.  R.', affiliation: [{ name: 'x' }] }), { family: 'Smith', given: 'J. R.' })
})

test('dates: strings, nulls, out-of-range parts', () => {
  assert.deepEqual(cleanDate({ 'date-parts': [['2020', '5']] }), { 'date-parts': [[2020, 5]] })
  assert.deepEqual(cleanDate({ 'date-parts': [[2020, 13, 40]] }), { 'date-parts': [[2020]] })
  assert.equal(cleanDate({ 'date-parts': [[null]] }), null)
  assert.deepEqual(cleanDate('2019-08-27'), { 'date-parts': [[2019, 8, 27]] })
  assert.deepEqual(cleanDate({ raw: '2001' }), { 'date-parts': [[2001]] })
})

test('crossref type names are mapped to CSL types; titles as arrays are flattened', () => {
  const item = normalizeItem({ type: 'journal-article', title: ['First', 'Second'], 'container-title': ['J'], author: [] })
  assert.equal(item.type, 'article-journal')
  assert.equal(item.title, 'First')
  assert.equal(item['container-title'], 'J')
  assert.ok(!('author' in item))
  assert.equal(normalizeItem({ type: 'weird-thing', title: 'x' }).type, 'article-journal')
  assert.throws(() => normalizeItem({ type: 'article', title: '' }), /no title/)
})

test('identifier parsing handles DOIs, links, PMIDs and junk', () => {
  const parsed = parseIdentifiers(`10.1016/j.plaphy.2026.111729
https://doi.org/10.1038/s41586-020-2649-2, doi:10.1126/science.abc1234.
PMID: 31452104; https://pubmed.ncbi.nlm.nih.gov/12345678/
hello 10.1016/J.PLAPHY.2026.111729`)
  assert.deepEqual(parsed.map((p) => [p.kind, p.value]), [
    ['doi', '10.1016/j.plaphy.2026.111729'],
    ['doi', '10.1038/s41586-020-2649-2'],
    ['doi', '10.1126/science.abc1234'],
    ['pmid', '31452104'],
    ['pmid', '12345678'],
    ['invalid', 'hello'],
  ])
  assert.equal(normalizeDOI('https://dx.doi.org/10.1000%2Fabc'), '10.1000/abc')
})

test('citation keys are ascii, unique and stable', () => {
  const item = { author: [{ family: 'García-López' }], issued: { 'date-parts': [[2026]] } }
  assert.equal(citationKey(item, []), 'garcialopez2026')
  assert.equal(citationKey(item, ['garcialopez2026']), 'garcialopez2026a')
  assert.equal(citationKey(item, ['garcialopez2026', 'garcialopez2026a']), 'garcialopez2026b')
  const many = new Set(['x2020', ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `x2020${c}`)])
  assert.equal(citationKey({ author: [{ family: 'X' }], issued: { 'date-parts': [[2020]] } }, many), 'x2020aa')
  assert.equal(citationKey({ title: 'Only a title' }, []), 'onlyatitle')
})

test('lookupDOI falls back to the Crossref API when doi.org fails', async () => {
  const data = fixture('elsevier-crossref.json')
  const fetch = async (url) => (String(url).startsWith('https://doi.org/')
    ? new Response('bad gateway', { status: 502 })
    : new Response(JSON.stringify(data), { status: 200 }))
  const item = await lookupDOI('10.1016/j.plaphy.2026.111729', fetch)
  assert.equal(item.DOI, '10.1016/j.plaphy.2026.111729')
})

test('lookupDOI reports a missing DOI clearly', async () => {
  await assert.rejects(lookupDOI('10.9999/nope', fakeFetch()), /was not found/)
})

test('lookupPMID prefers Crossref metadata but keeps PubMed ids', async () => {
  const pubmed = { ...fixture('pubmed.json'), DOI: '10.1016/j.plaphy.2026.111729' }
  const fetch = fakeFetch({ pmids: { 31452104: pubmed }, dois: { '10.1016/j.plaphy.2026.111729': fixture('elsevier-crossref.json') } })
  const item = await lookupPMID('31452104', fetch)
  assert.equal(item['container-title'], 'Plant Physiology and Biochemistry')
  assert.equal(item.PMID, '31452104')
  assert.equal(item.PMCID, 'PMC6710000')

  const only = await lookupPMID('31452104', fakeFetch({ pmids: { 31452104: fixture('pubmed.json') } }))
  assert.equal(only.title, 'A PubMed-only record')
  assert.deepEqual(only.issued, { 'date-parts': [[2019, 8, 27]] })
  assert.ok(!('id' in only) && !('source' in only))
})
