import { $, el, button, api, toast, author, year } from './ui.js'

export class LibraryUI {
  constructor(refresh) {
    this.refresh = refresh
    this.selected = null
    $('reference-search').addEventListener('input', () => this.renderReferences())
  }
  update(state) {
    this.state = state
    const project = state.projects?.find(p => p.id === state.activeProject)
    const visibleItems = project ? state.items.filter(i => project.itemIds.includes(i.id)) : state.items
    if (!visibleItems.some(item => item.id === this.selected)) this.selected = visibleItems[0]?.id || null
    this.renderReferences()
    this.renderDetail()
  }
  renderReferences() {
    const list = $('reference-list')
    list.replaceChildren()
    if (!this.state) return
    const q = $('reference-search').value.toLowerCase().trim()
    const project = this.state.projects?.find(p => p.id === this.state.activeProject)
    let items = project ? this.state.items.filter(i => project.itemIds.includes(i.id)) : this.state.items
    if (q) items = items.filter(item => {
      const text = [item.title, author(item), year(item), item['container-title'], item.DOI, item.id].join(' ').toLowerCase()
      return text.includes(q)
    })
    $('visible-count').textContent = items.length ? `${items.length} shown` : ''
    if (!items.length) {
      const empty = el('div', 'empty')
      empty.append(el('strong', '', this.state.items.length ? 'No matching references' : 'Library is empty'), el('p', '', project ? 'Add references to this project or switch to All references.' : 'Add a reference with a DOI or PMID.'))
      list.append(empty)
      return
    }
    for (const item of items) {
      const row = button('', () => { this.selected = item.id; this.renderReferences(); this.renderDetail() }, `reference-row${this.selected === item.id ? ' active' : ''}`)
      row.setAttribute('aria-pressed', String(this.selected === item.id))
      row.append(el('strong', '', item.title || '(untitled)'), el('span', 'muted', `${author(item) || 'Anon.'} · ${year(item)}`))
      if (project) {
        const remove = button('×', async (e) => {
          e.stopPropagation()
          try {
            await api('projects/remove', { projectId: project.id, itemIds: [item.id] })
            await this.refresh()
          } catch (error) { toast(error.message) }
        }, 'icon-button')
        remove.title = 'Remove from project'
        row.append(remove)
      }
      list.append(row)
    }
  }
  renderDetail() {
    const panel = $('reference-detail'); if (!panel) return; const item = this.state?.items.find(entry => entry.id === this.selected)
    panel.replaceChildren()
    if (!item) { panel.append(el('div', 'empty', 'Select a reference to see details.')); return }
    const root = el('div', 'detail-inner')
    panel.append(root)
    root.append(el('h2', '', item.title || '(untitled)'))
    root.append(el('p', 'metadata', `${author(item) || 'Anon.'} · ${year(item)}${item['container-title'] ? ` · ${item['container-title']}` : ''}`))
    if (item.DOI) {
      const link = el('a', 'muted', `doi.org/${item.DOI}`)
      link.href = `https://doi.org/${encodeURIComponent(item.DOI)}`
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      root.append(link)
    }
    root.append(el('p', 'reference-key', item.id))
    const actions = el('div', 'detail-actions')
    actions.append(button('Edit', () => this.edit?.(item.id)))
    actions.append(button('Copy citation', async () => {
      try {
        const style = document.getElementById('cite-style')?.value || 'nature'
        const result = await api('cite', { style, itemIds: [item.id], mode: 'citation' })
        const text = result.citations?.[0] || result.text || ''
        await navigator.clipboard.writeText(text)
        toast('In-text citation copied')
      } catch (error) { toast(error.message) }
    }))
    actions.append(button('Copy entry', async () => {
      try {
        const style = document.getElementById('cite-style')?.value || 'nature'
        const result = await api('cite', { style, itemIds: [item.id], mode: 'bibliography' })
        const text = result.bibliography || result.text || ''
        await navigator.clipboard.writeText(text)
        toast('Bibliography entry copied')
      } catch (error) { toast(error.message) }
    }))
    if (this.state.activeProject) {
      actions.append(button('Remove from project', async () => {
        try {
          await api('projects/remove', { projectId: this.state.activeProject, itemIds: [item.id] })
          await this.refresh()
        } catch (error) { toast(error.message) }
      }))
    } else {
      const projects = this.state.projects || []
      if (projects.length) {
        const select = document.createElement('select')
        select.innerHTML = '<option value="">Add to project…</option>' + projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
        select.addEventListener('change', async () => {
          if (!select.value) return
          try {
            await api('projects/add', { projectId: select.value, itemIds: [item.id] })
            toast(`Added to ${projects.find(p => p.id === select.value)?.name}`)
            select.value = ''
          } catch (error) { toast(error.message) }
        })
        actions.append(select)
      }
    }
    root.append(actions)
    if (item.abstract) {
      const abstract = el('details', 'abstract')
      abstract.append(el('summary', '', 'Abstract'), el('p', 'metadata', item.abstract))
      root.append(abstract)
    }
  }
}
