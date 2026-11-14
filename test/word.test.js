// Microsoft Word without Zotero: Word's Zotero tab reaches zotlet (macOS: HTTP macWordCommand;
// Windows: the helper's ZoteroMessageWindow), zotlet runs the citation session and the helper edits
// the document. WordMac + word-mac.applescript and word-win.ps1 need Word; here
// test/fake-word.mjs stands in for them with the same protocol, so everything else is real.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempDir } from './helpers.js'
import { ROOT, buildOrSkip, javaServer, answerPicker } from './zotlet.js'

const skip = buildOrSkip()
const FAKE = path.join(ROOT, 'test', 'fake-word.mjs')
const ITEMS = [
  { id: 'lovelace2020', type: 'article-journal', title: 'Second paper', 'container-title': 'Nature', author: [{ family: 'Lovelace', given: 'Ada' }], issued: { 'date-parts': [[2020]] } },
  { id: 'hopper2019', type: 'article-journal', title: 'A <i>compiler</i> paper', 'container-title': 'Science', author: [{ family: 'Hopper', given: 'Grace' }], issued: { 'date-parts': [[2019]] } },
]
const servers = []
after(() => { for (const s of servers) s.close() })

async function start(mode) {
  const dir = path.join(tempDir(), '.zotlet')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(ITEMS))
  const docFile = path.join(path.dirname(dir), 'word-document.json')
  const server = await javaServer(dir, { env: { ZOTLET_WORD_MODE: mode, ZOTLET_WORD_HELPER: `${process.execPath} ${FAKE} ${docFile}` } })
  servers.push(server)
  const doc = () => JSON.parse(fs.readFileSync(docFile, 'utf8'))
  return { server, doc, docFile }
}

const until = async (check, what) => {
  for (let k = 0; k < 1000; k++) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error(`timed out waiting for ${what}`)
}

/** A button in Word for Mac: the template's curl call, then (if asked) the picker answer. */
async function macButton({ server }, command, choose) {
  const res = await fetch(`http://127.0.0.1:${server.http}/integration/macWordCommand?agent=MacWord16&command=${command}&document=/Applications/Microsoft%20Word.app/&templateVersion=2`)
  assert.equal(res.status, 200)
  if (choose) await answerPicker(server, choose)
}

