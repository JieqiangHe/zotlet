import { $, api, toast } from './ui.js'
import { LibraryUI } from './library.js'
import { ReferenceEditor } from './reference-editor.js'

let wasRunning = false, polling = false
const library = new LibraryUI(refresh)
const references = new ReferenceEditor(refresh)
library.edit = (id) => references.edit(id)

async function refresh(selected) {
  const state = await api('state')
  if (selected) library.selected = selected
  library.update(state)
  renderProjects(state)
  renderCitations(state.citations)
  $('connection').textContent = 'Local connection'
  return state
}

function renderProjects(state) {
  const list = $('collections-list')
  list.innerHTML = ''
  const all = document.createElement('button')
  all.className = 'collection-item' + (!state.activeProject ? ' active' : '')
  all.dataset.id = ''
  all.textContent = 'My Library'
  all.addEventListener('click', () => switchProject(null))
  list.append(all)
  for (const p of state.projects || []) {
    const btn = document.createElement('button')
    btn.className = 'collection-item' + (p.id === state.activeProject ? ' active' : '')
    btn.dataset.id = p.id
    btn.textContent = p.name
    btn.addEventListener('click', () => switchProject(p.id))
    list.append(btn)
  }
}
async function switchProject(id) {
  try {
    await api('projects/active', { id })
    await refresh()
  } catch (error) { toast(error.message) }
}

function renderCitations(service) {
  if (!service) return
  $('citation-status').className = `service-button ${service.state}`
  $('citation-state').textContent = { running: 'Citations ready', starting: 'Starting…', error: 'Citations unavailable', stopped: 'Citations off' }[service.state] || service.state
  $('citation-description').textContent = service.state === 'running' ? `Ready on ports ${service.ports.join(' and ')}. Keep this process running.` : service.error || 'Start the citation service for editor integrations.'
  $('citation-logs').textContent = service.logs || ''
  $('start-citations').disabled = ['running', 'starting'].includes(service.state)
  $('start-citations').textContent = service.state === 'error' ? 'Try again' : service.state === 'running' ? 'Running' : 'Start service'
}



$('new-project').addEventListener('click', () => {
  $('project-name').value = ''
  $('project-error').classList.add('hidden')
  $('project-dialog').showModal()
})
$('close-project').addEventListener('click', () => $('project-dialog').close())
$('project-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    await api('projects/create', { name: $('project-name').value.trim() })
    $('project-dialog').close()
    await refresh()
    toast('Project created')
  } catch (error) {
    $('project-error').textContent = error.message
    $('project-error').classList.remove('hidden')
  }
})

// Export
function toBibTeX(item) {
  const type = ({ 'article-journal': 'article', book: 'book', 'paper-conference': 'inproceedings', report: 'techreport' })[item.type] || 'misc'
  const key = item.id || 'ref'
  const authors = (item.author || []).map(a => a.family ? `${a.family}, ${a.given || ''}` : a.literal || '').filter(Boolean).join(' and ')
  const year = item.issued?.['date-parts']?.[0]?.[0] || ''
  let bib = `@${type}{${key},\n`
  if (authors) bib += `  author = {${authors}},\n`
  if (item.title) bib += `  title = {${item.title}},\n`
  if (item['container-title']) bib += `  journal = {${item['container-title']}},\n`
  if (year) bib += `  year = {${year}},\n`
  if (item.volume) bib += `  volume = {${item.volume}},\n`
  if (item.issue) bib += `  number = {${item.issue}},\n`
  if (item.page) bib += `  pages = {${item.page}},\n`
  if (item.DOI) bib += `  doi = {${item.DOI}},\n`
  if (item.URL) bib += `  url = {${item.URL}},\n`
  bib += '}\n'
  return bib
}

function toRIS(item) {
  const type = ({ 'article-journal': 'JOUR', book: 'BOOK', 'paper-conference': 'CONF' })[item.type] || 'GEN'
  let ris = `TY  - ${type}\n`
  for (const a of item.author || []) {
    const name = a.family ? `${a.family}, ${a.given || ''}` : a.literal || ''
    if (name) ris += `AU  - ${name}\n`
  }
  if (item.title) ris += `TI  - ${item.title}\n`
  if (item['container-title']) ris += `T2  - ${item['container-title']}\n`
  const year = item.issued?.['date-parts']?.[0]?.[0]
  if (year) ris += `PY  - ${year}\n`
  if (item.volume) ris += `VL  - ${item.volume}\n`
  if (item.issue) ris += `IS  - ${item.issue}\n`
  if (item.page) ris += `SP  - ${item.page}\n`
  if (item.DOI) ris += `DO  - ${item.DOI}\n`
  if (item.URL) ris += `UR  - ${item.URL}\n`
  ris += 'ER  - \n\n'
  return ris
}

