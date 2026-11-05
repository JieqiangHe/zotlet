// zotlet frontend. Plain ES module, no build step.

const $ = (id) => document.getElementById(id)
const TOKEN = document.querySelector('meta[name="zotlet-token"]').content
const store = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch { /* private mode */ } },
}

// ---------- state ----------

const state = {
  items: [],
  projects: [],
  styles: [],
  added: {}, // itemId -> ISO time it was imported (older references have none)
  paths: {},
  project: store.get('zotlet-project') || '',
  query: '',
  sort: readSort(),
  selected: new Set(),
  anchor: null, // start of a shift-range
  cursor: null, // row moved by the arrow keys
  visible: [],
}

// ---------- api ----------

async function api(path, body) {
  const init = body === undefined
    ? { headers: { 'X-Zotlet-Token': TOKEN } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': TOKEN }, body: JSON.stringify(body) }
  let res
  try { res = await fetch(`/api/${path}`, init) } catch { throw new Error('Cannot reach zotlet. Is the server still running?') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

async function refresh() {
  const data = await api('state')
  state.items = data.items
  state.projects = data.projects
  state.added = data.added || {}
  state.paths = data.paths
  state.styles = data.styles
  if (state.project && !state.projects.some((p) => p.id === state.project)) setProject('')
  render()
}

// ---------- helpers ----------

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k in node && typeof v !== 'string') node[k] = v
    else node.setAttribute(k, v === true ? '' : v)
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))
  return node
}
const icon = (paths) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'i'); svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = paths
  return svg
}
const ICONS = {
  folder: '<path d="M2 4.5V12.5h12V6H8L6.5 4.5z"/>',
  book: '<path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="M5.5 7h5M5.5 9.5h5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
}

const plain = (s) => String(s ?? '').replace(/<[^>]+>/g, '')
const yearOf = (i) => i.issued?.['date-parts']?.[0]?.[0] ?? ''
const nameOf = (n) => n.literal || [n['non-dropping-particle'], n.family].filter(Boolean).join(' ')
function authorsShort(item) {
  const a = item.author || item.editor || []
  if (!a.length) return ''
  if (a.length === 1) return nameOf(a[0])
  if (a.length === 2) return `${nameOf(a[0])} & ${nameOf(a[1])}`
  return `${nameOf(a[0])} et al.`
}
const authorsFull = (item) => (item.author || item.editor || []).map((n) => n.literal || [n.given, nameOf(n)].filter(Boolean).join(' ')).join(', ')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Restricted rich-text: only <i>, <b>, <sub>, <sup> survive, everything else is text.
function richTitle(value) {
  const frag = document.createDocumentFragment()
  const re = /<(\/?)(i|b|sub|sup)>/gi
  const stack = [frag]
  let last = 0, m
  const text = String(value ?? '')
  while ((m = re.exec(text))) {
    stack.at(-1).append(text.slice(last, m.index))
    if (m[1]) { if (stack.length > 1) stack.pop() } else { const n = document.createElement(m[2].toLowerCase()); stack.at(-1).append(n); stack.push(n) }
    last = re.lastIndex
  }
  stack.at(-1).append(text.slice(last))
  return frag
}

let toastTimer
function toast(message, kind = '') {
  const t = $('toast')
  t.textContent = message
  t.className = `toast ${kind}`
  t.hidden = false
  // As a popover the toast sits in the top layer, above any open modal dialog.
  if (t.showPopover) { try { t.hidePopover() } catch {} t.showPopover() }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true; try { t.hidePopover?.() } catch {} }, kind === 'error' ? 5000 : 2600)
}
const fail = (error) => toast(error.message || String(error), 'error')

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// ---------- view ----------

const currentProject = () => state.projects.find((p) => p.id === state.project) || null

function setProject(id) {
  state.project = id || ''
  store.set('zotlet-project', state.project)
  state.selected.clear()
  state.anchor = null
}

function haystack(item) {
  return [item.id, plain(item.title), item['container-title'], item['container-title-short'], yearOf(item), item.DOI, item.PMID,
    ...(item.author || []).map((n) => `${n.given || ''} ${nameOf(n)}`), ...(item.editor || []).map(nameOf)].join(' ').toLowerCase()
}

function computeVisible() {
  const project = currentProject()
  let items = state.items
  if (project) {
    const ids = new Set(project.itemIds)
    items = items.filter((i) => ids.has(i.id))
  }
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length) items = items.filter((i) => { const h = haystack(i); return words.every((w) => h.includes(w)) })
  // Library order is import order, so "newest first" and the Added column work for old references too.
  const order = new Map(state.items.map((i, n) => [i.id, n]))
  const { key, dir } = state.sort
  const value = {
    title: (i) => plain(i.title).toLowerCase(),
    author: (i) => authorsShort(i).toLowerCase(),
    year: (i) => Number(yearOf(i)) || 0,
    journal: (i) => plain(i['container-title'] || i.publisher || '').toLowerCase(),
  }[key]
  return [...items].sort((a, b) => {
    if (key === 'added') return dir * (order.get(a.id) - order.get(b.id))
    if (value) {
      const x = value(a), y = value(b)
      // Empty values always sink to the bottom.
      if (x === '' || x === 0) { if (y !== '' && y !== 0) return 1 } else if (y === '' || y === 0) return -1
      else if (x < y) return -dir
      else if (x > y) return dir
    }
    return order.get(b.id) - order.get(a.id) // newest first
  })
}

