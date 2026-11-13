// Chinese literature without a plugin: references exported from CNKI (知网), Wanfang or VIP as
// EndNote / RefWorks / NoteExpress files, RIS and BibTeX, and pasted GB/T 7714 reference text
// (java/src/zotlet/Refs.java); Chinese names, the language field, citation keys in pinyin; and
// the built-in bilingual GB/T 7714 styles (等 for Chinese references, et al. for English ones).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { buildOrSkip, javaServer } from './zotlet.js'
import { tempDir } from './helpers.js'

const skip = buildOrSkip()
const sample = (name) => fs.readFileSync(new URL(`./fixtures/cnki/${name}`, import.meta.url), 'utf8')
let server

const post = async (route, body) => {
  const res = await fetch(new URL(`/api/${route}`, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }, body: JSON.stringify(body) })
  return { status: res.status, ...(await res.json()) }
}
const library = async () => (await (await fetch(new URL('/api/state', server.url), { headers: { 'X-Zotlet-Token': server.token } })).json()).items
const byId = async (id) => (await library()).find((i) => i.id === id)

before(async () => { if (!skip) server = await javaServer(path.join(tempDir(), '.zotlet')) })
after(() => server?.close())

test('pasted GB/T 7714 reference text (as CNKI shows it) is imported', { skip }, async () => {
  const r = await post('import', { text: sample('gbt.txt') })
  assert.deepEqual(r.results.map((x) => [x.status, x.id]), [['added', 'zhang2020'], ['added', 'liu2019'], ['added', 'he2023'], ['added', 'shu1999'], ['added', 'chen2015']])
  assert.deepEqual(await byId('zhang2020'), {
    id: 'zhang2020', type: 'article-journal', title: '苹果抗旱性的分子机制研究进展', 'container-title': '园艺学报', volume: '47', issue: '3', page: '12-18',
    DOI: '10.16420/j.issn.0513-353x.2019-0001',
    author: [{ family: '张', given: '三' }, { family: '李', given: '四' }, { family: '欧阳', given: '小明' }],
    issued: { 'date-parts': [[2020]] }, language: 'zh-CN',
  })
  const thesis = await byId('liu2019')
  assert.deepEqual([thesis.type, thesis.publisher, thesis.language], ['thesis', '西北农林科技大学', 'zh-CN'])
  const english = await byId('he2023')
  assert.deepEqual(english.author[0], { family: 'He', given: 'J' })
  assert.deepEqual([english['container-title'], english.volume, english.page, english.language], ['Horticulture Research', '10', 'uhad099', undefined])
  const book = await byId('shu1999')
  assert.deepEqual([book.type, book.publisher, book['publisher-place']], ['book', '中国农业出版社', '北京'])
  const news = await byId('chen2015')
  assert.deepEqual([news.type, news['container-title'], news.issued['date-parts'][0], news.page], ['article-newspaper', '农民日报', [2015, 3, 12], '006'])
})

