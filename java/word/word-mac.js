// zotlet's helper for Microsoft Word on macOS, run by zotlet as
//   /usr/bin/osascript -l JavaScript word-mac.js
// It reads one JSON request per line on stdin ({ id, method, args }) and answers one JSON line on
// stdout ({ id, result } or { id, error }). The methods are the document RPCs of Zotero's
// word-processor protocol (Document.getFields, Field.setText, …), done in Word through its
// AppleScript dictionary, following Zotero's Word for Mac integration
// (github.com/zotero/zotero-word-for-mac-integration, build/src/*.m), which does the same through
// Scripting Bridge. JavaScript handles the protocol; Word is driven with AppleScript snippets.
// AppleScript variables all start with "z" so they never collide with Word's scripting terms.
'use strict'
ObjC.import('Foundation')
ObjC.import('AppKit')

const FIELD_PREFIXES = [' ADDIN ZOTERO_', ' CSL_']
const BOOKMARK_PREFIXES = ['ZOTERO_', 'CSL_']
const PLACEHOLDER = '{Citation}'
const STORIES = ['main text story', 'footnotes story', 'endnotes story']

// ---------- log (ZOTLET_WORD_LOG=<file>) ----------

const LOG = (() => {
  const v = $.NSProcessInfo.processInfo.environment.objectForKey('ZOTLET_WORD_LOG')
  return v && !v.isNil() ? v.js : ''
})()