function render() {
  state.visible = computeVisible()
  const visibleIds = new Set(state.visible.map((i) => i.id))
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id)
  renderSidebar()
  renderRows()
  renderChrome()
}

function renderSidebar() {
  const allBtn = document.querySelector('.nav-item[data-project=""]')
  allBtn.classList.toggle('active', !state.project)
  $('count-all').textContent = state.items.length
  const list = $('project-list')
  list.replaceChildren(...state.projects.map((p) => el('button', {
    class: `nav-item${p.id === state.project ? ' active' : ''}`, dataset: { project: p.id }, title: p.name,
  }, icon(ICONS.folder), el('span', { class: 'nav-name' }, p.name), el('span', { class: 'count' }, String(p.itemIds.length)))))
  $('projects-empty').hidden = state.projects.length > 0
  const has = !!currentProject()
  $('project-rename').disabled = !has
  $('project-delete').disabled = !has
  $('project-rename').title = has ? `Rename “${currentProject().name}”` : 'Select a project first'
  $('project-delete').title = has ? `Delete “${currentProject().name}”` : 'Select a project first'
}

function renderRows() {
  const rows = state.visible.map((item) => {
    const selected = state.selected.has(item.id)
    const title = el('span', { class: 'cell title', title: plain(item.title) })
    title.append(richTitle(item.title || '(untitled)'))
    const journal = el('span', { class: 'cell journal', title: item['container-title'] || '' })
    journal.append(richTitle(item['container-title'] || item.publisher || ''))
    return el('div', { class: `row${selected ? ' selected' : ''}`, role: 'row', dataset: { id: item.id }, draggable: 'true', 'aria-selected': String(selected) },
      el('span', { class: 'cell check' }, el('input', { type: 'checkbox', checked: selected, tabIndex: -1, 'aria-label': 'Select' })),
      title,
      el('span', { class: 'cell authors', title: authorsFull(item) }, authorsShort(item)),
      el('span', { class: 'cell year num' }, String(yearOf(item))),
      journal,
      addedCell(item))
  })
  $('rows').replaceChildren(...rows)
  $('rows').hidden = !rows.length
  document.querySelector('.row.head').hidden = !rows.length
  renderEmpty()
}

function renderEmpty() {
  const empty = $('empty')
  if (state.visible.length) { empty.hidden = true; return }
  const project = currentProject()
  let iconPaths = ICONS.book, title, text, action
  if (state.query) {
    iconPaths = ICONS.search
    title = 'No matches'
    text = `Nothing in ${project ? `“${project.name}”` : 'your library'} matches “${state.query}”.`
    action = el('button', { class: 'btn', onclick: clearSearch }, 'Clear search')
  } else if (project) {
    iconPaths = ICONS.folder
    title = 'This project is empty'
    text = 'Import references while this project is selected, or select references in All references and use “Add to project” (you can also drag them onto the project).'
    action = el('button', { class: 'btn primary', onclick: () => openRefDialog() }, 'Add references')
  } else {
    title = 'Your library is empty'
    text = 'Paste DOIs or PMIDs to import references, or enter one by hand.'
    action = el('button', { class: 'btn primary', onclick: () => openRefDialog() }, 'Add references')
  }
  const svg = icon(iconPaths); svg.classList.add('empty-icon')
  empty.replaceChildren(svg, el('strong', {}, title), el('p', {}, text), action)
  empty.hidden = false
}

function renderChrome() {
  const project = currentProject()
  $('view-title').textContent = project ? project.name : 'All references'
  const total = project ? project.itemIds.length : state.items.length
  $('view-count').textContent = state.query ? `${state.visible.length} of ${total}` : String(total)
  const n = state.selected.size
  $('selection-actions').hidden = n === 0
  $('list-hint').hidden = n > 0 || state.visible.length === 0
  $('selection-count').textContent = `${n} selected`
  $('btn-remove-from').hidden = !project
  // The search box says where it searches.
  $('search').placeholder = project ? `Search in “${project.name}”…` : 'Search all references…'
  for (const btn of document.querySelectorAll('.cell.sort')) {
    const active = btn.dataset.sort === state.sort.key
    btn.classList.toggle('active', active)
    btn.querySelector('.arrow').textContent = active ? (state.sort.dir > 0 ? '▲' : '▼') : ''
    btn.setAttribute('aria-sort', active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none')
  }
  const all = $('check-all')
  all.checked = n > 0 && n === state.visible.length
  all.indeterminate = n > 0 && n < state.visible.length
  all.disabled = state.visible.length === 0
  $('btn-export').disabled = state.visible.length === 0
  $('btn-export').title = `Export ${scope().label}: CSL JSON + BibTeX + RIS in one zip`
}


/** What Export acts on: the selection, else everything visible. */
function scope() {
  const project = currentProject()
  if (state.selected.size) {
    const ids = state.visible.filter((i) => state.selected.has(i.id)).map((i) => i.id)
    return { ids, label: `${plural(ids.length, 'selected reference')}`, name: project ? `${project.name} (selection)` : 'selection' }
  }
  const ids = state.visible.map((i) => i.id)
  const where = project ? `project “${project.name}”` : 'whole library'
  return { ids, label: state.query ? `${plural(ids.length, 'search result')} in ${where}` : `${where} · ${plural(ids.length, 'reference')}`, name: project ? project.name : 'library' }
}

// ---------- sorting ----------

// Year and Added start with the newest first; text columns start A→Z.
const firstDir = (key) => (key === 'year' || key === 'added' ? -1 : 1)
function readSort() {
  try {
    const saved = JSON.parse(localStorage.getItem('zotlet-sort') || 'null')
    if (saved && ['title', 'author', 'year', 'journal', 'added'].includes(saved.key) && (saved.dir === 1 || saved.dir === -1)) return saved
  } catch { /* private mode or bad value */ }
  return { key: '', dir: 1 }
}
for (const btn of document.querySelectorAll('.cell.sort')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort
    if (state.sort.key !== key) state.sort = { key, dir: firstDir(key) }
    else if (state.sort.dir === firstDir(key)) state.sort.dir *= -1
    else state.sort = { key: '', dir: 1 } // third click: back to the default (newest first)
    store.set('zotlet-sort', JSON.stringify(state.sort))
    render()
  })
}

