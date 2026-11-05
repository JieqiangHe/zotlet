// End-to-end checks in a real browser. Skipped automatically when Playwright is not installed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { fixture, fakeFetch, tempDir, makePdf } from './helpers.js'

let playwright = null
try { playwright = createRequire(import.meta.url)('playwright') } catch { /* optional */ }
const SHOTS = process.env.ZOTLET_SCREENSHOTS // optional folder for screenshots
const skip = !playwright && 'Playwright is not installed'

const ELSEVIER = '10.1016/j.plaphy.2026.111729'
let server, browser, page, dir

// Serves Zotero's style index and one journal style; everything else goes to `next`.
const JOURNAL_STYLE = fs.readFileSync(new URL('./fixtures/dependent-style.csl', import.meta.url), 'utf8')
const styleNet = (next) => async (url, init) => {
  if (String(url) === 'https://www.zotero.org/styles-files/styles.json') {
    return Response.json([
      { title: 'Plant Physiology and Biochemistry', name: 'plant-physiology-and-biochemistry', dependent: 1, categories: { format: 'author-date', fields: ['botany'] }, updated: '2018-02-16' },
      { title: 'Nature', name: 'nature', dependent: 0, categories: { format: 'numeric', fields: ['science'] } },
    ])
  }
  if (String(url) === 'https://www.zotero.org/styles/plant-physiology-and-biochemistry') return new Response(JOURNAL_STYLE)
  if (String(url) === 'https://www.zotero.org/styles/elsevier-harvard') return new Response(fs.readFileSync(new URL('./fixtures/styles/elsevier-harvard.csl', import.meta.url), 'utf8'))
  return next(url, init)
}
const opened = []

before(async () => {
  if (!playwright) return
  dir = tempDir()
  const store = createStore({ dir })
  await store.addItems([
    { type: 'article-journal', title: 'CRISPR screens in <i>Zea mays</i> reveal new regulators', author: [{ family: 'Olsen', given: 'Kai' }, { family: 'Ng', given: 'Mei' }], 'container-title': 'Nature Plants', issued: { 'date-parts': [[2023, 5]] }, DOI: '10.1038/s41477-023-0001-1' },
    { type: 'book', title: 'Statistical Rethinking', author: [{ family: 'McElreath', given: 'Richard' }], publisher: 'CRC Press', issued: { 'date-parts': [[2020]] } },
  ])
  server = await startServer({
    port: 0, dir, store, quiet: true, openUrl: (url) => opened.push(url),
    fetchImpl: styleNet(fakeFetch({ dois: { [ELSEVIER]: fixture('elsevier-crossref.json') }, pmids: { 31452104: fixture('pubmed.json') } })),
  })
  browser = await playwright.chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, acceptDownloads: true })
  page = await context.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e))
  await page.goto(server.url)
  await page.waitForSelector('.rows .row')
})
after(async () => {
  await browser?.close()
  server?.close()
  server?.closeAllConnections()
  if (page) assert.deepEqual(page.errors.map(String), [])
})

const shot = async (name) => {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}
const rowTitles = () => page.$$eval('.rows .row .cell.title', (cells) => cells.map((c) => c.textContent))
const rowCount = (n) => page.waitForFunction((n) => document.querySelectorAll('.rows .row').length === n, n)

test('library loads with the top bar in the required order', { skip }, async () => {
  const order = await page.$$eval('.topbar .btn, .topbar .search', (nodes) => nodes.map((n) => n.id || n.className))
  assert.deepEqual(order, ['btn-new', 'search', 'btn-styles', 'btn-export', 'btn-theme'])
  assert.equal(await page.$('.brand'), null, 'no name or logo in the top bar')
  // New sits above the projects; search starts at the list panel's left edge.
  const box = (sel) => page.$eval(sel, (n) => n.getBoundingClientRect().toJSON())
  const [sidebar, panel, search, theme] = await Promise.all(['.sidebar', '.panel', '.search', '#btn-theme'].map(box))
  assert.ok(Math.abs(search.left - panel.left) <= 1, `search ${search.left} vs panel ${panel.left}`)
  assert.ok(Math.abs(theme.right - panel.right) <= 1, `theme ${theme.right} vs panel ${panel.right}`)
  assert.ok((await box('#btn-new')).right <= sidebar.right)
  assert.equal((await page.$$('.statusbar, #style-select, #btn-bib')).length, 0, 'removed for simplicity')
  assert.equal((await rowTitles()).length, 2)
  assert.equal(await page.textContent('#count-all'), '2')
  await shot('01-library')
})

