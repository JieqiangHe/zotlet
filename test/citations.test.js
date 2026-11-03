import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { listStyles, formatCitations } from '../src/citations.js'
import { tempDir } from './helpers.js'

const items = [
  { id: 'zhang2026', type: 'article-journal', title: 'Drought & heat in <i>Arabidopsis</i>', author: [{ family: 'Zhang', given: 'Wei' }, { family: 'Li', given: 'Jun' }, { literal: 'Plant Stress Consortium' }],
    'container-title': 'Plant Physiology and Biochemistry', issued: { 'date-parts': [[2026, 3]] }, volume: '232', page: '111729', DOI: '10.1016/j.plaphy.2026.111729' },
  { id: 'doe2019', type: 'article-journal', title: 'Second paper', author: [{ family: 'Doe', given: 'Jane' }], 'container-title': 'Nature Communications', issued: { 'date-parts': [[2019, 8, 27]] }, volume: '10', page: '3812' },
  { id: 'nodate', type: 'book', title: 'A book without a date or author', publisher: 'Self' },
]

test('the common journal styles are bundled, Nature/Science/Cell first', () => {
  const ids = listStyles().map((s) => s.id)
  assert.deepEqual(ids.slice(0, 3), ['nature', 'science', 'cell'])
  for (const id of ['apa', 'ieee', 'chicago-author-date', 'nlm-citation-sequence', 'the-lancet', 'pnas', 'plos']) assert.ok(ids.includes(id), id)
})

test('every bundled style formats a citation and bibliography', () => {
  for (const style of listStyles()) {
    const out = formatCitations({ styleId: style.id, items })
    assert.ok(out.citation.text.length > 0, `${style.id} citation`)
    assert.equal(out.bibliography.entries, 3, `${style.id} entries`)
    assert.equal(out.bibliography.text.split('\n').length, 3, `${style.id} text lines`)
    assert.ok(!/undefined|\[CSL STYLE ERROR/.test(out.bibliography.text), `${style.id} output: ${out.bibliography.text}`)
  }
})

test('Nature numbers references in list order; APA is author-date', () => {
  const nature = formatCitations({ styleId: 'nature', items })
  assert.equal(nature.citation.text, '1–3')
  assert.match(nature.bibliography.text.split('\n')[0], /^1\. Zhang, W\., Li, J\.,? & Plant Stress Consortium\. Drought & heat in Arabidopsis\. Plant Physiology and Biochemistry 232, 111729 \(2026\)\.$/)
  assert.match(nature.bibliography.html, /<i>Arabidopsis<\/i>/)
  const apa = formatCitations({ styleId: 'apa', items: items.slice(0, 2) })
  assert.equal(apa.citation.text, '(Doe, 2019; Zhang et al., 2026)')
})

test('formatting never mutates the library items', () => {
  const copy = structuredClone(items)
  formatCitations({ styleId: 'cell', items })
  assert.deepEqual(items, copy)
})

test('unknown styles and empty selections are rejected; user styles are picked up', () => {
  assert.throws(() => formatCitations({ styleId: 'nope', items }), /Unknown citation style/)
  assert.throws(() => formatCitations({ styleId: 'nature', items: [] }), /No references/)
  const dir = tempDir()
  fs.copyFileSync(new URL('../styles/apa.csl', import.meta.url), path.join(dir, 'my-apa.csl'))
  assert.ok(listStyles(dir).some((s) => s.id === 'my-apa' && !s.builtin))
})