function addedCell(item) {
  const at = state.added[item.id]
  const date = at ? new Date(at) : null
  const valid = date && !Number.isNaN(date.getTime())
  const pad = (n) => String(n).padStart(2, '0')
  return el('span', { class: 'cell added num', title: valid ? `Imported ${date.toLocaleString()}` : 'Imported before zotlet recorded import dates' },
    // Down to the second, in local time, so the latest additions are easy to spot.
    valid ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : '')
}

// ---------- selection & list interaction ----------

function select(id, { toggle = false, range = false } = {}) {
  state.cursor = id
  const ids = state.visible.map((i) => i.id)
  if (range && state.anchor && ids.includes(state.anchor)) {
    const [a, b] = [ids.indexOf(state.anchor), ids.indexOf(id)].sort((x, y) => x - y)
    if (!toggle) state.selected.clear()
    for (const x of ids.slice(a, b + 1)) state.selected.add(x)
  } else if (toggle) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id)
    state.anchor = id
  } else {
    state.selected = new Set([id])
    state.anchor = id
  }
  syncSelection()
}

function syncSelection() {
  for (const row of $('rows').children) {
    const on = state.selected.has(row.dataset.id)
    row.classList.toggle('selected', on)
    row.setAttribute('aria-selected', String(on))
    row.querySelector('input').checked = on
  }
  renderChrome()
}

$('rows').addEventListener('click', (e) => {
  const row = e.target.closest('.row')
  if (!row) return
  const viaCheckbox = !!e.target.closest('.cell.check')
  select(row.dataset.id, { toggle: viaCheckbox || e.metaKey || e.ctrlKey, range: e.shiftKey })
})
$('rows').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row')
  if (row && !e.target.closest('.cell.check')) openRefDialog(state.items.find((i) => i.id === row.dataset.id))
})
$('check-all').addEventListener('change', (e) => {
  state.selected = e.target.checked ? new Set(state.visible.map((i) => i.id)) : new Set()
  syncSelection()
})

let searchTimer
function clearSearch() {
  clearTimeout(searchTimer)
  $('search').value = ''
  $('search-clear').hidden = true
  state.query = ''
  render()
}
$('search').addEventListener('input', (e) => {
  $('search-clear').hidden = !e.target.value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); render() }, 80)
})
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { clearSearch(); e.target.blur() }
})
$('search-clear').addEventListener('click', () => { clearSearch(); $('search').focus() })