test('DOI / PMID import from the New dialog', { skip }, async () => {
  await page.click('#btn-new')
  await page.fill('#import-text', `${ELSEVIER}\nPMID 31452104\nbogus`)
  await page.click('#import-submit')
  await page.waitForSelector('#import-results li.added')
  const statuses = await page.$$eval('#import-results li', (lis) => lis.map((li) => li.className))
  assert.deepEqual(statuses, ['added', 'added', 'failed'])
  await shot('02-import')
  await page.click('#ref-dialog .dialog-head [data-close]')
  await rowCount(4)
  assert.ok((await rowTitles()).some((t) => t.includes('Arabidopsis')))
})

test('project buttons: create, add references, rename, remove', { skip }, async () => {
  await page.click('#project-new')
  await page.fill('#name-input', 'Drought review')
  await page.click('#name-submit')
  await page.waitForSelector('#project-list .nav-item.active')
  assert.equal(await page.textContent('#view-title'), 'Drought review')
  assert.ok(await page.isVisible('#empty'))
  await shot('03-empty-project')

  await page.click('.nav-item[data-project=""]')
  await rowCount(4)
  await page.click('.rows .row >> nth=0')
  await page.click('.rows .row >> nth=1', { modifiers: ['Shift'] })
  assert.equal(await page.textContent('#selection-count'), '2 selected')
  await shot('04-selection')
  await page.click('#btn-add-to')
  await page.click('#add-to-menu button:has-text("Drought review")')
  await page.waitForSelector('#project-list .nav-item .count:text-is("2")')

  await page.click('#project-list .nav-item')
  await rowCount(2)

  await page.click('#project-rename')
  await page.fill('#name-input', 'Drought & heat review')
  await page.click('#name-submit')
  await page.waitForSelector('#project-list .nav-item:has-text("Drought & heat review")')

  await page.click('.rows .row >> nth=0')
  await page.click('#btn-remove-from')
  await rowCount(1)
  assert.equal(await page.textContent('#count-all'), '4')
  await shot('05-project')
})

test('export: one click downloads the current project as a zip with all formats', { skip }, async () => {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')])
  assert.equal(download.suggestedFilename(), 'Drought & heat review.zip')
  const zip = fs.readFileSync(await download.path())
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a zip file')
  const names = zip.toString('latin1')
  for (const ext of ['ris', 'json', 'bib']) assert.ok(names.includes(`Drought & heat review.${ext}`), ext)
  assert.match(await page.getAttribute('#btn-export', 'title'), /project “Drought & heat review”/)
})

test('deleting a project keeps its references in the library', { skip }, async () => {
  await page.click('#project-delete')
  await page.click('#confirm-ok')
  await page.waitForSelector('#projects-empty:not([hidden])')
  assert.equal(await page.textContent('#view-title'), 'All references')
  await rowCount(4)
  assert.ok(await page.isDisabled('#project-rename'))
})

test('double-click edits a reference and keeps its key', { skip }, async () => {
  await page.dblclick('.rows .row:has-text("Statistical Rethinking") .cell.title')
  await page.fill('#manual-form [name="title"]', 'Statistical Rethinking (2nd ed.)')
  await page.click('#manual-submit')
  await page.waitForSelector('.rows .row:has-text("2nd ed.")')
  const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
  assert.equal(lib.find((i) => i.id === 'mcelreath2020').title, 'Statistical Rethinking (2nd ed.)')
})

test('search filters the list and shows an empty state', { skip }, async () => {
  await page.fill('#search', 'zea')
  await rowCount(1)
  await page.fill('#search', 'no such thing')
  await page.waitForSelector('#empty:not([hidden])')
  await shot('07-no-match')
  await page.click('#empty button')
  await rowCount(4)
})

