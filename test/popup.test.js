// The citation pop-up drawn by Java (java/src/zotlet/QuickPick.java), with a real window on a
// virtual screen (Xvfb): the window by itself (java/test/PickWindowTest.java), and a citation
// requested by a word processor that is answered in the pop-up, without any browser.
// Skipped where there is no Xvfb. ZOTLET_SCREENSHOTS=<dir> saves pictures of the window.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { ROOT, buildOrSkip, javaServer, fakeDocument, tcpCommand } from './zotlet.js'
import { tempDir } from './helpers.js'

const hasXvfb = spawnSync('sh', ['-c', 'command -v Xvfb']).status === 0
const skip = buildOrSkip() || (hasXvfb ? false : 'no Xvfb here (the pop-up needs a screen)')
let xvfb, display

before(async () => {
  if (skip) return
  for (let n = 90 + (process.pid % 400); !display; n++) {
    const child = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
    const failed = await new Promise((resolve) => { child.once('exit', () => resolve(true)); setTimeout(() => resolve(false), 700) })
    if (!failed) { xvfb = child; display = `:${n}` }
    else if (n > 600) throw new Error('Xvfb could not be started')
  }
})
after(() => { if (xvfb) xvfb.kill() })

test('the pop-up window: search, add, remove, insert, cancel, style list', { skip }, () => {
  const shots = process.env.ZOTLET_SCREENSHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const r = spawnSync('java', ['-cp', path.join(ROOT, 'java/build/lib/zotlet.jar'), path.join(ROOT, 'java/test/PickWindowTest.java'), ...(shots ? [shots] : [])],
    { encoding: 'utf8', env: { ...process.env, DISPLAY: display }, timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^ok$/m)
})

test('a citation asked for by LibreOffice / GenOffice is picked in the pop-up, not in the browser', { skip }, async () => {
  const dir = path.join(tempDir(), '.zotlet')
  const server = await javaServer(dir, { env: { DISPLAY: display, ZOTLET_PICKER: 'window', ZOTLET_PICK_KEYS: 'type:cold stress;enter;enter' } })
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }
    const items = [{ type: 'article-journal', title: 'Cold stress in apple', author: [{ family: 'He', given: 'J' }], issued: { 'date-parts': [[2024]] } },
      { type: 'article-journal', title: 'Something else', author: [{ family: 'Ma', given: 'F' }], issued: { 'date-parts': [[2020]] } }]
    const res = await fetch(new URL('/api/import-csl', server.url), { method: 'POST', headers, body: JSON.stringify({ items }) })
    assert.equal(res.status, 200)
    const doc = fakeDocument()
    await tcpCommand(server, doc, 'addEditCitation')
    assert.equal(server.opened.length, 0, 'no browser picker was opened')
    assert.equal(doc.fields.length, 1, server.state())
    const code = JSON.parse(doc.fields[0].code.replace(/^ITEM CSL_CITATION /, ''))
    assert.deepEqual(code.citationItems.map((c) => c.itemData.title), ['Cold stress in apple'])
    assert.equal(doc.completed, 1)
  } finally {
    server.close()
  }
})

test('without a screen the browser picker is still there', { skip: buildOrSkip() }, async () => {
  const dir = path.join(tempDir(), '.zotlet')
  const server = await javaServer(dir, { env: { DISPLAY: '', ZOTLET_PICKER: 'window', JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS || ''} -Djava.awt.headless=true`.trim() } })
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }
    await fetch(new URL('/api/import-csl', server.url), { method: 'POST', headers, body: JSON.stringify({ items: [{ type: 'book', title: 'One book' }] }) })
    const doc = fakeDocument()
    await tcpCommand(server, doc, 'addEditCitation', () => null)
    assert.equal(doc.fields.length, 0)
  } finally {
    server.close()
  }
})