// Drag references onto a project.
$('rows').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.row')
  if (!row) return
  if (!state.selected.has(row.dataset.id)) select(row.dataset.id)
  e.dataTransfer.setData('application/x-zotlet-ids', JSON.stringify([...state.selected]))
  e.dataTransfer.effectAllowed = 'copy'
})
const projectTarget = (e) => e.target.closest('#project-list .nav-item')
$('project-list').addEventListener('dragover', (e) => {
  const t = projectTarget(e)
  if (!t || !e.dataTransfer.types.includes('application/x-zotlet-ids')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  for (const n of document.querySelectorAll('.nav-item.drop')) if (n !== t) n.classList.remove('drop')
  t.classList.add('drop')
})
$('project-list').addEventListener('dragleave', (e) => { const t = projectTarget(e); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop') })
$('project-list').addEventListener('drop', (e) => {
  const t = projectTarget(e)
  if (!t) return
  e.preventDefault()
  t.classList.remove('drop')
  const ids = JSON.parse(e.dataTransfer.getData('application/x-zotlet-ids') || '[]')
  addToProject(t.dataset.project, ids)
})
document.addEventListener('dragend', () => { for (const n of document.querySelectorAll('.nav-item.drop')) n.classList.remove('drop') })

// ---------- sidebar ----------

document.querySelector('.nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item')
  if (!item) return
  setProject(item.dataset.project)
  render()
  $('rows').scrollTop = 0
})

$('project-new').addEventListener('click', async () => {
  const project = await promptName({ title: 'New project', submit: 'Create', action: (name) => api('projects/create', { name }) })
  if (!project) return
  setProject(project.id)
  await refresh()
  toast(`Created “${project.name}”`)
})
$('project-rename').addEventListener('click', async () => {
  const project = currentProject()
  if (!project) return
  const renamed = await promptName({ title: 'Rename project', submit: 'Rename', value: project.name, action: (name) => api('projects/rename', { id: project.id, name }) })
  if (!renamed) return
  await refresh()
  toast(`Renamed to “${renamed.name}”`)
})
$('project-delete').addEventListener('click', async () => {
  const project = currentProject()
  if (!project) return
  const ok = await confirmAction({ title: 'Delete project', confirm: 'Delete project',
    text: `Delete “${project.name}”? Its ${plural(project.itemIds.length, 'reference')} stay in your library.` })
  if (!ok) return
  try {
    await api('projects/delete', { id: project.id })
    setProject('')
    await refresh()
    toast(`Deleted “${project.name}”`)
  } catch (error) { fail(error) }
})

// ---------- selection actions ----------

async function addToProject(projectId, ids) {
  const project = state.projects.find((p) => p.id === projectId)
  if (!project || !ids.length) return
  try {
    const { added } = await api('projects/add', { id: projectId, itemIds: ids })
    await refresh()
    toast(added ? `Added ${plural(added, 'reference')} to “${project.name}”` : `Already in “${project.name}”`)
  } catch (error) { fail(error) }
}

$('btn-add-to').addEventListener('click', (e) => {
  e.stopPropagation()
  const menu = $('add-to-menu')
  const items = state.projects.filter((p) => p.id !== state.project)
  menu.replaceChildren(...(items.length
    ? items.map((p) => el('button', { role: 'menuitem', onclick: () => { closeMenus(); addToProject(p.id, [...state.selected]) } },
      el('span', { class: 'truncate' }, p.name), el('span', { class: 'muted' }, String(p.itemIds.length))))
    : [el('div', { class: 'menu-empty' }, 'No other projects yet')]),
  el('button', { role: 'menuitem', onclick: async () => {
    closeMenus()
    const ids = [...state.selected]
    const project = await promptName({ title: 'New project', submit: 'Create', action: (name) => api('projects/create', { name }) })
    if (project) { await addToProject(project.id, ids) }
  } }, el('span', {}, '+ New project…')))
  toggleMenu($('btn-add-to'), menu)
})

$('btn-remove-from').addEventListener('click', async () => {
  const project = currentProject()
  if (!project) return
  try {
    const { removed } = await api('projects/remove', { id: project.id, itemIds: [...state.selected] })
    await refresh()
    toast(`Removed ${plural(removed, 'reference')} from “${project.name}”`)
  } catch (error) { fail(error) }
})


async function deleteSelected() {
  const ids = [...state.selected]
  if (!ids.length) return
  const ok = await confirmAction({ title: 'Delete references', confirm: 'Delete',
    text: `Permanently delete ${plural(ids.length, 'reference')} from your library? ${currentProject() ? 'To only take them out of this project, use “Remove from project”.' : 'They are also removed from every project.'}` })
  if (!ok) return
  try {
    const { removed } = await api('items/delete', { ids })
    state.selected.clear()
    await refresh()
    toast(`Deleted ${plural(removed, 'reference')}`)
  } catch (error) { fail(error) }
}
$('btn-delete').addEventListener('click', deleteSelected)

// ---------- menus ----------

function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m.hidden = true
  for (const b of document.querySelectorAll('[aria-haspopup]')) b.setAttribute('aria-expanded', 'false')
}
function toggleMenu(button, menu) {
  const open = menu.hidden
  closeMenus()
  menu.hidden = !open
  button.setAttribute('aria-expanded', String(open))
  if (open) menu.querySelector('button')?.focus({ preventScroll: true })
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus() })

// ---------- export ----------

$('btn-export').addEventListener('click', async () => {
  const { ids, name, label } = scope()
  if (!ids.length) return
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': TOKEN },
      body: JSON.stringify({ format: 'zip', ids, name }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed')
    const disposition = res.headers.get('Content-Disposition') || ''
    const file = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(disposition) || [])[1] || `${name}.zip`)
    downloadBlob(await res.blob(), file)
    toast(`Exported ${label} → ${file}`)
  } catch (error) { fail(error) }
})

// ---------- PDFs dropped on the list: read the DOI, import the reference ----------