test('Word for Mac: insert citations and a bibliography, refresh, unlink — through the Zotero template call', { skip }, async () => {
  const w = await start('mac')
  const completed = (n) => until(() => fs.existsSync(w.docFile) && w.doc().completed >= n, `${n} commands`)
  await macButton(w, 'addEditCitation', () => ({ ids: ['lovelace2020', 'hopper2019'], style: 'nature' }))
  await completed(1)
  let d = w.doc()
  assert.equal(d.fields.length, 1)
  assert.match(d.fields[0].code, /^ITEM CSL_CITATION \{/)
  assert.ok(d.fields[0].rich, 'citations are inserted as RTF')
  assert.match(d.fields[0].text, /^\{\\rtf /)
  assert.match(d.props.ZOTERO_PREF_1, /<data data-version="3"/)
  assert.match(Object.values(d.props).join(''), /<pref name="fieldType" value="Field"\/>/, 'Word documents use Word fields, as Zotero does')
  assert.equal(d.trackRevisions, true, 'Track Changes restored after the command')
  assert.equal(d.inits[0], '', 'macOS: the active document')

  await macButton(w, 'addBibliography')
  await completed(2)
  d = w.doc()
  const bib = d.fields.find((f) => /^BIBL/.test(f.code))
  assert.ok(bib, 'bibliography field')
  assert.match(bib.text, /Lovelace/)
  assert.ok(d.bibliographyStyle, 'the Bibliography paragraph style is set')

  // Edit the citation in place (cursor inside it); then refresh; then unlink everything.
  d.cursor = d.fields[0].id
  fs.writeFileSync(`${w.docFile}.tmp`, JSON.stringify(d)); fs.renameSync(`${w.docFile}.tmp`, w.docFile)
  await macButton(w, 'editCitation', () => ({ ids: ['hopper2019'] }))
  await completed(3)
  assert.equal(w.doc().fields.length, 2, 'edited, not added')
  await macButton(w, 'refresh')
  await completed(4)
  await macButton(w, 'addNote')
  await completed(5)
  assert.match(w.doc().alerts.at(-1), /does not support "addNote"/)
  await macButton(w, 'removeCodes')
  await completed(6)
  assert.ok(w.doc().fields.every((f) => f.code === null), 'all fields unlinked')
})

test('Word for Mac refused by macOS: the user is told, also what to do when zotlet runs inside TBtools', { skip }, async () => {
  const refused = `${process.execPath} ${path.join(ROOT, 'test/fake-word-refused.mjs')}`
  for (const [embedded, expected] of [['', /not allowed to control Microsoft Word \| .*Automation/], ['1', /from inside TBtools \| .*start-java\.command/]]) {
    const dir = path.join(tempDir(), '.zotlet')
    const server = await javaServer(dir, { env: { ZOTLET_WORD_MODE: 'mac', ZOTLET_WORD_HELPER: refused, ZOTLET_TEST_EMBEDDED: embedded } })
    servers.push(server)
    await macButton({ server }, 'addEditCitation')
    await until(() => server.alerts.length, 'the alert')
    assert.match(server.alerts[0], expected)
    assert.match(fs.readFileSync(path.join(dir, 'word.log'), 'utf8'), /addEditCitation failed: macOS did not allow/)
  }
})

test('Mac native route: plain osascript, frozen document/selection, citations, bibliography, cancel, unlink', { skip }, async () => {
  const home = tempDir(), dir = path.join(home, '.zotlet'), docFile = path.join(home, 'native-word.json')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(ITEMS))
  const server = await javaServer(dir, { env: { ZOTLET_WORD_MODE: 'mac', ZOTLET_WORD_HELPER: '',
    ZOTLET_WORD_OSASCRIPT: path.join(ROOT, 'test/fake-osascript.mjs'), ZOTLET_FAKE_WORD_DOCUMENT: docFile } })
  servers.push(server)
  const doc = () => JSON.parse(fs.readFileSync(docFile, 'utf8'))
  const completed = (n) => until(() => fs.existsSync(docFile) && doc().completed >= n, `${n} native commands`)
  await macButton({ server }, 'addEditCitation', () => {
    const d = doc()
    d.activeName = 'Another.docx'; d.start = 800; d.end = 900
    fs.writeFileSync(docFile, JSON.stringify(d))
    return { ids: ['lovelace2020', 'hopper2019'], style: 'nature' }
  })
  await completed(1)
  let d = doc()
  assert.equal(d.fields.length, 1)
  assert.match(d.fields[0].code, /^ITEM CSL_CITATION /)
  assert.equal(d.fields[0].pos, 12, 'the position before the picker, even after switching documents')
  assert.equal(d.fields[0].insertedIn, d.name)
  assert.match(d.fields[0].text, /^\{\\rtf /)
  assert.ok(d.track && d.showCodes && d.revisions && !d.formats, 'all original revision/view settings restored')
  assert.ok(d.calls.some((c) => c.handler === 'zStoryFields'), 'real WordMac field enumeration executed')
  await macButton({ server }, 'addBibliography')
  await completed(2)
  d = doc()
  const bib = d.fields.find((f) => f.code.startsWith('BIBL'))
  assert.ok(bib.bibliography)
  assert.match(bib.text, /Lovelace/)
  assert.ok(d.bibliographyStyle)
  await macButton({ server }, 'addEditCitation', () => null)
  await completed(3)
  assert.equal(doc().fields.length, 2, 'cancel adds nothing')
  await macButton({ server }, 'removeCodes')
  await completed(4)
  assert.ok(doc().fields.every((f) => f.code === null), 'both fields unlinked after the first changed the ordinals')
  assert.match(fs.readFileSync(path.join(dir, 'word.log'), 'utf8'), /init Word document \(AppleScript\)/)
})

test('Mac native osascript startup failure is visible and logged with its exit code', { skip }, async () => {
  const dir = path.join(tempDir(), '.zotlet')
  const server = await javaServer(dir, { env: { ZOTLET_WORD_MODE: 'mac', ZOTLET_WORD_HELPER: '',
    ZOTLET_WORD_OSASCRIPT: path.join(ROOT, 'test/fake-osascript.mjs'), ZOTLET_FAKE_OSA_EXIT: '139' } })
  servers.push(server)
  await macButton({ server }, 'addEditCitation')
  await until(() => server.alerts.length, 'native failure alert')
  assert.match(server.alerts[0], /osascript exited 139/)
  assert.match(fs.readFileSync(path.join(dir, 'word.log'), 'utf8'), /zInit failed: osascript exited 139/)
})

test('Mac AppleScript error alert keeps -1700 readable while word.log retains clipboard image diagnostics', { skip }, async () => {
  const dir = path.join(tempDir(), '.zotlet')
  const diagnostic = '*** Error creating a JP2 color space: falling back to sRGB\n'
    + '13903:13941: execution error: Can’t make document "Document1" of application "Microsoft Word" into the expected type. (-1700)\n'
  const server = await javaServer(dir, { env: { ZOTLET_WORD_MODE: 'mac', ZOTLET_WORD_HELPER: '',
    ZOTLET_WORD_OSASCRIPT: path.join(ROOT, 'test/fake-osascript.mjs'), ZOTLET_FAKE_OSA_STDERR: diagnostic } })
  servers.push(server)
  await macButton({ server }, 'addEditCitation')
  await until(() => server.alerts.length, 'AppleScript type error alert')
  assert.match(server.alerts[0], /expected type\. \(-1700\)/)
  assert.match(server.alerts[0], /AppleScript line \d+/)
  assert.doesNotMatch(server.alerts[0], /JP2|sRGB/)
  assert.match(fs.readFileSync(path.join(dir, 'word.log'), 'utf8'), /JP2[\s\S]*expected type\. \(-1700\)/)
})

test('Word for Windows: commands from the ZoteroMessageWindow run in the same way', { skip }, async () => {
  const w = await start('windows')
  const press = (command) => fs.appendFileSync(`${w.docFile}.trigger`, command + '\n')
  press('addEditCitation')
  await answerPicker(w.server, () => ({ ids: ['hopper2019'], style: 'cell' }))
  await until(() => fs.existsSync(w.docFile) && w.doc().completed >= 1, 'the citation')
  let d = w.doc()
  assert.equal(d.fields.length, 1)
  assert.equal(d.inits[0], 'C:\\Users\\me\\Paper.docx', 'Windows: the document named by Word')
  assert.match(Object.values(d.props).join(''), /styles\/cell/)
  press('addEditBibliography')
  await until(() => w.doc().completed >= 2, 'the bibliography')
  assert.ok(w.doc().fields.some((f) => /^BIBL/.test(f.code)))
})

test('zotlet word-install puts the Zotero tab into Word (and leaves an existing one alone)', { skip }, () => {
  const jar = path.join(ROOT, 'java', 'build', 'lib', 'zotlet.jar')
  const run = (mode, home, env = {}) => spawnSync('java', [`-Duser.home=${home}`, '-jar', jar, 'word-install'], { encoding: 'utf8', env: { ...process.env, ZOTLET_WORD_MODE: mode, NO_COLOR: '1', ...env } })

  // Windows: %APPDATA%\Microsoft\Word\STARTUP
  const appData = tempDir()
  assert.equal(run('windows', tempDir(), { APPDATA: appData }).status, 1, 'no Word: nothing to do')
  fs.mkdirSync(path.join(appData, 'Microsoft', 'Word'), { recursive: true })
  const win = run('windows', tempDir(), { APPDATA: appData })
  assert.equal(win.status, 0, win.stdout + win.stderr)
  const winTemplate = path.join(appData, 'Microsoft', 'Word', 'STARTUP', 'Zotero.dotm')
  assert.deepEqual(fs.readFileSync(winTemplate), fs.readFileSync(path.join(ROOT, 'java', 'word', 'win', 'Zotero.dotm')))
  assert.match(run('windows', tempDir(), { APPDATA: appData }).stdout, /already installed/)

  // macOS: the Office group container's Word startup folder, and the script Word runs.
  const home = tempDir()
  assert.equal(run('mac', home).status, 1, 'no Word: nothing to do')
  fs.mkdirSync(path.join(home, 'Library', 'Group Containers', 'UBF8T346G9.Office'), { recursive: true })
  const mac = run('mac', home)
  assert.equal(mac.status, 0, mac.stdout + mac.stderr)
  const startup = path.join(home, 'Library', 'Group Containers', 'UBF8T346G9.Office', 'User Content.localized', 'Startup.localized', 'Word')
  assert.deepEqual(fs.readFileSync(path.join(startup, 'Zotero.dotm')), fs.readFileSync(path.join(ROOT, 'java', 'word', 'mac', 'Zotero.dotm')))
  assert.ok(fs.existsSync(path.join(home, 'Library', 'Application Scripts', 'com.microsoft.Word', 'Zotero.scpt')))
})

test('Mac AppleScript adapter: result parsing, document/selection binding, fields, bookmarks, state recovery', { skip }, () => {
  // Compile into the same class loader/package as the adapter, without exposing test-only APIs.
  const classes = tempDir(), jar = path.join(ROOT, 'java/build/lib/zotlet.jar')
  const built = spawnSync('javac', ['--release', '11', '-cp', jar, '-d', classes, path.join(ROOT, 'java/test/WordMacTest.java')], { encoding: 'utf8' })
  assert.equal(built.status, 0, built.stdout + built.stderr)
  const r = spawnSync('java', ['-cp', `${classes}${path.delimiter}${jar}`, 'zotlet.WordMacTest',
    path.join(ROOT, 'java/word/word-mac.applescript')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^ok$/m)
})

test('Word backends are packaged without the old JXA Word helper (AppleScript/COM need real Word)', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'java/word/word-mac.js')), false)
  const script = fs.readFileSync(path.join(ROOT, 'java/word/word-mac.applescript'), 'utf8')
  assert.match(script, /using terms from application "Microsoft Word"/)
  assert.doesNotMatch(script, /ObjC\.import|NSAppleScript|use framework/)
  // Clipboard save/restore and smart-paste cleanup must be inside one native invocation.
  assert.match(script, /set zSavedClipboard to the clipboard as record/)
  assert.match(script, /on error zError number zNumber[\s\S]*?set the clipboard to zSavedClipboard[\s\S]*?error zError number zNumber/)
  assert.match(script, /set paste adjust word spacing of settings to zAdjust/)
  assert.match(script, /set the clipboard to \{«class RTF »:zText\}/)
  assert.doesNotMatch(script, /set (?:start|end) of content of .* to /, 'Word range endpoints are read-only; use its selection endpoints')
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, 'test/fake-osascript.mjs')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const ps = fs.readFileSync(path.join(ROOT, 'java', 'word', 'word-win.ps1'), 'utf8')
  for (const method of ['init', 'Document.getFields', 'Document.insertField', 'Document.cursorInField', 'Field.setText', 'Field.setCode', 'Field.removeCode', 'Document.setBibliographyStyle', 'Document.displayAlert', 'Document.complete']) {
    assert.ok(ps.includes(`'${method}'`), `word-win.ps1 handles ${method}`)
  }
})
