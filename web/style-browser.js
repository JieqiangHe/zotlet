import { $, el, button, api, toast } from './ui.js'

export class StyleBrowser {
  constructor(editor) {
    this.editor = editor; this.request = 0; this.timer = null; this.installing = false
    $('get-styles').addEventListener('click', () => { $('style-repository-dialog').showModal(); $('repository-search').focus(); void this.search() })
    $('close-style-repository').addEventListener('click', () => { if (!this.installing) $('style-repository-dialog').close() })
    $('style-repository-dialog').addEventListener('cancel', (event) => { if (this.installing) event.preventDefault() })
    $('repository-search').addEventListener('input', () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.search(), 300) })
    $('refresh-style-repository').addEventListener('click', () => this.search(true))
  }
  async search(refresh = false) {
    const request = ++this.request, query = $('repository-search').value
    $('repository-status').textContent = refresh ? 'Refreshing the official catalogue…' : 'Searching…'
    try {
      const value = refresh ? await api('style-repository/refresh', { query }) : await api(`style-repository?q=${encodeURIComponent(query)}`)
      if (request !== this.request) return
      const root = $('repository-results'); root.replaceChildren()
      $('repository-status').textContent = `${value.total} styles${value.total > value.results.length ? ` · showing the first ${value.results.length}; narrow your search` : ''}`
      if (!value.results.length) root.append(el('div', 'empty', 'No styles found. Try a journal name or a shorter search.'))
      for (const style of value.results) {
        const row = el('div', 'repository-row'), info = el('div')
        info.append(el('strong', '', style.title), el('p', 'muted', [style.format || 'CSL', ...(style.dependent ? ['Uses a parent style'] : []), ...(!style.supported ? ['Note styles are not supported'] : [])].join(' · ')))
        const install = button(style.installed ? 'Installed' : 'Install', () => this.install(style, install))
        install.disabled = style.installed || !style.supported || this.installing
        row.append(info, install); root.append(row)
      }
    } catch (error) { if (request === this.request) { $('repository-status').textContent = error.message; $('repository-results').replaceChildren() } }
  }
  async install(style, control) {
    if (this.installing || !this.editor.discard()) return
    this.installing = true; control.disabled = true; control.textContent = 'Installing…'
    try {
      const value = await api('style-repository/install', { name: style.name })
      this.editor.entries = await api('styles'); this.editor.loaded = true
      await this.editor.load(value.style.id, false)
      $('style-repository-dialog').close(); toast('Style installed. Select it in your editor’s Document Preferences')
    } catch (error) { $('repository-status').textContent = error.message; control.disabled = false; control.textContent = 'Install' }
    finally { this.installing = false }
  }
}