$('export-btn').addEventListener('click', (e) => {
  e.stopPropagation()
  $('export-menu').classList.toggle('hidden')
})
document.addEventListener('click', () => $('export-menu').classList.add('hidden'))
$('export-menu').addEventListener('click', (e) => {
  const format = e.target.dataset.format
  if (!format || !library.state) return
  const project = library.state.projects?.find(p => p.id === library.state.activeProject)
  const items = project ? library.state.items.filter(i => project.itemIds.includes(i.id)) : library.state.items
  if (!items.length) return toast('Nothing to export')
  let content, filename, mime
  if (format === 'json') {
    content = JSON.stringify(items, null, 2)
    filename = (project?.name || 'library') + '.json'
    mime = 'application/json'
  } else if (format === 'bibtex') {
    content = items.map(toBibTeX).join('\n')
    filename = (project?.name || 'library') + '.bib'
    mime = 'application/x-bibtex'
  } else if (format === 'ris') {
    content = items.map(toRIS).join('')
    filename = (project?.name || 'library') + '.ris'
    mime = 'application/x-research-info-systems'
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  $('export-menu').classList.add('hidden')
  toast(`Exported ${items.length} references as ${format.toUpperCase()}`)
})

$('citation-status').addEventListener('click', () => $('citation-dialog').showModal())
$('close-citations').addEventListener('click', () => $('citation-dialog').close())
$('start-citations').addEventListener('click', async () => {
  try { renderCitations(await api('citations/start', {})) } catch (error) { toast(error.message) }
})

async function poll() {
  if (polling) return
  polling = true
  try {
    const job = await api('job')
    if (job.running || wasRunning) {
      wasRunning = job.running
      await refresh()
    }
  } catch (error) { toast(error.message) }
  finally { polling = false }
}
setInterval(poll, 2000)

// Dark mode
const themeBtn = $('theme-toggle')
const saved = localStorage.getItem('zotlet-theme')
if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.body.classList.add('dark')
}
themeBtn.addEventListener('click', () => {
  document.body.classList.toggle('dark')
  localStorage.setItem('zotlet-theme', document.body.classList.contains('dark') ? 'dark' : 'light')
})

refresh().catch((error) => toast(error.message))

// Bibliography generation
$('gen-bib').addEventListener('click', async () => {
  if (!library.state) return toast('Loading…')
  const project = library.state.projects?.find(p => p.id === library.state.activeProject)
  const itemIds = project ? project.itemIds : library.state.items.map(i => i.id)
  if (!itemIds.length) return toast('No references to cite')
  try {
    const style = $('cite-style').value || 'nature'
    const result = await api('cite', { style, itemIds, mode: 'bibliography' })
    $('bib-text').textContent = result.bibliography || result.text || '(empty)'
    $('bib-dialog').showModal()
  } catch (error) { toast(error.message) }
})
$('close-bib').addEventListener('click', () => $('bib-dialog').close())
$('copy-bib').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('bib-text').textContent)
    toast('Bibliography copied')
  } catch { toast('Copy failed') }
})
$('download-bib').addEventListener('click', () => {
  const text = $('bib-text').textContent
  const project = library.state?.projects?.find(p => p.id === library.state.activeProject)
  const name = (project?.name || 'bibliography') + '.txt'
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

// Project actions (direct buttons)
$('rename-project').addEventListener('click', async () => {
  const id = library.state?.activeProject
  if (!id) return toast('Select a project first')
  const current = library.state.projects.find(p => p.id === id)?.name || ''
  const name = prompt('New project name:', current)
  if (!name || name.trim() === current) return
  try {
    await api('projects/rename', { id, name: name.trim() })
    await refresh()
    toast('Project renamed')
  } catch (error) { toast(error.message) }
})
$('delete-project').addEventListener('click', async () => {
  const id = library.state?.activeProject
  if (!id) return toast('Select a project first')
  const name = library.state.projects.find(p => p.id === id)?.name || 'project'
  if (!confirm(`Delete project "${name}"? References stay in the library.`)) return
  try {
    await api('projects/delete', { id })
    await refresh()
    toast('Project deleted')
  } catch (error) { toast(error.message) }
})