async function uploadPdf(file, query = '') {
  let res
  try {
    res = await fetch(`/api/pdf/import${query}`, { method: 'POST', body: file,
      headers: { 'Content-Type': 'application/pdf', 'X-Zotlet-Token': TOKEN, 'X-File-Name': encodeURIComponent(file.name) } })
  } catch { throw new Error('Cannot reach zotlet. Is the server still running?') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function pdfRow(file) {
  const li = el('li', { class: 'pending' })
  const set = (kind, mark, what, fix = []) => {
    li.className = kind
    li.replaceChildren(el('span', { class: 'mark' }, mark), el('span', { class: 'file', title: file.name }, file.name),
      el('span', { class: 'what' }, ...[what].flat()), fix.length ? el('div', { class: 'fix' }, ...fix) : null)
  }
  set('pending', '…', el('span', { class: 'muted' }, 'Reading the DOI and looking it up…'))
  return { li, set }
}

function describe(result, set, retry) {
  const title = el('b', {}, plain(result.title || '(untitled)'))
  if (result.status === 'added') return set('ok', '✓', ['Imported ', title, el('span', { class: 'muted' }, ` · ${result.doi}`)])
  if (result.status === 'duplicate') return set('warn', '•', ['Already in your library: ', title, el('span', { class: 'muted' }, ` · ${result.doi}`)])
  const input = el('input', { type: 'text', value: result.doi || '', placeholder: 'Type the DOI, e.g. 10.1016/j.plaphy.2026.111729', spellcheck: 'false', 'aria-label': 'DOI' })
  const go = el('button', { type: 'button', class: 'btn sm primary', onclick: () => retry(input.value) }, 'Import')
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click() } })
  set('bad', '✗', result.status === 'no-doi' ? 'No DOI found in this PDF' : `The DOI ${result.doi} could not be looked up: ${result.message}`, [input, go])
}

/** A CSL JSON file, e.g. exported from Zotero (File → Export Library… → CSL JSON). */
async function importCslFile(file, project) {
  const row = pdfRow(file)
  $('pdf-results').append(row.li)
  try {
    let items
    try { items = JSON.parse(await file.text()) } catch { throw new Error('This file is not valid JSON') }
    if (!Array.isArray(items)) items = items && typeof items === 'object' && Array.isArray(items.items) ? items.items : [items]
    const r = await api('import-csl', { items, projectId: project?.id || undefined })
    row.set(r.added ? 'ok' : 'warn', r.added ? '✓' : '•', [`Imported ${plural(r.added, 'reference')}`,
      el('span', { class: 'muted' }, [r.duplicates && ` · ${r.duplicates} already in your library`, r.skipped && ` · ${r.skipped} skipped (no title)`].filter(Boolean).join(''))])
    return r.ids[0]
  } catch (error) { row.set('bad', '✗', error.message) }
  return null
}

async function importPdfs(files) {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
  const jsons = files.filter((f) => /\.json$/i.test(f.name) || f.type === 'application/json')
  if (!pdfs.length && !jsons.length) { toast('Drop PDF files or a CSL JSON file', 'error'); return }
  const project = currentProject()
  $('pdf-title').textContent = jsons.length && !pdfs.length ? 'Import CSL JSON' : `Import ${pdfs.length === 1 && !jsons.length ? 'PDF' : `${pdfs.length + jsons.length} files`}`
  $('pdf-results').replaceChildren()
  $('pdf-summary').textContent = project ? `New references are also added to “${project.name}”.` : ''
  if (!$('pdf-dialog').open) $('pdf-dialog').showModal()
  const query = project ? `?projectId=${encodeURIComponent(project.id)}` : ''
  let touched = null
  for (const file of jsons) touched = (await importCslFile(file, project)) || touched
  for (const file of pdfs) {
    const row = pdfRow(file)
    $('pdf-results').append(row.li)
    const retry = async (text) => {
      try {
        const { results } = await api('import', { text, projectId: project?.id || undefined })
        const r = results[0]
        if (!r || r.status === 'error') throw new Error(r?.message || 'Not a DOI')
        await refresh()
        describe({ status: r.status, title: r.title, doi: text.trim() }, row.set, retry)
        flashRow(r.id)
      } catch (error) { toast(error.message, 'error') }
    }
    try {
      const result = await uploadPdf(file, query)
      describe(result, row.set, retry)
      touched = result.id || touched
    } catch (error) {
      row.set('bad', '✗', error.message)
    }
  }
  await refresh()
  if (touched) flashRow(touched)
}

