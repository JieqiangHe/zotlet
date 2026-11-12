// A stand-in for java/word/word-mac.js / word-win.ps1 in tests: the same JSON-lines protocol on
// stdin/stdout, over an in-memory Word document kept in a JSON file (argv[2]) between processes.
// Windows mode: commands written to <file>.trigger (one per line) are sent as Word button events.
import fs from 'node:fs'
import readline from 'node:readline'

const file = process.argv[2]
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { name: 'Paper.docx', props: {}, fields: [], cursor: null, alerts: [], answer: 1, bibliographyStyle: null, trackRevisions: true, completed: 0, inits: [] })
let doc = load()
const save = () => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 1)); fs.renameSync(`${file}.tmp`, file) }
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
let next = Math.max(0, ...doc.fields.map((f) => Number(f.id.split(':')[1]) || 0)) + 1
const field = (id) => { const f = doc.fields.find((x) => x.id === id); if (!f) throw new Error(`no field ${id}`); return f }
const getProp = (name) => { let out = ''; for (let i = 1; doc.props[`${name}_${i}`]; i++) out += doc.props[`${name}_${i}`]; return out }
const setProp = (name, value) => {
  for (const k of Object.keys(doc.props)) if (k.startsWith(`${name}_`)) delete doc.props[k]
  for (let i = 0; i * 255 < value.length; i++) doc.props[`${name}_${i + 1}`] = value.slice(i * 255, i * 255 + 255)
}

const methods = {
  init: ([hint]) => { doc.inits.push(hint); doc.trackRevisionsDuring = doc.trackRevisions; doc.trackRevisions = false; return doc.name },
  'Document.getDocumentData': () => getProp('ZOTERO_PREF'),
  'Document.setDocumentData': ([data]) => { setProp('ZOTERO_PREF', data); return null },
  'Document.cursorInField': ([type]) => { const f = doc.cursor && doc.fields.find((x) => x.id === doc.cursor && x.type === type); return f ? [f.id, f.code, 0] : null },
  'Document.insertField': ([type]) => { const f = { id: `${type === 'Bookmark' ? 'B' : 'F0'}:${next++}`, type, code: 'TEMP', text: '{Citation}' }; doc.fields.push(f); return [f.id, f.code, 0] },
  'Document.getFields': ([type]) => { const fs = doc.fields.filter((f) => f.type === type && f.code !== null); return [fs.map((f) => f.id), fs.map((f) => f.code), fs.map(() => 0)] },
  'Document.setBibliographyStyle': (args) => { doc.bibliographyStyle = args; return null },
  'Document.displayAlert': ([text]) => { doc.alerts.push(text); return doc.answer },
  'Document.activate': () => null,
  'Document.complete': () => { doc.completed++; doc.trackRevisions = doc.trackRevisionsDuring; return null },
  'Field.setText': ([id, text, rich]) => { const f = field(id); f.text = text; f.rich = rich; return null },
  'Field.getText': ([id]) => field(id).text,
  'Field.setCode': ([id, code]) => { field(id).code = code; return null },
  'Field.removeCode': ([id]) => { field(id).code = null; return null },
}

if (process.env.ZOTLET_WORD_MODE === 'windows') {
  write({ event: 'ready' })
  const trigger = `${file}.trigger`
  setInterval(() => {
    if (!fs.existsSync(trigger)) return
    const lines = fs.readFileSync(trigger, 'utf8').split('\n').filter(Boolean)
    fs.rmSync(trigger)
    for (const command of lines) write({ event: 'command', command, document: 'C:\\Users\\me\\Paper.docx' })
  }, 20)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const { id, method, args } = JSON.parse(line)
  doc = load()
  try {
    if (!methods[method]) throw new Error(`Unknown method ${method}`)
    const result = methods[method](args || [])
    save()
    write({ id, result: result ?? null })
  } catch (e) { write({ id, error: e.message }) }
})
rl.on('close', () => process.exit(0))