test('dark mode toggle persists across reloads', { skip }, async () => {
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const start = await theme()
  await page.click('#btn-theme')
  const flipped = await theme()
  assert.notEqual(flipped, start)
  await page.reload()
  await page.waitForSelector('.rows .row')
  assert.equal(await theme(), flipped)
  if (flipped !== 'dark') await page.click('#btn-theme')
  await shot('08-dark')
  await page.click('#btn-new')
  await page.click('[data-tab="manual"]')
  await shot('09-dark-manual')
  await page.keyboard.press('Escape')
})

// Regression: dialog bodies once collapsed to 0px in Safari, clipping the form and its buttons.
async function assertDialogLaidOut(selector) {
  const problems = await page.evaluate((selector) => {
    const dialog = document.querySelector(selector)
    const box = dialog.getBoundingClientRect()
    const out = []
    for (const body of dialog.querySelectorAll('.dialog-body')) {
      if (body.closest('[hidden]')) continue
      if (body.clientHeight < 40) out.push(`body height ${body.clientHeight}`)
    }
    for (const el of dialog.querySelectorAll('button, textarea, input, select')) {
      if (el.closest('[hidden]') || el.closest('details:not([open])')) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (el.closest('.dialog-body')?.scrollHeight > el.closest('.dialog-body')?.clientHeight) continue // scrollable: may be off-screen
      if (r.top < box.top - 1 || r.bottom > box.bottom + 1) out.push(`${el.tagName}#${el.id || el.name || el.textContent.trim()} outside dialog`)
    }
    return out
  }, selector)
  assert.deepEqual(problems, [], selector)
}