function flashRow(id) {
  const row = document.querySelector(`.rows .row[data-id="${CSS.escape(id)}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'nearest' })
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash')
}

// Drag PDFs from Finder / Explorer onto the list (internal row drags carry no files).
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
let dragDepth = 0
function clearDrop() { dragDepth = 0; $('drop-hint').hidden = true }
const table = document.querySelector('.table')
table.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop-hint').hidden = false })
table.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) clearDrop() })
table.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
table.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  clearDrop()
  importPdfs([...e.dataTransfer.files])
})
// Dropping a file anywhere else must not make the browser navigate away to it.
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
window.addEventListener('drop', (e) => { if (hasFiles(e)) { e.preventDefault(); clearDrop() } })

// ---------- citation styles (repository) ----------

const FORMAT_NAMES = { 'author-date': 'author-date', numeric: 'numeric', note: 'note', label: 'label', author: 'author' }
let styleSearchTimer = null, styleSearchSeq = 0

function setStyleList(styles) {
  state.styles = styles
  renderInstalledStyles()
}

function styleActions(...buttons) { return el('div', { class: 'style-actions' }, ...buttons) }

function renderStyleResults({ total, results }, query) {
  const list = $('style-results')
  list.replaceChildren()
  $('style-status').textContent = !total ? `No styles match “${query}”.`
    : `${total.toLocaleString()} style${total === 1 ? '' : 's'}${query ? ` match “${query}”` : ''}${total > results.length ? ` · showing the first ${results.length}, type more to narrow down` : ''}`
  for (const r of results) {
    const meta = [FORMAT_NAMES[r.format] || r.format, r.fields.join(', '), r.dependent ? 'journal style' : 'independent style', r.updated && `updated ${r.updated}`].filter(Boolean).join(' · ')
    const install = el('button', { type: 'button', class: 'btn sm primary', onclick: async () => {
      install.disabled = true
      install.textContent = 'Installing…'
      showError($('styles-dialog'), '')
      try {
        const res = await api('styles/install', { name: r.name })
        setStyleList(res.styles)
        r.installed = true
        install.replaceWith(el('span', { class: 'badge' }, 'Installed'))
        const parent = res.installed.parent && res.styles.find((x) => x.id === res.installed.parent)
        toast(`Installed “${res.installed.title}”${parent ? ` (based on ${parent.label})` : ''} · choose it in Word/GenOffice under Document Preferences`)
      } catch (error) {
        install.disabled = false
        install.textContent = 'Install'
        showError($('styles-dialog'), error.message)
      }
    } }, 'Install')
    list.append(el('li', {},
      el('div', { class: 'style-text' }, el('span', { class: 'style-name', title: r.title }, r.title), el('span', { class: 'style-meta', title: meta }, meta)),
      styleActions(r.installed ? el('span', { class: 'badge' }, r.builtin ? 'Built-in' : 'Installed') : install)))
  }
}

async function searchStyles(refresh = false) {
  const query = $('style-query').value.trim()
  const seq = ++styleSearchSeq
  $('style-status').textContent = refresh ? 'Downloading the style list…' : 'Searching…'
  showError($('styles-dialog'), '')
  try {
    const result = await api('styles/search', { query, refresh })
    if (seq === styleSearchSeq) renderStyleResults(result, query)
  } catch (error) {
    if (seq !== styleSearchSeq) return
    $('style-status').textContent = ''
    $('style-results').replaceChildren()
    showError($('styles-dialog'), `${error.message}. Check your internet connection, or add a .csl file you downloaded yourself.`)
  }
}

function renderInstalledStyles() {
  const list = $('style-installed')
  list.replaceChildren()
  $('styles-installed-count').textContent = String(state.styles.length)
  const byId = new Map(state.styles.map((s) => [s.id, s]))
  for (const s of state.styles) {
    const usedBy = state.styles.filter((d) => d.parent === s.id)
    const meta = [s.builtin ? 'built-in' : 'installed by you', s.format, s.parent && `uses ${byId.get(s.parent)?.label || s.parent}`,
      usedBy.length && `needed by ${usedBy.length} journal style${usedBy.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
    const buttons = []
    if (!s.builtin) {
      buttons.push(el('button', { type: 'button', class: 'btn sm danger', disabled: usedBy.length > 0, title: usedBy.length ? 'Remove the journal styles that use it first' : '', onclick: async () => {
        showError($('styles-dialog'), '')
        try {
          const res = await api('styles/remove', { id: s.id })
          setStyleList(res.styles)
          toast(`Removed “${s.title}”`)
        } catch (error) { showError($('styles-dialog'), error.message) }
      } }, 'Remove'))
    }
    list.append(el('li', {},
      el('div', { class: 'style-text' }, el('span', { class: 'style-name', title: s.title }, s.title), el('span', { class: 'style-meta' }, meta)),
      styleActions(...buttons)))
  }
}

function setStylesTab(name) {
  for (const b of $('styles-tabs').children) b.classList.toggle('active', b.dataset.tab === name)
  for (const p of $('styles-dialog').querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name
  showError($('styles-dialog'), '')
  if (name === 'get') setTimeout(() => $('style-query').focus(), 0)
}

function openStylesDialog() {
  setStylesTab('get')
  renderInstalledStyles()
  $('styles-dialog').showModal()
  searchStyles()
}

$('btn-styles').addEventListener('click', openStylesDialog)
$('styles-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setStylesTab(b.dataset.tab) })
$('style-query').addEventListener('input', () => { clearTimeout(styleSearchTimer); styleSearchTimer = setTimeout(() => searchStyles(), 250) })
$('style-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(styleSearchTimer); searchStyles() } })
$('style-add-file').addEventListener('click', () => $('style-file').click())
$('style-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  showError($('styles-dialog'), '')
  try {
    const res = await api('styles/add', { xml: await file.text() })
    setStyleList(res.styles)
    setStylesTab('installed')
    toast(`Added “${res.installed.title}”`)
  } catch (error) { showError($('styles-dialog'), error.message) }
})

// ---------- dialogs ----------

function showError(container, message) {
  const box = container.querySelector('[data-error]')
  box.textContent = message
  box.hidden = !message
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dialog.close()
    // Backdrop click (outside the dialog box) closes it.
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close()
    }
  })
}