function log(line) {
  if (!LOG) return
  const fm = $.NSFileManager.defaultManager
  if (!fm.fileExistsAtPath(LOG)) fm.createFileAtPathContentsAttributes(LOG, $.NSData.data, $.NSDictionary.dictionary)
  const h = $.NSFileHandle.fileHandleForWritingAtPath(LOG)
  if (!h || h.isNil()) return
  h.seekToEndOfFile
  h.writeData($(new Date().toISOString() + '  ' + line + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  h.closeFile
}

// ---------- AppleScript ----------

/** An AppleScript string literal. */
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

const fourcc = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0

function fromDescriptor(d) {
  if (!d || d.isNil()) return null
  const type = d.descriptorType >>> 0
  if (type === fourcc('list')) {
    const out = []
    for (let k = 1; k <= d.numberOfItems; k++) out.push(fromDescriptor(d.descriptorAtIndex(k)))
    return out
  }
  if (type === fourcc('msng') || type === fourcc('null')) return null
  if (type === fourcc('true')) return true
  if (type === fourcc('fals')) return false
  if (type === fourcc('bool')) return !!d.booleanValue
  if (type === fourcc('long') || type === fourcc('shor') || type === fourcc('comp')) return d.int32Value
  const s = d.stringValue
  if (type === fourcc('doub') || type === fourcc('sing')) return s && !s.isNil() ? Number(s.js) : 0
  return s && !s.isNil() ? s.js : null
}

let docRef = 'active document'

/** Run AppleScript inside `tell application "Microsoft Word"`, with zDoc = the document. */
function word(body, what) {
  const src = 'with timeout of 600 seconds\ntell application id "com.microsoft.Word"\nset zDoc to ' + docRef + '\n' + body + '\nend tell\nend timeout'
  const script = $.NSAppleScript.alloc.initWithSource(src)
  const err = Ref()
  const result = script.executeAndReturnError(err)
  if (!result || result.isNil()) {
    const info = err[0]
    let message = 'AppleScript error', number = 0
    if (info && !info.isNil()) {
      const m = info.objectForKey('NSAppleScriptErrorMessage')
      if (m && !m.isNil()) message = m.js
      const n = info.objectForKey('NSAppleScriptErrorNumber')
      if (n && !n.isNil()) number = n.js
    }
    log(`error ${number} in ${what}: ${message}\n${body.slice(0, 600)}`)
    if (number === -1743) {
      throw new Error('macOS did not allow zotlet to control Microsoft Word. Allow it in System Settings → Privacy & Security → Automation, then try again.')
    }
    throw new Error(`${message} (${what}, ${number})`)
  }
  return fromDescriptor(result)
}

// ---------- clipboard: rich text is pasted, as Zotero does (Word is sandboxed and cannot read our files) ----------

function savePasteboard() {
  const pb = $.NSPasteboard.generalPasteboard
  const saved = []
  const items = pb.pasteboardItems
  if (!items || items.isNil()) return saved
  for (let k = 0; k < items.count; k++) {
    const item = items.objectAtIndex(k), copy = $.NSPasteboardItem.alloc.init
    const types = item.types
    for (let t = 0; t < types.count; t++) {
      const type = types.objectAtIndex(t).js
      if (/^com\.microsoft\.(Link|ObjectLink|ole)/.test(type)) continue
      const data = item.dataForType(type)
      if (data && !data.isNil()) copy.setDataForType(data, type)
    }
    saved.push(copy)
  }
  return saved
}

function restorePasteboard(saved) {
  const pb = $.NSPasteboard.generalPasteboard
  pb.clearContents
  if (saved.length) pb.writeObjects($(saved))
}

function putRTF(rtf) {
  const pb = $.NSPasteboard.generalPasteboard
  pb.clearContents
  pb.setStringForType($(rtf), 'public.rtf')
}

// ---------- document state ----------

const state = { trackRevisions: false, showRevisions: null, showFormatChanges: null }
const codes = {} // field id → last known code (to style a bibliography)

function storyRef(story) {
  return story === 0 ? 'zDoc' : `(get story range zDoc story type ${STORIES[story]})`
}

function fieldRef(id) {
  const m = /^F(\d):(\d+)$/.exec(id)
  if (!m) throw new Error(`Unknown field ${id}`)
  return `field ${m[2]} of ${storyRef(Number(m[1]))}`
}

const bookmarkName = (id) => id.slice(2)

function stripFieldCode(raw) {
  if (typeof raw !== 'string') return null
  for (const prefix of FIELD_PREFIXES) {
    const at = raw.indexOf(prefix)
    if (at !== -1) {
      let code = raw.slice(at + prefix.length)
      if (code.endsWith(' ')) code = code.slice(0, -1)
      return code
    }
  }
  return null
}

function stripBookmarkCode(raw) {
  if (typeof raw !== 'string') return null
  for (const prefix of BOOKMARK_PREFIXES) if (raw.startsWith(prefix)) return raw.slice(prefix.length).replace(/ $/, '')
  return null
}

// Document properties hold long values in chunks of 255 characters: NAME_1, NAME_2, …
function getProperty(name) {
  return word(`set zOut to ""
set zIndex to 1
repeat
  try
    set zValue to value of custom document property (${q(name)} & "_" & zIndex) of zDoc
  on error
    exit repeat
  end try
  if zValue is missing value or zValue is "" then exit repeat
  set zOut to zOut & zValue
  set zIndex to zIndex + 1
end repeat
return zOut`, `getProperty ${name}`) || ''
}

function setProperty(name, value) {
  const chunks = []
  for (let k = 0; k < value.length; k += 255) chunks.push(value.slice(k, k + 255))
  let body = ''
  chunks.forEach((chunk, k) => {
    const n = q(`${name}_${k + 1}`)
    body += `try
  set value of custom document property ${n} of zDoc to ${q(chunk)}
on error
  make new custom document property at zDoc with properties {name:${n}, value:${q(chunk)}}
end try
`
  })
  body += `set zIndex to ${chunks.length + 1}
repeat
  try
    delete custom document property (${q(name)} & "_" & zIndex) of zDoc
  on error
    exit repeat
  end try
  set zIndex to zIndex + 1
end repeat`
  word(body, `setProperty ${name}`)
}

// ---------- fields ----------

/** The Zotero fields of one story: [{ id, code, pos, notePos, note }], pos = place in the main text. */
function storyFields(story) {
  const notePosition = story === 0 ? '' : `try
      set zPos to start of content of note reference of (${story === 1 ? 'footnote' : 'endnote'} 1 of (result range of zField))
    end try`
  const rows = word(`set zOut to {}
try
  set zStory to ${storyRef(story)}
  set zCount to count of fields of zStory
on error
  return zOut
end try
repeat with zIndex from 1 to zCount
  set zField to field zIndex of zStory
  set zCode to content of field code of zField
  if zCode is not missing value and (zCode contains " ADDIN ZOTERO_" or zCode contains " CSL_") then
    set zStart to start of content of field code of zField
    set zPos to zStart
    ${notePosition}
    set end of zOut to {zIndex, zCode, zPos, zStart}
  end if
end repeat
return zOut`, `fields of ${STORIES[story]}`) || []
  return rows.map(([index, raw, pos, start]) => ({ id: `F${story}:${index}`, code: stripFieldCode(raw), pos, notePos: story ? start : 0, note: story }))
}

function bookmarkFields() {
  const rows = word(`set zOut to {}
set zCount to count of bookmarks of zDoc
repeat with zIndex from 1 to zCount
  set zMark to bookmark zIndex of zDoc
  set zName to name of zMark
  if zName starts with "ZOTERO_" then set end of zOut to {zName, start of bookmark of zMark}
end repeat
return zOut`, 'bookmarks') || []
  const out = []
  for (const [name, pos] of rows) {
    const code = stripBookmarkCode(getProperty(name))
    if (code !== null) out.push({ id: `B:${name}`, code, pos, notePos: 0, note: 0 })
  }
  return out
}

function getFields(fieldType) {
  prepareReadFieldCode()
  const fields = fieldType === 'Bookmark' ? bookmarkFields() : [0, 1, 2].flatMap(storyFields)
  fields.sort((a, b) => a.pos - b.pos || a.notePos - b.notePos)
  for (const f of fields) codes[f.id] = f.code
  return [fields.map((f) => f.id), fields.map((f) => f.code), fields.map((f) => (f.note ? 1 : 0))]
}

// With Track Changes shown, Word returns deleted text inside field codes (Zotero hides it too).
function prepareReadFieldCode() {
  if (state.showRevisions !== null) return
  const r = word(`set zView to view of active window of zDoc
set zA to false
set zB to false
try
  set zA to show insertions and deletions of zView
  if zA then set show insertions and deletions of zView to false
end try
try
  set zB to show format changes of zView
  if zB then set show format changes of zView to false
end try
return {zA, zB}`, 'prepareReadFieldCode')
  state.showRevisions = !!(r && r[0])
  state.showFormatChanges = !!(r && r[1])
}

function cursorInField(fieldType) {
  prepareReadFieldCode()
  if (fieldType === 'Bookmark') {
    const name = word(`set zS to selection start of selection
set zE to selection end of selection
set zCount to count of bookmarks of zDoc
repeat with zIndex from 1 to zCount
  set zMark to bookmark zIndex of zDoc
  set zName to name of zMark
  if zName starts with "ZOTERO_" and (start of bookmark of zMark) ≤ zE and (end of bookmark of zMark) ≥ zS then return zName
end repeat
return ""`, 'cursorInField bookmarks')
    if (!name) return null
    const code = stripBookmarkCode(getProperty(name))
    if (code === null) return null
    codes[`B:${name}`] = code
    return [`B:${name}`, code, 0]
  }
  const r = word(`set zS to selection start of selection
set zE to selection end of selection
set zType to story type of selection
if zType is footnotes story then
  set zKind to 1
else if zType is endnotes story then
  set zKind to 2
else
  set zKind to 0
end if
if zKind is 0 then
  set zStory to zDoc
else
  set zStory to get story range zDoc story type zType
end if
set zCount to count of fields of zStory
repeat with zIndex from 1 to zCount
  set zField to field zIndex of zStory
  set zCodeStart to (start of content of field code of zField) - 1
  set zResultEnd to (end of content of result range of zField) + 1
  if zS ≤ zResultEnd and zE ≥ zCodeStart then
    set zCode to content of field code of zField
    if zCode contains " ADDIN ZOTERO_" or zCode contains " CSL_" then return {zKind, zIndex, zCode}
  end if
  if zCodeStart > zE then exit repeat
end repeat
return {}`, 'cursorInField')
  if (!r || !r.length) return null
  const id = `F${r[0]}:${r[1]}`
  codes[id] = stripFieldCode(r[2])
  return [id, codes[id], r[0] ? 1 : 0]
}

function insertField(fieldType) {
  if (fieldType === 'Bookmark') {
    const name = `ZOTERO_BREF_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    word(`set zS to selection start of selection
set content of selection to ${q(PLACEHOLDER)}
set zRange to create range zDoc start zS end (zS + ${PLACEHOLDER.length})
make new bookmark at zRange with properties {name:${q(name)}}`, 'insertField bookmark')
    return [`B:${name}`, '', 0]
  }
  // Like Zotero: create a PRINTDATE field (other field types cannot hold result text), then find it
  // again by position, since Word returns an unusable reference to a new field.
  const r = word(`set zType to story type of selection
if zType is footnotes story then
  set zKind to 1
else if zType is endnotes story then
  set zKind to 2
else
  set zKind to 0
end if
set zS to selection start of selection
set zWhere to text object of selection
select zWhere
make new field at zWhere with properties {field type:field print date}
if zKind is 0 then
  set zStory to zDoc
else
  set zStory to get story range zDoc story type zType
end if
set zCount to count of fields of zStory
set zBest to 0
set zBestDistance to 1000000
repeat with zIndex from 1 to zCount
  set zCodeStart to start of content of field code of field zIndex of zStory
  set zDistance to zCodeStart - zS
  if zDistance < 0 then set zDistance to -zDistance
  if zDistance < zBestDistance then
    set zBest to zIndex
    set zBestDistance to zDistance
  end if
  if zCodeStart > zS + 2 then exit repeat
end repeat
if zBest is 0 then error "The new field could not be found"
set content of result range of field zBest of zStory to ${q(PLACEHOLDER)}
set content of field code of field zBest of zStory to " ADDIN ZOTERO_TEMP "
return {zKind, zBest}`, 'insertField')
  const id = `F${r[0]}:${r[1]}`
  codes[id] = 'TEMP'
  return [id, 'TEMP', r[0] ? 1 : 0]
}

const BIBLIOGRAPHY_STYLE = 'try\n  set style of zRange to style bibliography\nend try'

function pasteRTF(rtf, rangeExpr, what) {
  const saved = savePasteboard()
  try {
    putRTF(rtf)
    word(`set zAdjust to paste adjust word spacing of settings
set paste adjust word spacing of settings to false
paste object ${rangeExpr}
set paste adjust word spacing of settings to zAdjust`, what)
  } finally {
    restorePasteboard(saved)
  }
}

function setText(id, text, isRich) {
  const bib = isRich && /^BIBL/.test(codes[id] || '')
  if (id.startsWith('B:')) return setBookmarkText(bookmarkName(id), text, isRich, bib)
  const f = fieldRef(id)
  if (!isRich) {
    word(`set zRange to result range of ${f}
try
  set superscript of font object of zRange to false
end try
set content of zRange to ${q(text)}`, 'setText')
    return null
  }
  // Keep the font of the citation (pasting would bring the RTF's default font).
  const font = word(`set zRange to result range of ${f}
set zFontName to ""
set zFontSize to 0
try
  set zFontName to name of font object of zRange
  set zFontSize to font size of font object of zRange
end try
return {zFontName, zFontSize}`, 'setText font') || ['', 0]
  pasteRTF(text, `(result range of ${f})`, 'setText rich')
  word(`set zRange to result range of ${f}
${bib ? BIBLIOGRAPHY_STYLE : ''}
try
  ${font[0] ? `set name of font object of zRange to ${q(font[0])}` : ''}
  ${font[1] > 0 ? `set font size of font object of zRange to ${font[1]}` : ''}
end try`, 'setText restore font')
  return null
}

function setBookmarkText(name, text, isRich, bib) {
  const [start, end, storyEnd] = word(`set zMark to bookmark ${q(name)} of zDoc
return {start of bookmark of zMark, end of bookmark of zMark, end of content of text object of zDoc}`, 'bookmark range')
  if (isRich) pasteRTF(text, `(text object of bookmark ${q(name)} of zDoc)`, 'setText bookmark rich')
  else word(`set content of text object of bookmark ${q(name)} of zDoc to ${q(text)}`, 'setText bookmark')
  // Setting the text removes the bookmark: put it back around the new text.
  word(`set zEnd to ${end} + (end of content of text object of zDoc) - ${storyEnd}
try
  delete bookmark ${q(name)} of zDoc
end try
set zRange to create range zDoc start ${start} end zEnd
make new bookmark at zRange with properties {name:${q(name)}}
${bib ? BIBLIOGRAPHY_STYLE : ''}`, 'restore bookmark')
  return null
}

function setCode(id, code) {
  codes[id] = code
  if (id.startsWith('B:')) setProperty(bookmarkName(id), `ZOTERO_${code} `)
  else word(`set content of field code of ${fieldRef(id)} to ${q(FIELD_PREFIXES[0] + code + ' ')}`, 'setCode')
  return null
}

function removeCode(id) {
  if (id.startsWith('B:')) {
    const name = bookmarkName(id)
    word(`try
  delete bookmark ${q(name)} of zDoc
end try`, 'removeCode bookmark')
    setProperty(name, '')
    return null
  }
  // Zotero sends Word's "unlink" event (sWRD/2489) to the field: its text stays, the code goes.
  word(`«event sWRD2489» ${fieldRef(id)}`, 'removeCode')
  return null
}

function deleteField(id) {
  if (id.startsWith('B:')) word(`set content of text object of bookmark ${q(bookmarkName(id))} of zDoc to ""`, 'delete bookmark')
  else word(`delete ${fieldRef(id)}`, 'delete field')
  return null
}

function selectField(id) {
  if (id.startsWith('B:')) word(`select text object of bookmark ${q(bookmarkName(id))} of zDoc`, 'select')
  else word(`select result range of ${fieldRef(id)}`, 'select')
  return null
}

function getText(id) {
  if (id.startsWith('B:')) return word(`return content of text object of bookmark ${q(bookmarkName(id))} of zDoc`, 'getText') || ''
  return word(`return content of result range of ${fieldRef(id)}`, 'getText') || ''
}

// Paragraph settings of the Bibliography style, given in twips (Word wants points), as Zotero does.
function setBibliographyStyle(firstLineIndent, bodyIndent, lineSpacing, entrySpacing, tabStops) {
  const tabs = (tabStops || []).map((t) => `try
  make new tab stop at zFormat with properties {alignment:align tab left, tab leader:tab leader spaces, tab stop position:${Math.round(t / 20)}}
end try`).join('\n')
  word(`set zStyle to missing value
try
  set zStyle to Word style style bibliography of zDoc
  get name local of zStyle
on error
  try
    set zStyle to Word style "Bibliography" of zDoc
    get name local of zStyle
  on error
    set zStyle to make new Word style at zDoc with properties {name local:"Bibliography", style type:style type paragraph, base style:style normal}
  end try
end try
set zFormat to paragraph format of zStyle
try
  delete every tab stop of zFormat
end try
set first line indent of zFormat to ${firstLineIndent / 20}
set paragraph format left indent of zFormat to ${bodyIndent / 20}
set line spacing of zFormat to ${lineSpacing / 20}
set space after of zFormat to ${entrySpacing / 20}
${tabs}`, 'setBibliographyStyle')
  return null
}

const BUTTONS = [['OK'], ['Cancel', 'OK'], ['No', 'Yes'], ['Cancel', 'No', 'Yes']]
const ICONS = ['critical', 'informational', 'warning']

function displayAlert(text, icon, buttons) {
  const list = BUTTONS[buttons] || BUTTONS[0]
  const pressed = word(`activate
set zAnswer to display alert ${q(text)} as ${ICONS[icon] || 'critical'} buttons {${list.map(q).join(', ')}} default button ${q(list[list.length - 1])}
return button returned of zAnswer`, 'displayAlert')
  return Math.max(0, list.indexOf(pressed))
}

/** Remember the document and switch Track Changes off while zotlet edits it (restored by complete). */
function init(documentHint) {
  const r = word(`set zName to name of zDoc
set zSame to 0
repeat with zOther in documents
  if name of zOther is zName then set zSame to zSame + 1
end repeat
set zTrack to false
try
  set zTrack to track revisions of zDoc
  if zTrack then set track revisions of zDoc to false
end try
try
  set show field codes of view of active window of zDoc to false
end try
return {zName, zSame, zTrack}`, 'init')
  if (r[1] === 1) docRef = `document ${q(r[0])}`
  state.trackRevisions = !!r[2]
  log(`init "${r[0]}" (${documentHint || 'active document'})`)
  return r[0]
}

function complete() {
  const lines = []
  if (state.trackRevisions) lines.push('try\n  set track revisions of zDoc to true\nend try')
  if (state.showRevisions) lines.push('try\n  set show insertions and deletions of view of active window of zDoc to true\nend try')
  if (state.showFormatChanges) lines.push('try\n  set show format changes of view of active window of zDoc to true\nend try')
  if (lines.length) word(lines.join('\n'), 'complete')
  return null
}

// ---------- protocol ----------

const METHODS = {
  init: (a) => init(a[0]),
  'Document.getDocumentData': () => getProperty('ZOTERO_PREF'),
  'Document.setDocumentData': (a) => { setProperty('ZOTERO_PREF', String(a[0])); return null },
  'Document.cursorInField': (a) => cursorInField(a[0]),
  'Document.insertField': (a) => insertField(a[0]),
  'Document.getFields': (a) => getFields(a[0]),
  'Document.setBibliographyStyle': (a) => setBibliographyStyle(a[0], a[1], a[2], a[3], a[4]),
  'Document.displayAlert': (a) => displayAlert(String(a[0]), a[1] | 0, a[2] | 0),
  'Document.activate': () => { word('activate', 'activate'); return null },
  'Document.complete': () => complete(),
  'Field.setText': (a) => setText(String(a[0]), String(a[1]), !!a[2]),
  'Field.getText': (a) => getText(String(a[0])),
  'Field.setCode': (a) => setCode(String(a[0]), String(a[1])),
  'Field.removeCode': (a) => removeCode(String(a[0])),
  'Field.delete': (a) => deleteField(String(a[0])),
  'Field.select': (a) => selectField(String(a[0])),
}

function write(obj) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}

function handle(line) {
  let request
  try { request = JSON.parse(line) } catch (e) { return }
  const fn = METHODS[request.method]
  try {
    if (!fn) throw new Error(`Unknown method ${request.method}`)
    const result = fn(request.args || [])
    write({ id: request.id, result: result === undefined ? null : result })
  } catch (e) {
    log(`${request.method} failed: ${e.message}`)
    write({ id: request.id, error: String(e.message || e) })
  }
}

// osascript calls run(): serve requests until stdin closes.
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput
  let buffer = ''
  for (;;) {
    const data = input.availableData
    if (!data || data.isNil() || data.length === 0) break
    buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim()) handle(line)
    }
  }
}
