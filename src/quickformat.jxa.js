// zotlet Quick Format — a native macOS citation picker in the spirit of Zotero's quick format bar.
// Run by src/quickformat.js:  osascript -l JavaScript quickformat.jxa.js <spec.json>
//
// spec = { mode: 'cite' | 'style', items: [{ id, title, detail, search }], selected: [id],
//          styles: [{ id, label }], style, askStyle, bookmarks, bookmarksLocked }
// Prints JSON — cite: { ids, style? }, style: { style, bookmarks? } — or nothing when cancelled.
//
// Keys: type to search · ↑↓ move · Enter adds the highlighted reference (Enter on an empty search
// inserts) · ⌫ on an empty search removes the last reference · double-click inserts · Esc cancels.
/* global ObjC, $ */
ObjC.import('Cocoa')

var Q = { spec: null, rows: [], chosen: [], result: null, field: null, table: null, label: null, popup: null, check: null, win: null, delegate: null, monitor: null }
var KEY = { enter: 36, pad: 76, esc: 53, del: 51, up: 126, down: 125 }

function str(value) { return $(String(value == null ? '' : value)) }
function byId(id) { for (var i = 0; i < Q.spec.items.length; i++) if (Q.spec.items[i].id === id) return Q.spec.items[i]; return null }

function query() { return Q.field.stringValue.js.toLowerCase().split(/\s+/).filter(function (w) { return w }) }

function refresh() {
  var words = query()
  if (Q.spec.mode === 'style') {
    Q.rows = Q.spec.styles.filter(function (s) { var h = (s.label + ' ' + s.id).toLowerCase(); return words.every(function (w) { return h.indexOf(w) >= 0 }) })
  } else {
    Q.rows = Q.spec.items.filter(function (it) { return words.every(function (w) { return it.search.indexOf(w) >= 0 }) })
  }
  Q.table.reloadData
  if (Q.rows.length) select(0)
  updateLabel()
}

function select(row) {
  if (!Q.rows.length) return
  row = Math.max(0, Math.min(Q.rows.length - 1, row))
  Q.table.selectRowIndexesByExtendingSelection($.NSIndexSet.indexSetWithIndex(row), false)
  Q.table.scrollRowToVisible(row)
}

function highlighted() { var r = Number(Q.table.selectedRow); return r >= 0 && r < Q.rows.length ? Q.rows[r] : null }

function updateLabel() {
  if (Q.spec.mode === 'style') return
  if (!Q.chosen.length) { Q.label.stringValue = str('Type to search · ↑↓ choose · Enter adds · Enter again inserts · Esc cancels'); return }
  var names = Q.chosen.map(function (id) { var it = byId(id); return it ? it.short : id })
  Q.label.stringValue = str('Citing: ' + names.join('; ') + '   —   Enter inserts · ⌫ removes the last')
}

function add(item) {
  if (item && Q.chosen.indexOf(item.id) < 0) Q.chosen.push(item.id)
  Q.field.stringValue = str('')
  refresh()
  Q.table.reloadData
}

function finish(ok) {
  if (ok) {
    if (Q.spec.mode === 'style') {
      var s = highlighted()
      if (!s) return
      Q.result = { style: s.id }
      if (Q.check) Q.result.bookmarks = Number(Q.check.state) === 1
    } else {
      if (!Q.chosen.length) { var h = highlighted(); if (h) Q.chosen.push(h.id) }
      if (!Q.chosen.length) return
      Q.result = { ids: Q.chosen.slice() }
      if (Q.popup) Q.result.style = Q.spec.styles[Number(Q.popup.indexOfSelectedItem)].id
    }
  }
  if (Q.monitor) $.NSEvent.removeMonitor(Q.monitor)
  $.NSApp.stopModal
  Q.win.orderOut(null)
}

ObjC.registerSubclass({
  name: 'ZotletQuickFormat',
  protocols: ['NSTextFieldDelegate', 'NSTableViewDataSource', 'NSTableViewDelegate'],
  methods: {
    'controlTextDidChange:': { types: ['void', ['id']], implementation: function () { refresh() } },
    'numberOfRowsInTableView:': { types: ['long', ['id']], implementation: function () { return Q.rows.length } },
    'tableView:objectValueForTableColumn:row:': {
      types: ['id', ['id', 'id', 'long']],
      implementation: function (table, column, row) {
        var r = Q.rows[row]
        if (!r) return str('')
        if (Q.spec.mode === 'style') return str(r.label)
        var col = column.identifier.js
        if (col === 'title') return str((Q.chosen.indexOf(r.id) >= 0 ? '✓ ' : '') + r.title)
        return str(r.detail)
      },
    },
    'tableDoubleClick:': {
      types: ['void', ['id']],
      implementation: function () {
        var row = Number(Q.table.clickedRow)
        if (row < 0 || row >= Q.rows.length) return
        if (Q.spec.mode !== 'style' && Q.chosen.indexOf(Q.rows[row].id) < 0) Q.chosen.push(Q.rows[row].id)
        select(row)
        finish(true)
      },
    },
  },
})

function label(text, frame, size, gray) {
  var l = $.NSTextField.alloc.initWithFrame(frame)
  l.stringValue = str(text)
  l.bezeled = false; l.drawsBackground = false; l.editable = false; l.selectable = false
  l.font = $.NSFont.systemFontOfSize(size)
  if (gray) l.textColor = $.NSColor.secondaryLabelColor
  l.lineBreakMode = 4 // truncate tail
  return l
}