test('CNKI export files: EndNote, RefWorks, NoteExpress; and RIS, BibTeX', { skip }, async () => {
  // The EndNote file repeats two references that are already there (no DOI in the file: matched by title and year).
  let r = await post('import-refs', { text: sample('endnote.txt'), name: 'CNKI-1.txt' })
  assert.deepEqual([r.format, r.added, r.duplicates, r.ids], ['endnote', 0, 2, ['zhang2020', 'liu2019']])

  r = await post('import-refs', { text: sample('refworks.txt'), name: 'CNKI-2.txt' })
  assert.deepEqual([r.format, r.added, r.ids], ['refworks', 1, ['wang2021']])
  const item = await byId('wang2021')
  assert.deepEqual(item.author, [{ family: '王', given: '小明' }, { family: '赵', given: '四' }, { family: '孙', given: '五' }, { family: '周', given: '六' }])
  assert.deepEqual([item['container-title'], item.volume, item.issue, item.page, item.ISSN, item.language, item.URL], ['果树学报', '38', '5', '701-710', '1009-9980', 'zh-CN', undefined])

  r = await post('import-refs', { text: sample('noteexpress.net'), name: 'CNKI-3.net' })
  assert.deepEqual([r.format, r.added, r.ids], ['noteexpress', 1, ['li2018']])
  assert.deepEqual((await byId('li2018')).page, '2345-2356')

  r = await post('import-refs', { text: sample('sample.ris') })
  assert.deepEqual([r.format, r.added, r.ids], ['ris', 1, ['zhou2017']])
  assert.deepEqual((await byId('zhou2017')).author, [{ family: '周', given: '六' }, { family: 'Smith', given: 'John' }])

  r = await post('import-refs', { text: sample('sample.bib') })
  assert.deepEqual([r.format, r.added, r.ids], ['bibtex', 1, ['zhang2022']])
  const bib = await byId('zhang2022')
  assert.deepEqual([bib.title, bib.page, bib.DOI], ['苹果MdDREB2A基因的克隆与表达分析', '233-245', '10.16420/j.issn.0513-353x.2021-0456'])
  assert.deepEqual(bib.author[2], { family: 'Smith', given: 'John A.' })

  // The same file again: nothing new. Text that is no reference list: an error that says what is expected.
  r = await post('import-refs', { text: sample('refworks.txt') })
  assert.deepEqual([r.added, r.duplicates], [0, 1])
  r = await post('import-refs', { text: 'just some notes' })
  assert.equal(r.status, 400)
  assert.match(r.error, /EndNote, RefWorks, NoteExpress, RIS or BibTeX/)
})

test('a thesis exported from CNKI keeps its degree and school', { skip }, async () => {
  const text = sample('endnote.txt').replace('苹果砧木抗寒性评价及其生理机制', '苹果砧木抗寒性的遗传分析')
  const r = await post('import-refs', { text })
  assert.deepEqual([r.added, r.duplicates], [1, 1])
  const thesis = await byId(r.ids[1])
  assert.deepEqual([thesis.id, thesis.type, thesis.genre, thesis.publisher], ['liu2019a', 'thesis', '博士学位论文', '西北农林科技大学'])
})

test('GB/T 7714 is built in: 等 for Chinese references, et al. for English ones', { skip }, async () => {
  const { styles } = await (await fetch(new URL('/api/state', server.url), { headers: { 'X-Zotlet-Token': server.token } })).json()
  assert.deepEqual(styles.filter((s) => s.builtin).map((s) => s.id), ['nature', 'science', 'cell', 'gb-t-7714-2015-numeric-bilingual', 'gb-t-7714-2015-author-date-bilingual'])
  let r = await post('cite', { ids: ['zhang2020', 'wang2021', 'he2023', 'liu2019'], style: 'gb-t-7714-2015-numeric-bilingual' })
  assert.deepEqual(r.bibliography.text.split('\n'), [
    '[1] 张三，李四，欧阳小明. 苹果抗旱性的分子机制研究进展[J/OL]. 园艺学报，2020，47（3）：12-18. DOI:10.16420/j.issn.0513-353x.2019-0001.',
    '[2] 王小明，赵四，孙五，等. 外源褪黑素对干旱胁迫下苹果幼苗生长的影响[J]. 果树学报，2021，38（5）：701-710.',
    '[3] HE J，MA F，LI C. 4-methylumbelliferone enhances drought tolerance of apple[J]. Horticulture Research，2023，10：uhad099.',
    '[4] 刘洋. 苹果砧木抗寒性评价及其生理机制[D]. 西北农林科技大学，2019.',
  ])
  r = await post('cite', { ids: ['wang2021', 'he2023'], style: 'gb-t-7714-2015-author-date-bilingual' })
  assert.equal(r.citation.text, '（He et al.，2023；王小明 等，2021）')
  // Other styles print Chinese names whole and leave the title's case alone.
  r = await post('cite', { ids: ['wang2021'], style: 'nature' })
  assert.equal(r.bibliography.text, '1. 王小明, 赵四, 孙五 & 周六. 外源褪黑素对干旱胁迫下苹果幼苗生长的影响. 果树学报 38, 701–710 (2021).')
})