test('every dialog lays out its body and buttons inside the box', { skip }, async () => {
  for (const viewport of [{ width: 1280, height: 760 }, { width: 900, height: 420 }]) {
    await page.setViewportSize(viewport)
    await page.click('#btn-new')
    await assertDialogLaidOut('#ref-dialog')
    assert.ok(await page.isVisible('#import-submit'))
    await page.click('[data-tab="manual"]')
    await assertDialogLaidOut('#ref-dialog')
    await page.click('#ref-dialog .dialog-head [data-close]')

    await page.click('#btn-styles')
    await page.waitForSelector('#styles-dialog[open]')
    await assertDialogLaidOut('#styles-dialog')
    await page.click('#styles-dialog .dialog-foot .primary')

    await page.click('#project-new')
    await assertDialogLaidOut('#name-dialog')
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.click('#btn-new')
  await shot('11-import-dialog')
  await page.click('[data-tab="manual"]')
  await shot('12-manual-dialog')
  await page.keyboard.press('Escape')
})

test('narrow window: no horizontal overflow', { skip }, async () => {
  await page.setViewportSize({ width: 700, height: 600 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`)
  await shot('10-narrow')
  await page.setViewportSize({ width: 1280, height: 760 })
})

test('citation picker (opened by Word / GenOffice): search, select, insert; style picker', { skip }, async () => {
  const { items } = await createStore({ dir }).snapshot()
  const result = server.pick({ mode: 'cite', style: 'nature', askStyle: true, items, selected: [] })
  await new Promise((r) => setTimeout(r, 20))
  const picker = await page.context().newPage()
  picker.on('pageerror', (e) => page.errors.push(e))
  await picker.goto(opened.shift())
  await picker.waitForSelector('#pick-rows .row')
  assert.equal(await picker.$$eval('#pick-rows .row', (rows) => rows.length), items.length)
  await picker.fill('#pick-search', 'rethinking')
  await picker.waitForFunction(() => document.querySelectorAll('#pick-rows .row').length === 1)
  const picked = await picker.getAttribute('#pick-rows .row', 'data-id')
  await picker.click('#pick-rows .row')
  assert.equal(await picker.isDisabled('#pick-ok'), false)
  await picker.fill('#pick-search', '')
  await picker.selectOption('#pick-style', 'cell')
  if (SHOTS) await picker.screenshot({ path: path.join(SHOTS, '20-picker.png') })
  await picker.setViewportSize({ width: 700, height: 600 })
  assert.ok(await picker.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow')
  if (SHOTS) await picker.screenshot({ path: path.join(SHOTS, '21-picker-narrow.png') })
  await picker.keyboard.press('Enter')
  const chosen = await result
  assert.equal(chosen.style, 'cell')
  assert.deepEqual(chosen.ids, [picked])
  await picker.waitForSelector('#pick-message:not([hidden])')
  await picker.close().catch(() => {})

  const styleResult = server.pick({ mode: 'style', style: 'nature', bookmarks: false, bookmarksLocked: false })
  await new Promise((r) => setTimeout(r, 20))
  const stylePage = await page.context().newPage()
  await stylePage.goto(opened.shift())
  await stylePage.waitForSelector('#pick-rows .row.selected')
  await stylePage.click('#pick-rows .row:nth-child(2)')
  if (SHOTS) await stylePage.screenshot({ path: path.join(SHOTS, '22-style-picker.png') })
  await stylePage.check('#pick-bookmarks input')
  await stylePage.click('#pick-ok')
  assert.deepEqual(await styleResult, { style: 'science', bookmarks: true })
  await stylePage.close().catch(() => {})

  // Closing the tab without answering cancels the request.
  const closed = server.pick({ mode: 'cite', style: 'nature', items, selected: [] })
  await new Promise((r) => setTimeout(r, 20))
  const gone = await page.context().newPage()
  await gone.goto(opened.shift())
  await gone.waitForSelector('#pick-rows .row')
  await gone.close({ runBeforeUnload: true })
  assert.equal(await closed, null)
})

test('styles: search the repository, install a journal style, remove it', { skip }, async () => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.click('#btn-styles')
  await page.waitForSelector('#styles-dialog[open] #style-results li')
  await page.fill('#style-query', 'plant physiology')
  await page.waitForFunction(() => document.querySelectorAll('#style-results li').length === 1)
  await assertDialogLaidOut('#styles-dialog')
  await shot('30-styles-search')
  await page.click('#style-results li button:has-text("Install")')
  await page.waitForSelector('#style-results li .badge')
  await page.click('#styles-tabs [data-tab="installed"]')
  const row = '#style-installed li:has-text("Plant Physiology and Biochemistry")'
  assert.match(await page.textContent(row), /uses Elsevier Harvard/)
  await assertDialogLaidOut('#styles-dialog')
  await shot('31-styles-installed')
  await page.click(`${row} button:has-text("Remove")`)
  await page.waitForFunction(() => !/Plant Physiology and Biochemistry/.test(document.querySelector('#style-installed').textContent))
  await page.keyboard.press('Escape')
})

async function dropPdf(selector, name, bytes) {
  const dataTransfer = await page.evaluateHandle(({ name, data }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type: 'application/pdf' }))
    return dt
  }, { name, data: bytes.toString('base64') })
  await page.dispatchEvent(selector, 'dragenter', { dataTransfer })
  await page.dispatchEvent(selector, 'dragover', { dataTransfer })
  return dataTransfer
}

test('drop PDFs: the DOI is read and the reference imported; type a DOI when none is found', { skip }, async () => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.click('.nav-item[data-project=""]')
  const before = (await createStore({ dir }).snapshot()).items.length
  const article = makePdf({ pages: ['[(Plant Physiology and Biochemistry)-300(https://doi.org/10.1016/j.plaphy.2026.111729)]TJ'] })
  const dt = await dropPdf('.table', 'elsevier.pdf', article)
  assert.ok(await page.isVisible('#drop-hint'))
  await shot('40-pdf-drop-hint')
  await page.dispatchEvent('.table', 'drop', { dataTransfer: dt })
  await page.waitForSelector('#pdf-results li.warn')
  assert.match(await page.textContent('#pdf-results li'), /Already in your library: .*10\.1016\/j\.plaphy\.2026\.111729/)
  assert.ok(await page.isHidden('#drop-hint'))

  // No DOI in the file: type it in the result row.
  const dt2 = await dropPdf('.table', 'notes.pdf', makePdf({ pages: ['(Lab notes without an identifier)Tj'] }))
  await page.dispatchEvent('.table', 'drop', { dataTransfer: dt2 })
  await page.waitForSelector('#pdf-results li.bad')
  assert.match(await page.textContent('#pdf-results li.bad'), /No DOI found/)
  await assertDialogLaidOut('#pdf-dialog')
  await shot('41-pdf-no-doi')
  await page.fill('#pdf-results li.bad input', '10.1016/j.plaphy.2026.111729')
  await page.click('#pdf-results li.bad button')
  await page.waitForSelector('#pdf-results li.warn')
  await page.click('#pdf-dialog .dialog-foot .primary')
  assert.equal((await createStore({ dir }).snapshot()).items.length, before)
})

test('drop a CSL JSON file (e.g. exported from Zotero) to import its references', { skip }, async () => {
  const before = (await createStore({ dir }).snapshot()).items.length
  const json = Buffer.from(JSON.stringify([
    { id: 'http://zotero.org/users/1/items/AAA', type: 'article-journal', title: 'From Zotero', author: [{ family: 'Curie', given: 'Marie' }], issued: { 'date-parts': [['1903']] }, DOI: '10.5555/zotero-1' },
    { id: 'x', type: 'book', title: 'Statistical Rethinking (2nd ed.)' },
    { note: 'no title' },
  ]))
  const dataTransfer = await page.evaluateHandle((data) => {
    const dt = new DataTransfer()
    dt.items.add(new File([atob(data)], 'Exported Items.json', { type: 'application/json' }))
    return dt
  }, json.toString('base64'))
  await page.dispatchEvent('.table', 'dragenter', { dataTransfer })
  await page.dispatchEvent('.table', 'drop', { dataTransfer })
  await page.waitForSelector('#pdf-results li.ok')
  assert.match(await page.textContent('#pdf-results li'), /Imported 2 references · 1 skipped/)
  await page.click('#pdf-dialog .dialog-foot .primary')
  assert.equal((await createStore({ dir }).snapshot()).items.length, before + 2)
  await page.waitForSelector('.rows .row:has-text("From Zotero")')
})

test('columns sort, including by import time (Added), and the choice is remembered', { skip }, async () => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.click('.nav-item[data-project=""]')
  await page.waitForSelector('.rows .row')
  const keys = () => page.$$eval('.rows .row', (rows) => rows.map((r) => r.dataset.id))
  const { items } = await createStore({ dir }).snapshot()
  const importOrder = items.map((i) => i.id)
  assert.deepEqual(await keys(), [...importOrder].reverse(), 'default: newest import first')

  await page.click('.cell.sort[data-sort="added"]')
  assert.deepEqual(await keys(), [...importOrder].reverse(), 'Added: newest first')
  assert.equal(await page.textContent('.cell.sort[data-sort="added"] .arrow'), '▼')
  await page.click('.cell.sort[data-sort="added"]')
  assert.deepEqual(await keys(), importOrder, 'Added again: oldest first')
  assert.match(await page.textContent(`.rows .row[data-id="${importOrder.at(-1)}"] .cell.added`), /^\d{4}-\d{2}-\d{2}$/)
  await shot('50-sort-added')

  await page.click('.cell.sort[data-sort="title"]')
  const titles = await page.$$eval('.rows .row .cell.title', (cells) => cells.map((c) => c.textContent.toLowerCase()))
  assert.deepEqual(titles, [...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  await page.click('.cell.sort[data-sort="year"]')
  const years = await page.$$eval('.rows .row .cell.year', (cells) => cells.map((c) => Number(c.textContent) || 0).filter(Boolean))
  assert.deepEqual(years, [...years].sort((a, b) => b - a), 'year: newest first')

  await page.reload()
  await page.waitForSelector('.rows .row')
  assert.equal(await page.textContent('.cell.sort[data-sort="year"] .arrow'), '▼', 'sort survives a reload')
  await page.click('.cell.sort[data-sort="year"]')
  await page.click('.cell.sort[data-sort="year"]')
  assert.equal(await page.textContent('.cell.sort[data-sort="year"] .arrow'), '', 'third click: back to default')
})