/** Ask for a name; `action(name)` runs on submit and may throw to keep the dialog open. */
function promptName({ title, submit, value = '', action }) {
  const dialog = $('name-dialog'), form = $('name-form'), input = $('name-input')
  $('name-title').textContent = title
  $('name-submit').textContent = submit
  input.value = value
  showError(dialog, '')
  dialog.showModal()
  input.select()
  return new Promise((resolve) => {
    let result = null
    const onSubmit = async (e) => {
      e.preventDefault()
      $('name-submit').disabled = true
      try { result = await action(input.value); dialog.close() }
      catch (error) { showError(dialog, error.message); input.focus() }
      finally { $('name-submit').disabled = false }
    }
    form.addEventListener('submit', onSubmit)
    dialog.addEventListener('close', () => { form.removeEventListener('submit', onSubmit); resolve(result) }, { once: true })
  })
}

function confirmAction({ title, text, confirm }) {
  const dialog = $('confirm-dialog')
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-ok').textContent = confirm
  dialog.returnValue = ''
  dialog.showModal()
  $('confirm-ok').focus()
  return new Promise((resolve) => {
    const ok = () => dialog.close('ok')
    $('confirm-ok').addEventListener('click', ok)
    dialog.addEventListener('close', () => { $('confirm-ok').removeEventListener('click', ok); resolve(dialog.returnValue === 'ok') }, { once: true })
  })
}

// ---------- add / edit reference ----------

let editing = null // item being edited, or null when adding

function setTab(name) {
  for (const b of $('ref-tabs').children) b.classList.toggle('active', b.dataset.tab === name)
  for (const p of $('ref-dialog').querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name
  const focus = name === 'import' ? $('import-text') : $('manual-form').elements.title
  setTimeout(() => focus.focus(), 0)
}
$('ref-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab) })

const dateToText = (d) => (d?.['date-parts']?.[0] || []).map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('-') || d?.literal || ''
const namesToText = (names = []) => names.map((n) => (n.literal ? `{${n.literal}}`
  : [[n['non-dropping-particle'], n.family].filter(Boolean).join(' '), [n.given, n['dropping-particle']].filter(Boolean).join(' '), n.suffix].filter(Boolean).join(', '))).join('\n')

function textToNames(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const literal = /^\{(.+)\}$/.exec(line)
    if (literal) return { literal: literal[1].trim() }
    if (line.includes(',')) {
      const [family, given, suffix] = line.split(',').map((s) => s.trim())
      return Object.fromEntries(Object.entries({ family, given, suffix }).filter(([, v]) => v))
    }
    const parts = line.split(/\s+/)
    if (parts.length === 1) return { family: parts[0] }
    return { family: parts.pop(), given: parts.join(' ') }
  })
}
function textToDate(text) {
  const t = text.trim()
  if (!t) return null
  const m = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/.exec(t)
  if (!m) throw new Error('Enter the date as YYYY, YYYY-MM or YYYY-MM-DD')
  const parts = [m[1], m[2], m[3]].filter(Boolean).map(Number)
  if (parts[1] && (parts[1] < 1 || parts[1] > 12)) throw new Error('The month must be between 1 and 12')
  if (parts[2] && (parts[2] < 1 || parts[2] > 31)) throw new Error('The day must be between 1 and 31')
  return { 'date-parts': [parts] }
}

const FORM_FIELDS = ['title', 'author', 'type', 'issued', 'container-title', 'volume', 'issue', 'page', 'DOI', 'PMID', 'publisher', 'URL', 'abstract']
function itemToForm(item = {}) {
  return Object.fromEntries(FORM_FIELDS.map((k) => [k,
    k === 'author' ? namesToText(item.author) : k === 'issued' ? dateToText(item.issued) : k === 'type' ? (item.type || 'article-journal') : String(item[k] ?? '')]))
}

function openRefDialog(item = null) {
  editing = item
  const dialog = $('ref-dialog'), form = $('manual-form')
  const project = currentProject()
  $('ref-dialog-title').textContent = item ? 'Edit reference' : 'Add references'
  $('ref-tabs').hidden = !!item
  $('manual-submit').textContent = item ? 'Save changes' : 'Add reference'
  $('manual-key').hidden = !item
  if (item) $('manual-key').replaceChildren('Citation key ', el('code', {}, item.id), ' — kept stable when you edit.')
  $('manual-hint').textContent = !item && project ? `Will also be added to “${project.name}”.` : ''
  $('import-target').hidden = !project
  $('import-target').textContent = project ? `Imported references will also be added to “${project.name}”.` : ''
  const values = itemToForm(item || {})
  // Unknown types (e.g. "review") are shown as-is instead of silently changing.
  const typeSelect = form.elements.type
  typeSelect.querySelector('[data-extra]')?.remove()
  if (![...typeSelect.options].some((o) => o.value === values.type)) typeSelect.append(el('option', { value: values.type, dataset: { extra: '1' } }, values.type))
  for (const k of FORM_FIELDS) form.elements[k].value = values[k]
  form.dataset.initial = JSON.stringify(values)
  showError(form, '')
  showError($('import-form'), '')
  if (!item) { $('import-text').value = ''; $('import-results').hidden = true; $('import-results').replaceChildren() }
  dialog.showModal()
  setTab(item ? 'manual' : 'import')
}
$('btn-new').addEventListener('click', () => openRefDialog())