function run(argv) {
  var text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)
  Q.spec = JSON.parse(text.js)
  var cite = Q.spec.mode !== 'style'
  Q.chosen = (Q.spec.selected || []).filter(function (id) { return byId(id) })

  $.NSApplication.sharedApplication
  $.NSApp.setActivationPolicy(1) // accessory: no Dock icon
  var W = 680, H = cite ? 400 : 360
  // Titled + full-size content: a clean rounded panel without a visible title bar.
  Q.win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, W, H), 1 | 32768, 2, false)
  Q.win.titlebarAppearsTransparent = true
  Q.win.titleVisibility = 1
  Q.win.movableByWindowBackground = true
  Q.win.level = 3 // floating, above the word processor
  Q.win.hidesOnDeactivate = false // stay visible if another app is clicked (otherwise it would wait unseen)
  Q.win.collectionBehavior = (1 << 0) | (1 << 8) // current Space, also over a full-screen word processor
  for (var b = 0; b < 3; b++) { var btn = Q.win.standardWindowButton(b); if (btn) btn.hidden = true }
  var content = Q.win.contentView

  Q.delegate = $.ZotletQuickFormat.alloc.init

  var top = H - 58
  var fieldWidth = W - 32 - (cite && Q.spec.askStyle ? 196 : 0)
  Q.field = $.NSSearchField.alloc.initWithFrame($.NSMakeRect(16, top, fieldWidth, 34))
  Q.field.font = $.NSFont.systemFontOfSize(16)
  Q.field.placeholderString = str(cite ? 'zotlet — search title, author, year, journal…' : 'Citation style for this document')
  Q.field.delegate = Q.delegate
  Q.field.focusRingType = 1
  content.addSubview(Q.field)

  if (cite && Q.spec.askStyle) {
    Q.popup = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(W - 16 - 184, top + 3, 184, 28), false)
    var current = 0
    Q.spec.styles.forEach(function (s, i) { Q.popup.addItemWithTitle(str(s.label)); if (s.id === Q.spec.style) current = i })
    Q.popup.selectItemAtIndex(current)
    content.addSubview(Q.popup)
  }

  Q.label = label('', $.NSMakeRect(18, top - 26, W - 36, 18), 12, true)
  content.addSubview(Q.label)

  var listBottom = 16
  if (!cite && typeof Q.spec.bookmarks === 'boolean') {
    Q.check = $.NSButton.checkboxWithTitleTargetAction(str('Also open in Microsoft Word with Zotero (store citations as bookmarks)'), null, null)
    Q.check.frame = $.NSMakeRect(16, 14, W - 32, 22)
    Q.check.state = Q.spec.bookmarks ? 1 : 0
    Q.check.enabled = !Q.spec.bookmarksLocked
    content.addSubview(Q.check)
    listBottom = 44
  }

  var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(16, listBottom, W - 32, top - 34 - listBottom))
  scroll.hasVerticalScroller = true
  scroll.borderType = 0
  scroll.drawsBackground = false
  Q.table = $.NSTableView.alloc.initWithFrame(scroll.bounds)
  if (cite) {
    var t = $.NSTableColumn.alloc.initWithIdentifier(str('title')); t.width = W - 32 - 210; Q.table.addTableColumn(t)
    var d = $.NSTableColumn.alloc.initWithIdentifier(str('detail')); d.width = 200; Q.table.addTableColumn(d)
  } else {
    var c = $.NSTableColumn.alloc.initWithIdentifier(str('style')); c.width = W - 40; Q.table.addTableColumn(c)
  }
  Q.table.setHeaderView(null)
  Q.table.rowHeight = 24
  Q.table.usesAlternatingRowBackgroundColors = false
  Q.table.refusesFirstResponder = true // typing always goes to the search field
  Q.table.dataSource = Q.delegate
  Q.table.delegate = Q.delegate
  Q.table.target = Q.delegate
  Q.table.doubleAction = 'tableDoubleClick:'
  scroll.documentView = Q.table
  content.addSubview(scroll)

  // Keyboard, Zotero style. The monitor sees keys before the search field does.
  Q.monitor = $.NSEvent.addLocalMonitorForEventsMatchingMaskHandler(1 << 10, function (event) {
    var key = Number(event.keyCode)
    var empty = Q.field.stringValue.js.trim() === ''
    if (key === KEY.esc) { finish(false); return $() }
    if (key === KEY.down || key === KEY.up) { select(Number(Q.table.selectedRow) + (key === KEY.down ? 1 : -1)); return $() }
    if (key === KEY.enter || key === KEY.pad) {
      if (!cite || (empty && Q.chosen.length) || (Number(event.modifierFlags) & (1 << 20))) finish(true) // ⌘Enter inserts at once
      else if (!empty) add(highlighted())
      else finish(true)
      return $()
    }
    if (key === KEY.del && cite && empty && Q.chosen.length) { Q.chosen.pop(); updateLabel(); Q.table.reloadData; return $() }
    return event
  })

  refresh()
  if (!cite) { for (var i = 0; i < Q.rows.length; i++) if (Q.rows[i].id === Q.spec.style) select(i) }

  // Centered, in the upper part of the screen, like Zotero's bar.
  var screen = $.NSScreen.mainScreen.visibleFrame
  Q.win.setFrameOrigin($.NSMakePoint(screen.origin.x + (screen.size.width - W) / 2, screen.origin.y + screen.size.height * 0.62 - H / 2))
  $.NSApp.activateIgnoringOtherApps(true)
  Q.win.makeKeyAndOrderFront(null)
  Q.win.makeFirstResponder(Q.field)
  $.NSApp.runModalForWindow(Q.win)

  return Q.result ? JSON.stringify(Q.result) : ''
}
