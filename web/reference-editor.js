import { $, el, api, toast } from './ui.js'

const fields = { title: 'title', author: 'author', type: 'type', year: 'issued', container: 'container-title',
  volume: 'volume', issue: 'issue', page: 'page', doi: 'DOI', publisher: 'publisher', url: 'URL', abstract: 'abstract' }
const names = (authors = []) => authors.map((name) => name.literal || [name.family, name.given].filter(Boolean).join(', ')).join('\n')
const authors = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
  const comma = line.indexOf(',')
  return comma < 0 ? { literal: line } : { family: line.slice(0, comma).trim(), given: line.slice(comma + 1).trim() }
})

export class ReferenceEditor {
  constructor(refresh) {
    this.refresh = refresh; this.mode = 'identifier'; this.original = null; this.baseline = {}; this.busy = false; this.initialIdentifiers = ''
    $('add-reference').addEventListener('click', () => this.open())
    $('identifier-mode').addEventListener('click', () => this.setMode('identifier'))
    $('manual-mode').addEventListener('click', () => this.setMode('manual'))
    $('close-reference').addEventListener('click', () => this.close())
    $('reference-dialog').addEventListener('cancel', (event) => { event.preventDefault(); this.close() })
    $('lookup-reference').addEventListener('click', () => this.import())
    $('metadata-form').addEventListener('submit', (event) => { event.preventDefault(); void this.save() })
  }
  values() { return Object.fromEntries(Object.keys(fields).map((name) => [name, $(`ref-${name}`).value])) }
  get dirty() {
    if (!$('reference-dialog').open) return false
    return this.mode === 'identifier' ? $('reference-identifiers').value !== this.initialIdentifiers : JSON.stringify(this.values()) !== JSON.stringify(this.baseline)
  }
  error(id, message = '') { $(id).textContent = message; $(id).classList.toggle('hidden', !message) }
  close() {
    if (this.busy || (this.dirty && !window.confirm('Discard the unsaved reference?'))) return
    $('reference-dialog').close()
  }
  setMode(mode) {
    if (this.busy || (this.dirty && !window.confirm('Discard the unsaved reference?'))) return
    this.fill(this.original?.item || {})
    this.mode = mode
    $('identifier-form').classList.toggle('hidden', mode !== 'identifier')
    $('metadata-form').classList.toggle('hidden', mode === 'identifier')
    for (const name of ['identifier', 'manual']) $(`${name}-mode`).classList.toggle('active', name === mode)
    $('reference-identifiers').value = ''; this.initialIdentifiers = ''
    $('reference-import-results').replaceChildren()
    this.error('import-reference-error'); this.error('reference-edit-error')
  }
  fill(item) {
    for (const [name, key] of Object.entries(fields)) {
      let value = name === 'author' ? names(item.author) : name === 'year' ? item.issued?.['date-parts']?.[0]?.[0] || '' : item[key] || ''
      if (name === 'type') {
        value ||= 'article-journal'
        if (![...$('ref-type').options].some((option) => option.value === value)) { const option = el('option', '', value); option.value = value; $('ref-type').append(option) }
      }
      $(`ref-${name}`).value = value
    }
    this.baseline = this.values()
    $('reference-stable-key').textContent = item.id ? `Citation key: ${item.id}` : 'A citation key will be created when you save.'
  }
  open() {
    this.original = null; this.fill({}); this.mode = 'identifier'; this.setMode('identifier')
    $('reference-dialog-title').textContent = 'Add reference'; $('reference-modes').classList.remove('hidden')
    $('reference-dialog').showModal(); $('reference-identifiers').focus()
  }
  async edit(id) {
    try {
      this.original = await api(`reference?id=${encodeURIComponent(id)}`)
      this.fill(this.original.item); this.mode = 'manual'; this.setMode('manual')
      $('reference-dialog-title').textContent = 'Edit reference'; $('reference-modes').classList.add('hidden')
      $('reference-dialog').showModal(); $('ref-title').focus()
    } catch (error) { toast(error.message) }
  }
  async import() {
    if (this.busy) return
    this.busy = true; $('lookup-reference').disabled = true; $('lookup-reference').textContent = 'Looking up…'; this.error('import-reference-error')
    try {
      const value = await api('references/import', { identifiers: $('reference-identifiers').value })
      const success = value.results.filter((entry) => entry.item), added = value.results.filter((entry) => entry.status === 'added')
      await this.refresh(success.at(-1)?.item.id)
      this.initialIdentifiers = $('reference-identifiers').value
      const root = $('reference-import-results'); root.replaceChildren()
      for (const entry of value.results) {
        const row = el('div', 'import-result')
        row.append(el('div', '', entry.item?.title || entry.identifier), el('div', 'muted', entry.status === 'added' ? `Added · ${entry.item.id}` : entry.status === 'duplicate' ? `Already in your library · ${entry.item.id}` : entry.message))
        root.append(row)
      }
      if (value.results.length === 1 && success.length) { $('reference-dialog').close(); toast(added.length ? 'Reference added' : 'This reference is already in your library') }
      else toast(`${added.length} added · ${value.results.length - success.length} could not be imported`)
    } catch (error) { this.error('import-reference-error', error.message) }
    finally { this.busy = false; $('lookup-reference').disabled = false; $('lookup-reference').textContent = 'Add to library' }
  }
  async save() {
    if (this.busy) return
    const current = this.values(), patch = {}
    for (const [name, key] of Object.entries(fields)) {
      if (this.original && current[name] === this.baseline[name]) continue
      const text = current[name].trim()
      if (name === 'author') patch[key] = text ? authors(text) : null
      else if (name === 'year') {
        const issued = structuredClone(this.original?.item.issued || {}), date = [...(issued['date-parts']?.[0] || [])]
        date[0] = Number(text); issued['date-parts'] = [date, ...(issued['date-parts']?.slice(1) || [])]; delete issued.literal
        patch[key] = text ? issued : null
      } else patch[key] = text || null
    }
    this.busy = true; $('save-reference').disabled = true; this.error('reference-edit-error')
    try {
      const result = this.original ? await api('references/update', { id: this.original.item.id, patch, expectedRevision: this.original.revision }) : await api('references/create', { fields: Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)) })
      await this.refresh(result.item.id); $('reference-dialog').close(); toast(this.original ? 'Reference saved. Refresh citations in your document to apply metadata changes.' : 'Reference added')
    } catch (error) { this.error('reference-edit-error', error.message) }
    finally { this.busy = false; $('save-reference').disabled = false }
  }
}
