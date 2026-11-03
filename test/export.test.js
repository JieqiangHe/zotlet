import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toBibTeX, toRIS, toCSLJSON, bibtexEscape } from '../src/export.js'

const items = [
  { id: 'zhang2026', type: 'article-journal', title: 'Drought & heat in <i>Arabidopsis</i>: 50% {loss}',
    author: [{ family: 'Zhang', given: 'Wei' }, { family: 'Beethoven', given: 'Ludwig', 'non-dropping-particle': 'van' }, { literal: 'Plant Stress Consortium' }],
    'container-title': 'Plant Physiology and Biochemistry', issued: { 'date-parts': [[2026, 3]] }, volume: '232', page: '100-110',
    DOI: '10.1016/j.plaphy.2026.111729', ISSN: '0981-9428', PMID: '123', custom: 'x' },
  { id: 'zhang2026', type: 'book', title: 'Same key', publisher: 'Elsevier', 'publisher-place': 'Amsterdam', issued: { 'date-parts': [[2020]] } },
  { id: '2024 weird key!', type: 'chapter', title: 'Chapter', 'container-title': 'Handbook', editor: [{ family: 'Ed', given: 'Itor' }] },
]

test('CSL JSON keeps items verbatim', () => {
  assert.deepEqual(JSON.parse(toCSLJSON(items)), items)
})

test('BibTeX escapes specials, maps types and keeps keys unique', () => {
  const bib = toBibTeX(items)
  assert.match(bib, /^@article\{zhang2026,$/m)
  assert.match(bib, /^@book\{zhang2026_2,$/m)
  assert.match(bib, /^@incollection\{ref2024weirdkey,$/m)
  assert.ok(bib.includes('title     = {{Drought \\& heat in \\textit{Arabidopsis}: 50\\% \\{loss\\}}},'))
  assert.match(bib, /author\s+= \{Zhang, Wei and van Beethoven, Ludwig and \{Plant Stress Consortium\}\}/)
  assert.match(bib, /pages\s+= \{100--110\}/)
  assert.match(bib, /month\s+= \{mar\}/)
  assert.match(bib, /doi\s+= \{10.1016\/j.plaphy.2026.111729\}/)
  assert.match(bib, /address\s+= \{Amsterdam\}/)
  assert.match(bib, /booktitle\s+= \{Handbook\}/)
  assert.match(bib, /editor\s+= \{Ed, Itor\}/)
  // Balanced braces in every entry.
  for (const entry of bib.split(/\n(?=@)/)) {
    let depth = 0
    for (let i = 0; i < entry.length; i++) {
      if (entry[i] === '\\') { i++; continue }
      if (entry[i] === '{') depth++
      if (entry[i] === '}') depth--
      assert.ok(depth >= 0)
    }
    assert.equal(depth, 0)
  }
  assert.equal(bibtexEscape('a_b#c$d'), 'a\\_b\\#c\\$d')
})

test('RIS has one tag per line, split pages and a terminator per record', () => {
  const ris = toRIS(items)
  const records = ris.split('ER  - ').filter((r) => r.trim())
  assert.equal(records.length, 3)
  assert.match(ris, /^TY {2}- JOUR\r$/m)
  assert.match(ris, /^AU {2}- Zhang, Wei\r$/m)
  assert.match(ris, /^AU {2}- van Beethoven, Ludwig\r$/m)
  assert.match(ris, /^AU {2}- Plant Stress Consortium\r$/m)
  assert.match(ris, /^TI {2}- Drought & heat in Arabidopsis: 50% \{loss\}\r$/m)
  assert.match(ris, /^SP {2}- 100\r$/m)
  assert.match(ris, /^EP {2}- 110\r$/m)
  assert.match(ris, /^DA {2}- 2026\/03\/\/\r$/m)
  assert.match(ris, /^DO {2}- 10.1016\/j.plaphy.2026.111729\r$/m)
  assert.match(ris, /^TY {2}- CHAP\r$/m)
  assert.match(ris, /^A2 {2}- Ed, Itor\r$/m)
  for (const line of ris.split('\r\n').filter(Boolean)) assert.match(line, /^[A-Z][A-Z0-9] {2}- /)
})