$('manual-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target, initial = JSON.parse(form.dataset.initial)
  showError(form, '')
  try {
    const values = Object.fromEntries(FORM_FIELDS.map((k) => [k, form.elements[k].value]))
    if (!values.title.trim()) { form.elements.title.focus(); throw new Error('A title is required') }
    // Only send what changed, so fields the form cannot represent survive an edit.
    const fields = {}
    for (const k of FORM_FIELDS) {
      if (editing && values[k] === initial[k]) continue
      fields[k] = k === 'author' ? textToNames(values[k]) : k === 'issued' ? textToDate(values[k]) : values[k].trim() || null
    }
    $('manual-submit').disabled = true
    if (editing) {
      if (Object.keys(fields).length) await api('items/update', { id: editing.id, fields })
      $('ref-dialog').close()
      await refresh()
      toast('Reference saved')
    } else {
      const result = await api('items/create', { fields, projectId: state.project || undefined })
      $('ref-dialog').close()
      await refresh()
      reveal(result.id)
      toast(`Added ${result.id}`)
    }
  } catch (error) { showError(form, error.message) }
  finally { $('manual-submit').disabled = false }
})

$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target, text = $('import-text').value
  showError(form, '')
  if (!text.trim()) { $('import-text').focus(); return showError(form, 'Paste at least one DOI or PMID') }
  const list = $('import-results')
  list.hidden = false
  list.replaceChildren(el('li', { class: 'pending' }, el('span', { class: 'mark' }, '…'), el('span', { class: 'ident' }, 'Looking up'), el('span', { class: 'detail muted' }, 'Contacting doi.org / PubMed…')))
  $('import-submit').disabled = true
  try {
    const { results } = await api('import', { text, projectId: state.project || undefined })
    list.replaceChildren(...results.map((r) => el('li', { class: r.status === 'error' ? 'failed' : r.status },
      el('span', { class: 'mark' }, r.status === 'added' ? '✓' : r.status === 'duplicate' ? '•' : '✕'),
      el('span', { class: 'ident truncate', title: r.input }, r.input),
      el('span', { class: 'detail', title: r.title || r.message || '' },
        r.status === 'error' ? r.message : r.status === 'duplicate' ? `Already in library as ${r.id}` : plain(r.title)))))
    const added = results.filter((r) => r.status === 'added').length
    const dupes = results.filter((r) => r.status === 'duplicate').length
    const errors = results.length - added - dupes
    await refresh()
    const ok = results.filter((r) => r.status !== 'error').map((r) => r.id)
    if (ok.length) reveal(...ok)
    if (!errors) { $('import-text').value = '' }
    else { $('import-text').value = results.filter((r) => r.status === 'error').map((r) => r.input).join('\n') }
    if (!$('ref-dialog').open) toast([added && `Imported ${plural(added, 'reference')}`, dupes && `${dupes} already present`, errors && `${errors} failed`].filter(Boolean).join(' · '), errors && !added ? 'error' : '')
  } catch (error) {
    list.hidden = true
    showError(form, error.message)
  } finally { $('import-submit').disabled = false }
})
$('import-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('import-form').requestSubmit() }
})

/** Select and scroll to freshly added rows. */
function reveal(...ids) {
  const visible = new Set(state.visible.map((i) => i.id))
  const shown = ids.filter((id) => visible.has(id))
  if (!shown.length) return
  state.selected = new Set(shown)
  state.anchor = shown[0]
  syncSelection()
  const row = [...$('rows').children].find((r) => r.dataset.id === shown[0])
  row?.scrollIntoView({ block: 'nearest' })
  for (const r of $('rows').children) if (state.selected.has(r.dataset.id)) r.classList.add('flash')
}

// ---------- theme ----------

$('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  store.set('zotlet-theme', next)
})

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return
  const typing = e.target.closest('input, textarea, select')
  if (e.key === 'Escape') {
    closeMenus()
    if (!typing && state.selected.size) { state.selected.clear(); syncSelection() }
    return
  }
  if (typing) return
  const mod = e.metaKey || e.ctrlKey
  if (e.key === '/' || (mod && e.key.toLowerCase() === 'f')) { e.preventDefault(); $('search').focus(); $('search').select() }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); state.selected = new Set(state.visible.map((i) => i.id)); syncSelection() }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) { e.preventDefault(); deleteSelected() }
  else if (e.key === 'Enter' && state.selected.size === 1) { e.preventDefault(); openRefDialog(state.items.find((i) => state.selected.has(i.id))) }
  else if (!mod && e.key.toLowerCase() === 'n') { e.preventDefault(); openRefDialog() }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const ids = state.visible.map((i) => i.id)
    if (!ids.length) return
    const current = state.cursor && ids.includes(state.cursor) ? ids.indexOf(state.cursor) : -1
    const next = Math.max(0, Math.min(ids.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)))
    select(ids[next], { range: e.shiftKey })
    ;[...$('rows').children][next]?.scrollIntoView({ block: 'nearest' })
  }
})

// Pick up changes made elsewhere (CLI, another tab) when the window regains focus.
window.addEventListener('focus', () => { if (!document.querySelector('dialog[open]')) refresh().catch(() => {}) })

refresh().catch(fail)
