#!/usr/bin/env node
// Process-boundary stand-in for osascript, not for WordMac: WordMac builds the AppleScript,
// parses source-form results, and keeps document/field handles exactly as it does on a Mac.
import fs from 'node:fs'
import assert from 'node:assert/strict'

assert.deepEqual(process.argv.slice(2), ['-l', 'AppleScript', '-s', 's', '-'])
if (process.env.ZOTLET_FAKE_OSA_EXIT) process.exit(Number(process.env.ZOTLET_FAKE_OSA_EXIT))
let source = ''
for await (const chunk of process.stdin) source += chunk
const match = /\nreturn (z\w+)\(([\s\S]*)\)\nend timeout\s*$/.exec(source)
assert.ok(match, 'one AppleScript handler call')
assert.doesNotMatch(source, /ObjC\.import|use framework/)

// Read AppleScript literals as data. No eval, delimiter splitting, or code execution.
const input = `{${match[2]}}`
let p = 0
const ws = () => { while (/\s/.test(input[p] || '') && p < input.length) p++ }
function value() {
  ws()
  if (input[p] === '{') {
    p++; ws()
    const out = []
    if (input[p] === '}') { p++; return out }
    for (;;) { out.push(value()); ws(); const c = input[p++]; if (c === '}') return out; assert.equal(c, ',') }
  }
  if (input[p] === '"') {
    const begin = p++
    while (p < input.length) { if (input[p++] === '"') return JSON.parse(input.slice(begin, p)); if (input[p - 1] === '\\') p++ }
    throw new Error('unterminated string')
  }
  if (input.startsWith('«data RTF ', p)) {
    const end = input.indexOf('»', p)
    const data = Buffer.from(input.slice(p + 10, end), 'hex').toString('utf8')
    p = end + 1
    return data
  }
  const begin = p
  while (p < input.length && !',}'.includes(input[p])) p++
  const token = input.slice(begin, p).trim()
  if (token === 'true') return true
  if (token === 'false') return false
  if (token === 'missing value') return null
  if (['critical', 'informational', 'warning'].includes(token)) return token
  const n = Number(token)
  assert.ok(token && Number.isFinite(n), token)
  return n
}
const args = value()
assert.equal(p, input.length)
const file = process.env.ZOTLET_FAKE_WORD_DOCUMENT
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  name: 'Paper, "中文".docx', path: '/Users/test/Paper, "中文".docx', props: {}, fields: [],
  track: true, showCodes: true, revisions: true, formats: false, start: 12, end: 12, story: 0,
  completed: 0, calls: [], alerts: [], activeName: 'Paper, "中文".docx',
}
const handler = match[1]
const documentName = args[0]
doc.calls.push({ handler, args: [...args] })
const field = (kind, index) => {
  const f = doc.fields.filter((f) => f.story === kind && f.code !== null)[index - 1]
  assert.ok(f, `${kind}:${index}`)
  return f
}
const property = (key) => { let out = ''; for (let i = 1; doc.props[`${key}_${i}`]; i++) out += doc.props[`${key}_${i}`]; return out }
const methods = {
  zInit: () => [doc.name, doc.path, doc.track, doc.showCodes, doc.revisions, doc.formats, doc.story, doc.start, doc.end],
  zBegin: () => { doc.track = false; doc.showCodes = false },
  zPrepare: () => { doc.revisions = false; doc.formats = false },
  zComplete: (track, codes, revisions, formats) => { Object.assign(doc, { track, showCodes: codes, revisions, formats }); doc.completed++ },
  zGetProperty: (key) => property(key),
  zSetProperty: (key, chunks) => {
    for (const k of Object.keys(doc.props)) if (k.startsWith(`${key}_`)) delete doc.props[k]
    chunks.forEach((chunk, i) => { doc.props[`${key}_${i + 1}`] = chunk })
  },
  zStoryFields: (kind) => doc.fields.filter((f) => f.story === kind && f.code !== null)
    .map((f, i) => [i + 1, ` ADDIN ZOTERO_${f.code} `, f.pos, f.pos]),
  zCursor: () => [],
  zInsert: (kind, start, end) => {
    doc.fields.push({ story: kind, code: 'TEMP', text: '{Citation}', pos: start, end, insertedIn: documentName })
    return doc.fields.filter((f) => f.story === kind && f.code !== null).length
  },
  zSetCode: (kind, index, code) => { field(kind, index).code = code.slice(' ADDIN ZOTERO_'.length, -1) },
  zSetText: (kind, index, mark, text, rich, bibliography) => {
    assert.equal(mark, '')
    const f = field(kind, index)
    Object.assign(f, { text, rich, bibliography })
  },
  zRemove: (kind, index) => { field(kind, index).code = null },
  zBibliographyStyle: (...args) => { doc.bibliographyStyle = args },
  zAlert: (text, icon, buttons) => { doc.alerts.push(text); return buttons.at(-1) },
  zActivate: () => { doc.activeName = doc.name },
}
let result
try {
  if (handler !== 'zInit') {
    assert.equal(args.shift(), doc.name, 'all operations bind to the original document')
    assert.equal(args.shift(), doc.path, 'all operations check its full path')
    if (doc.closed) throw new Error('The Word document is closed, renamed, or ambiguous. Click the Word button again.')
  }
  assert.ok(methods[handler], handler)
  result = methods[handler](...args)
} catch (e) { process.stderr.write(`execution error: ${e.message} (-2700)\n`); process.exitCode = 1 }
fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc)); fs.renameSync(`${file}.tmp`, file)
function literal(v) {
  if (v === null || v === undefined) return 'missing value'
  if (Array.isArray(v)) return `{${v.map(literal).join(', ')}}`
  return JSON.stringify(v)
}
if (!process.exitCode) process.stdout.write(literal(result) + '\n')
