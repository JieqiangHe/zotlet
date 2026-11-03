import { $, el, button, api, toast, badge } from './ui.js'

const NS = 'http://purl.org/net/xbiblio/csl'
const child = (node, name) => [...(node?.children || [])].find((entry) => entry.localName === name && entry.namespaceURI === NS)
function read(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('The CSL source contains invalid XML')
  return doc
}
function meta(doc) {
  const info = child(doc.documentElement, 'info')
  return { info, title: child(info, 'title'), id: child(info, 'id'), updated: child(info, 'updated'), bib: child(doc.documentElement, 'bibliography') }
}
const serialize = (doc) => new XMLSerializer().serializeToString(doc)
const number = (value, fallback) => Number.isFinite(Number(value)) ? Math.min(20, Math.max(0, Number(value))) : fallback
function previewDocument(value) {
  const format = value.format, line = number(format.linespacing, 1) || 1, entry = number(format.entryspacing, 1)
  const hanging = format.hangingindent ? '.csl-entry{padding-left:2em;text-indent:-2em}' : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
body{background:#292929;color:#e3e3e3;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:20px}h4{color:#8c8c8c;font-size:10px;letter-spacing:1px;font-weight:500;text-transform:uppercase;margin:0 0 13px}section+section{margin-top:25px;border-top:1px solid #3c3c3c;padding-top:18px}.csl-entry{line-height:${1.6 * line};margin-bottom:${entry * line * 1.6}em;overflow:auto}.csl-left-margin{float:left;padding-right:.6em;min-width:1.5em}.csl-right-inline{margin-left:2.2em}a{color:#94b8f2}${hanging}
</style></head><body><section><h4>In-text citations</h4>${value.citations.join(' &nbsp; ')}</section><section><h4>References</h4>${value.bibliography}</section></body></html>`
}
export class StyleEditor {
  constructor() {
    this.dirty = false; this.loaded = false; this.entries = []; this.current = null; this.request = 0
    $('import-style').addEventListener('click', () => $('style-file').click())
    $('style-file').addEventListener('change', async (event) => {
      const file = event.target.files[0]
      if (!file) return
      try {
        if (file.size > 1024 * 1024) throw new Error('Choose a CSL file smaller than 1 MiB')
        if (!this.discard()) return
        if (!this.loaded) await this.init()
        const xml = await file.text(), doc = read(xml), data = meta(doc)
        if (!data.title || !data.id || doc.documentElement.namespaceURI !== NS) throw new Error('Choose a CSL citation style file')
        this.setCurrent({ xml, title: data.title.textContent, uri: data.id.textContent, id: null, builtin: false, revision: null, path: '' })
        this.markDirty(); await this.preview(); toast('Imported into the editor. Preview, then save')
      } catch (error) { this.error(error.message) }
      finally { event.target.value = '' }
    })
    $('style-source').addEventListener('input', () => this.markDirty())
    $('style-name').addEventListener('change', () => this.change((data) => { if (data.title) data.title.textContent = $('style-name').value }))
    $('hanging-indent').addEventListener('change', () => this.change((data) => {
      if (data.bib) { data.bib.removeAttribute('second-field-align'); data.bib.setAttribute('hanging-indent', String($('hanging-indent').checked)) }
    }))
    for (const id of ['line-spacing', 'entry-spacing']) $(id).addEventListener('change', () => this.change((data) => { if (data.bib) data.bib.setAttribute(id, $(id).value) }))
    $('copy-style').addEventListener('click', () => { try { this.duplicate() } catch (error) { this.error(error.message) } })
    $('preview-style').addEventListener('click', () => this.preview())
    $('save-style').addEventListener('click', () => this.save())
    $('export-style').addEventListener('click', () => {
      const blob = new Blob([$('style-source').value], { type: 'application/xml' }), url = URL.createObjectURL(blob), link = el('a')
      link.href = url; link.download = `${this.current?.id || 'zotlet-style'}.csl`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  error(message = '') { $('style-error').textContent = message; $('style-error').classList.toggle('hidden', !message) }
  discard() { return !this.dirty || window.confirm('Discard the unsaved changes in this style?') }
  async init() { this.entries = await api('styles'); this.loaded = true; if (this.entries.length) await this.load(this.entries[0].id, false) }
  renderList() {
    const root = $('style-list'); root.replaceChildren()
    for (const style of this.entries) {
      const row = button('', () => this.load(style.id), `style-row${style.id === this.current?.id ? ' active' : ''}`)
      row.append(el('span', '', style.title), badge(style.builtin ? 'Built-in' : 'Custom', style.builtin ? '' : 'blue')); root.append(row)
    }
  }
  async load(id, ask = true) {
    if (ask && !this.discard()) return
    const value = await api(`style?id=${encodeURIComponent(id)}`)
    this.setCurrent(value); await this.preview()
  }
  setCurrent(value) {
    this.current = value; this.dirty = false; this.error()
    $('style-source').value = value.xml; $('style-source').readOnly = value.builtin
    $('style-name').value = value.title; $('style-heading').textContent = value.title
    $('style-id').textContent = value.uri
    $('style-kind').textContent = value.builtin ? 'Built-in · edit a copy to keep the original' : value.path ? 'Custom style' : 'New style · not saved yet'
    for (const id of ['style-name', 'hanging-indent', 'line-spacing', 'entry-spacing', 'save-style']) $(id).disabled = value.builtin
    $('style-state').textContent = value.builtin ? 'Built-in styles are kept as originals.' : value.path ? 'Saved. Choose this style in your editor’s Document Preferences.' : 'Save this style to use it in your editor.'
    $('style-path').textContent = value.path ? `Source: ${value.path}` : 'User styles are saved in your zotlet data folder.'
    this.syncOptions(); this.renderList()
  }
  syncOptions() {
    try {
      const data = meta(read($('style-source').value))
      $('hanging-indent').checked = data.bib?.getAttribute('hanging-indent') === 'true' || !!data.bib?.getAttribute('second-field-align')
      for (const [id, fallback] of [['line-spacing', '1'], ['entry-spacing', '1']]) {
        const value = data.bib?.getAttribute(id) || fallback
        if (![...$(id).options].some((option) => option.value === value)) { const option = el('option', '', value); option.value = value; $(id).append(option) }
        $(id).value = value
      }
    } catch {}
  }
  markDirty() { this.dirty = true; $('style-state').textContent = 'Unsaved changes'; this.error() }
  change(action) {
    if (this.current?.builtin) return
    try { const doc = read($('style-source').value); action(meta(doc)); $('style-source').value = serialize(doc); this.markDirty() }
    catch (error) { this.error(error.message) }
  }
  duplicate() {
    if (!this.current) return
    const doc = read($('style-source').value), data = meta(doc)
    if (!data.id || !data.title) throw new Error('The source needs a style title and ID before it can be copied')
    const title = `${data.title.textContent} copy`, stem = `zotlet-${(this.current.id || 'custom').replace(/^zotlet-/, '')}-copy`.slice(0, 100)
    let id = stem, n = 2
    while (this.entries.some((entry) => entry.id === id)) id = `${stem}-${n++}`
    const uri = `http://www.zotero.org/styles/${id}`
    data.title.textContent = title; data.id.textContent = uri
    for (const link of [...data.info.children].filter((node) => node.localName === 'link' && node.namespaceURI === NS && node.getAttribute('rel') === 'self')) link.setAttribute('href', uri)
    this.setCurrent({ xml: serialize(doc), id, title, uri, builtin: false, revision: null, path: '' })
    this.markDirty(); $('style-name').focus(); $('style-name').select()
  }
  async preview() {
    const request = ++this.request
    $('preview-style').disabled = true; $('preview-context').textContent = 'Rendering…'; this.error()
    try {
      const value = await api('style/preview', { xml: $('style-source').value })
      if (request !== this.request) return
      $('style-preview').srcdoc = previewDocument(value)
      $('preview-context').textContent = value.sample ? 'Sample references · en-US' : `Your references · up to 8 items · en-US`
      this.syncOptions()
    } catch (error) { if (request === this.request) { this.error(error.message); $('preview-context').textContent = 'Preview unavailable' } }
    finally { if (request === this.request) $('preview-style').disabled = false }
  }
  async save() {
    if (this.current?.builtin) return
    $('save-style').disabled = true; this.error()
    try {
      const doc = read($('style-source').value), data = meta(doc)
      if (data.updated) data.updated.textContent = new Date().toISOString()
      $('style-source').value = serialize(doc)
      const saved = await api('style/save', { xml: $('style-source').value, expectedRevision: this.current.revision })
      this.entries = await api('styles'); this.setCurrent(saved); await this.preview()
      toast('Style saved. Select it in your editor’s Document Preferences')
    } catch (error) { this.error(error.message) }
    finally { $('save-style').disabled = !!this.current?.builtin }
  }
}
