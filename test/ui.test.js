// End-to-end checks in a real browser. Skipped automatically when Playwright is not installed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { fixture, fakeFetch, tempDir, makePdf } from './helpers.js'
import { locatePdf } from '../src/pdf.js'

let playwright = null
try { playwright = createRequire(import.meta.url)('playwright') } catch { /* optional */ }
const SHOTS = process.env.ZOTLET_SCREENSHOTS // optional folder for screenshots
const skip = !playwright && 'Playwright is not installed'

const ELSEVIER = '10.1016/j.plaphy.2026.111729'
let server, browser, page, dir, pdfDir
const openedFiles = []

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
  return next(url, init)
}
const opened = []

before(async () => {
  if (!playwright) return
  dir = tempDir()
  pdfDir = path.join(dir, 'Downloads')
  fs.mkdirSync(pdfDir)
  const store = createStore({ dir })
  await store.addItems([
    { type: 'article-journal', title: 'CRISPR screens in <i>Zea mays</i> reveal new regulators', author: [{ family: 'Olsen', given: 'Kai' }, { family: 'Ng', given: 'Mei' }], 'container-title': 'Nature Plants', issued: { 'date-parts': [[2023, 5]] }, DOI: '10.1038/s41477-023-0001-1' },
    { type: 'book', title: 'Statistical Rethinking', author: [{ family: 'McElreath', given: 'Richard' }], publisher: 'CRC Press', issued: { 'date-parts': [[2020]] } },
  ])
  server = await startServer({
    port: 0, dir, store, quiet: true, openUrl: (url) => opened.push(url),
    locate: (file, options) => locatePdf(file, { ...options, roots: [pdfDir], useSpotlight: false }),
    openPath: async (file) => { openedFiles.push(file) },
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
  const order = await page.$$eval('.topbar > *', (nodes) => nodes.map((n) => n.id || n.className))
  assert.deepEqual(order, ['brand', 'btn-new', 'search', 'style-select', 'btn-bib', 'dropdown', 'grow', 'btn-theme'])
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

test('bibliography and all export formats for the current project', { skip }, async () => {
  await page.selectOption('#style-select', 'apa')
  await page.click('#btn-bib')
  await page.waitForSelector('#bib-output .csl-entry')
  assert.equal(await page.$$eval('#bib-output .csl-entry', (e) => e.length), 1)
  assert.match(await page.textContent('#bib-scope'), /Drought & heat review/)
  await shot('06-bibliography')
  await page.selectOption('#bib-style', 'nature')
  await page.waitForFunction(() => /^1\./.test(document.querySelector('#bib-output .csl-left-margin')?.textContent || ''))
  await page.click('#bib-dialog .dialog-foot .primary')

  for (const [format, ext] of [['json', 'json'], ['bibtex', 'bib'], ['ris', 'ris']]) {
    await page.click('#btn-export')
    const [download] = await Promise.all([page.waitForEvent('download'), page.click(`#export-menu [data-format="${format}"]`)])
    assert.equal(download.suggestedFilename(), `Drought & heat review.${ext}`)
    assert.ok(fs.readFileSync(await download.path(), 'utf8').length > 20)
  }
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

    await page.click('#btn-bib')
    await page.waitForSelector('#bib-output .csl-entry')
    await assertDialogLaidOut('#bib-dialog')
    await page.click('#bib-dialog .dialog-foot .primary')

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
  const result = server.pick({ mode: 'cite', style: 'nature', items, selected: [] })
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
  await picker.selectOption('#pick-style', 'apa')
  if (SHOTS) await picker.screenshot({ path: path.join(SHOTS, '20-picker.png') })
  await picker.setViewportSize({ width: 700, height: 600 })
  assert.ok(await picker.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow')
  if (SHOTS) await picker.screenshot({ path: path.join(SHOTS, '21-picker-narrow.png') })
  await picker.keyboard.press('Enter')
  const chosen = await result
  assert.equal(chosen.style, 'apa')
  assert.deepEqual(chosen.ids, [picked])
  await picker.waitForSelector('#pick-message:not([hidden])')
  await picker.close().catch(() => {})

  const styleResult = server.pick({ mode: 'style', style: 'nature' })
  await new Promise((r) => setTimeout(r, 20))
  const stylePage = await page.context().newPage()
  await stylePage.goto(opened.shift())
  await stylePage.waitForSelector('#pick-rows .row.selected')
  await stylePage.click('#pick-rows .row:nth-child(2)')
  if (SHOTS) await stylePage.screenshot({ path: path.join(SHOTS, '22-style-picker.png') })
  await stylePage.click('#pick-ok')
  assert.equal((await styleResult).style, 'science')
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

test('get more styles: search the repository, install a journal style, use and remove it', { skip }, async () => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.selectOption('#style-select', '__more__')
  await page.waitForSelector('#styles-dialog[open] #style-results li')
  await page.fill('#style-query', 'plant physiology')
  await page.waitForFunction(() => document.querySelectorAll('#style-results li').length === 1)
  await assertDialogLaidOut('#styles-dialog')
  await shot('30-styles-search')
  await page.click('#style-results li button:has-text("Install")')
  await page.waitForSelector('#style-results li .badge')
  assert.equal(await page.inputValue('#style-select'), 'plant-physiology-and-biochemistry')
  await page.click('#styles-tabs [data-tab="installed"]')
  await page.waitForSelector('#style-installed li.current')
  assert.match(await page.textContent('#style-installed li.current'), /uses Elsevier Harvard/)
  await assertDialogLaidOut('#styles-dialog')
  await shot('31-styles-installed')
  await page.click('#styles-dialog .dialog-foot .primary')

  await page.click('#btn-bib')
  await page.waitForSelector('#bib-output .csl-entry')
  assert.equal(await page.inputValue('#bib-style'), 'plant-physiology-and-biochemistry')
  await page.click('#bib-dialog .dialog-foot .primary')

  await page.selectOption('#style-select', '__more__')
  await page.click('#styles-tabs [data-tab="installed"]')
  await page.click('#style-installed li.current button:has-text("Remove")')
  await page.waitForFunction(() => !document.querySelector('#style-select option[value="plant-physiology-and-biochemistry"]'))
  await page.keyboard.press('Escape')
})

async function dropPdf(selector, name, bytes) {
  fs.writeFileSync(path.join(pdfDir, name), bytes)
  const dataTransfer = await page.evaluateHandle(({ name, data }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type: 'application/pdf' }))
    return dt
  }, { name, data: bytes.toString('base64') })
  await page.dispatchEvent(selector, 'dragenter', { dataTransfer })
  await page.dispatchEvent(selector, 'dragover', { dataTransfer })
  return dataTransfer
}

test('drop PDFs: DOI read from the file, path linked, double-click opens it', { skip }, async () => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.click('.nav-item[data-project=""]')
  const article = makePdf({ pages: ['[(Plant Physiology and Biochemistry)-300(https://doi.org/10.1016/j.plaphy.2026.111729)]TJ'] })
  const dt = await dropPdf('.table', 'elsevier.pdf', article)
  assert.ok(await page.isVisible('#drop-hint'))
  await shot('40-pdf-drop-hint')
  await page.dispatchEvent('.table', 'drop', { dataTransfer: dt })
  await page.waitForSelector('#pdf-results li.ok')
  const text = await page.textContent('#pdf-results li')
  assert.match(text, /10\.1016\/j\.plaphy\.2026\.111729/)
  assert.match(text, /linked to .*elsevier\.pdf/)

  // A PDF without a DOI: type one in.
  const notes = makePdf({ pages: ['(Lab notes without an identifier)Tj'] })
  const dt2 = await dropPdf('.table', 'notes.pdf', notes)
  await page.dispatchEvent('.table', 'drop', { dataTransfer: dt2 })
  await page.waitForSelector('#pdf-results li.bad')
  assert.match(await page.textContent('#pdf-results li.bad'), /No DOI found/)
  await assertDialogLaidOut('#pdf-dialog')
  await shot('41-pdf-no-doi')
  await page.click('#pdf-dialog .dialog-foot .primary')

  const row = '.rows .row:has-text("Arabidopsis")'
  await page.waitForSelector(`${row} .pdf-badge`)
  await shot('42-pdf-badge')
  await page.dblclick(`${row} .cell.year`)
  for (let k = 0; !openedFiles.length && k < 100; k++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(openedFiles.at(-1), path.join(pdfDir, 'elsevier.pdf'))

  // Dropping onto a row attaches the file to that reference.
  const book = '.rows .row:has-text("Statistical Rethinking")'
  const dt3 = await dropPdf(book, 'rethinking.pdf', makePdf({ pages: ['(Statistical Rethinking)Tj'] }))
  await page.dispatchEvent(book, 'drop', { dataTransfer: dt3 })
  await page.waitForSelector('#pdf-results li.ok')
  assert.match(await page.textContent('#pdf-results li'), /PDF attached to mcelreath2020/)
  await page.click('#pdf-dialog .dialog-foot .primary')
  await page.waitForSelector(`${book} .pdf-badge`)

  // The edit dialog shows the path and can unlink it.
  await page.click(`${book} .cell.year`)
  await page.click('#btn-edit')
  assert.match(await page.textContent('#manual-pdf'), /rethinking\.pdf/)
  await shot('43-edit-pdf')
  await page.click('#manual-pdf button:has-text("Unlink")')
  await page.waitForFunction(() => /None/.test(document.querySelector('#manual-pdf').textContent))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.rows .row[data-id="mcelreath2020"] .pdf-badge'))
})
