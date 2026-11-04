// Citation / style picker opened by the word processor integration (src/integration.js).
// The server opens /pick.html?id=… and waits until this page answers or is closed.

const $ = (id) => document.getElementById(id)
const TOKEN = document.querySelector('meta[name="zotlet-token"]').content
const ID = new URLSearchParams(location.search).get('id') || ''
const store = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch { /* private mode */ } },
}

async function api(path, body) {
  let res
  try {
    res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': TOKEN }, body: JSON.stringify(body) })
  } catch { throw new Error('Cannot reach zotlet. Is the server still running?') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))
  return node
}
const plain = (s) => String(s ?? '').replace(/<[^>]+>/g, '')
const yearOf = (i) => i.issued?.['date-parts']?.[0]?.[0] ?? i.issued?.literal ?? ''
const nameOf = (n) => n.literal || [n['non-dropping-particle'], n.family].filter(Boolean).join(' ')
function authorsShort(item) {
  const a = item.author || item.editor || []
  if (!a.length) return ''
  if (a.length === 1) return nameOf(a[0])
  if (a.length === 2) return `${nameOf(a[0])} & ${nameOf(a[1])}`
  return `${nameOf(a[0])} et al.`
}
// Restricted rich-text: only <i>, <b>, <sub>, <sup> become elements, everything else is text.
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
const haystack = (item) => [item.id, plain(item.title), item['container-title'], item['container-title-short'], yearOf(item), item.DOI, item.PMID,
  ...(item.author || []).map((n) => `${n.given || ''} ${nameOf(n)}`), ...(item.editor || []).map(nameOf)].join(' ').toLowerCase()

const state = { data: null, chosen: [], cursor: 0, visible: [], finished: false }

// ---------- citation mode ----------

function filtered() {
  const { items, projects } = state.data
  const project = projects.find((p) => p.id === $('pick-project').value)
  const inProject = project ? new Set(project.itemIds) : null
  const words = $('pick-search').value.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => (!inProject || inProject.has(item.id)) && words.every((w) => item._hay.includes(w)))
}

function renderItems() {
  state.visible = filtered()
  state.cursor = Math.min(state.cursor, Math.max(0, state.visible.length - 1))
  const rows = $('pick-rows')
  rows.replaceChildren()
  if (!state.visible.length) {
    rows.append(el('div', { class: 'empty' }, el('strong', {}, 'No matching references'),
      el('p', {}, $('pick-search').value ? 'Try other words, or choose “All references”.' : 'This project is empty.')))
  }
  state.visible.forEach((item, k) => {
    const on = state.chosen.includes(item.id)
    const title = el('div', { class: 'cell title', title: plain(item.title) })
    title.append(richTitle(item.title || '(untitled)'))
    const journal = el('div', { class: 'cell journal' })
    journal.append(richTitle(item['container-title'] || item.publisher || ''))
    rows.append(el('div', { class: `row${on ? ' selected' : ''}${k === state.cursor ? ' cursor' : ''}`, role: 'option', 'aria-selected': String(on),
      'data-id': item.id, onclick: () => { state.cursor = k; toggle(item.id) }, ondblclick: () => { if (!state.chosen.includes(item.id)) toggle(item.id); submit() } },
    el('div', { class: 'cell check' }, el('input', { type: 'checkbox', tabindex: '-1', 'aria-label': 'Select', checked: on })),
    title,
    el('div', { class: 'cell authors' }, authorsShort(item)),
    el('div', { class: 'cell year num' }, String(yearOf(item))),
    journal))
  })
  const total = state.data.items.length
  $('pick-count').textContent = state.visible.length === total ? `${total}` : `${state.visible.length} of ${total}`
  renderChosen()
}

function renderChosen() {
  const box = $('pick-chosen')
  box.replaceChildren()
  if (!state.chosen.length) box.append('Nothing selected')
  const byId = new Map(state.data.items.map((i) => [i.id, i]))
  for (const id of state.chosen) {
    const item = byId.get(id)
    const label = `${authorsShort(item) || plain(item.title).slice(0, 30)} ${yearOf(item)}`.trim()
    box.append(el('span', { class: 'chip', title: plain(item.title) }, el('span', {}, label),
      el('button', { type: 'button', 'aria-label': `Remove ${label}`, onclick: () => toggle(id) }, '×')))
  }
  $('pick-ok').disabled = !state.chosen.length
}

function toggle(id) {
  const k = state.chosen.indexOf(id)
  if (k >= 0) state.chosen.splice(k, 1); else state.chosen.push(id)
  renderItems()
}

// ---------- style mode ----------

function renderStyles() {
  const rows = $('pick-rows')
  rows.replaceChildren()
  state.visible = state.data.styles
  state.data.styles.forEach((s, k) => {
    const on = s.id === state.data.style
    rows.append(el('div', { class: `row style-row${on ? ' selected' : ''}${k === state.cursor ? ' cursor' : ''}`, role: 'option', 'aria-selected': String(on),
      onclick: () => { state.cursor = k; state.data.style = s.id; renderStyles() }, ondblclick: () => { state.data.style = s.id; submit() } },
    el('div', { class: 'cell check' }, el('input', { type: 'radio', name: 'style', tabindex: '-1', 'aria-label': s.label, checked: on })),
    el('div', { class: 'cell title' }, s.label),
    el('div', { class: 'cell journal' }, s.title === s.label ? '' : s.title)))
  })
  $('pick-count').textContent = ''
  $('pick-ok').disabled = false
}

// ---------- shared ----------

function finish(message, detail) {
  state.finished = true
  document.body.classList.add('done')
  $('pick-rows').hidden = true
  $('pick-bookmarks').hidden = true
  $('pick-count').textContent = ''
  const box = $('pick-message')
  box.replaceChildren(el('strong', {}, message), el('p', {}, detail))
  box.hidden = false
  setTimeout(() => window.close(), 600)
}

async function submit() {
  if (state.finished) return
  const cite = state.data.mode === 'cite'
  if (cite && !state.chosen.length) return
  $('pick-ok').disabled = true
  try {
    const bookmarks = $('pick-bookmarks').hidden ? undefined : $('pick-bookmarks').querySelector('input').checked
    await api('pick/done', cite ? { id: ID, ids: state.chosen, style: state.data.askStyle ? $('pick-style').value : undefined }
      : { id: ID, style: state.data.style, bookmarks })
    finish(cite ? 'Citation sent to your document' : 'Document style updated', 'Switch back to your word processor. You can close this tab.')
  } catch (error) {
    $('pick-ok').disabled = false
    alert(error.message)
  }
}

async function cancel() {
  if (state.finished) return
  await api('pick/done', { id: ID, cancel: true }).catch(() => {})
  finish('Cancelled', 'Nothing was changed. You can close this tab.')
}

function moveCursor(delta) {
  if (!state.visible.length) return
  state.cursor = Math.max(0, Math.min(state.visible.length - 1, state.cursor + delta))
  if (state.data.mode === 'cite') renderItems(); else renderStyles()
  document.querySelector('#pick-rows .row.cursor')?.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('keydown', (e) => {
  if (state.finished || !state.data) return
  if (e.key === 'Escape') { e.preventDefault(); cancel() }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(e.key === 'ArrowDown' ? 1 : -1) }
  else if (e.key === 'Enter') {
    e.preventDefault()
    if (state.data.mode === 'cite') {
      // Enter with nothing selected picks the highlighted row first.
      if (!state.chosen.length && state.visible[state.cursor]) state.chosen.push(state.visible[state.cursor].id)
      submit()
    } else { if (state.visible[state.cursor]) state.data.style = state.visible[state.cursor].id; submit() }
  } else if (e.key === ' ' && e.target !== $('pick-search')) {
    e.preventDefault()
    const row = state.visible[state.cursor]
    if (!row) return
    if (state.data.mode === 'cite') toggle(row.id); else { state.data.style = row.id; renderStyles() }
  }
})

// Closing the tab without choosing releases the word processor right away.
window.addEventListener('pagehide', () => {
  if (state.finished || !state.data) return
  try {
    fetch('/api/pick/done', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': TOKEN }, body: JSON.stringify({ id: ID, cancel: true }) })
  } catch { /* page is going away */ }
})

async function init() {
  $('pick-cancel').addEventListener('click', cancel)
  $('pick-ok').addEventListener('click', submit)
  try {
    state.data = await api('pick/get', { id: ID })
  } catch (error) {
    $('pick-search-box').hidden = true
    $('pick-project').hidden = true
    $('pick-style').hidden = true
    finish('Nothing to do here', error.message)
    return
  }
  const data = state.data
  if (data.mode === 'style') {
    document.title = 'zotlet — document style'
    $('pick-title').textContent = 'Citation style for this document'
    $('pick-search-box').hidden = true
    $('pick-project').hidden = true
    $('pick-style').hidden = true
    $('pick-chosen').hidden = true
    $('pick-ok').textContent = 'Apply'
    if (typeof data.bookmarks === 'boolean') {
      const box = $('pick-bookmarks'), input = box.querySelector('input')
      input.checked = data.bookmarks
      input.disabled = data.bookmarksLocked
      box.title = data.bookmarksLocked ? 'Can only be chosen before the first citation is inserted'
        : 'Bookmarks work in both Word and LibreOffice/GenOffice with Zotero'
      box.hidden = false
    }
    state.cursor = Math.max(0, data.styles.findIndex((s) => s.id === data.style))
    renderStyles()
    $('pick-rows').focus()
    return
  }
  for (const item of data.items) item._hay = haystack(item)
  // Newest additions first, like the library list.
  data.items.reverse()
  state.chosen = data.selected.filter((id) => data.items.some((i) => i.id === id))
  if (state.chosen.length) $('pick-title').textContent = 'Edit citation'
  $('pick-ok').textContent = state.chosen.length ? 'Update' : 'Insert'
  $('pick-project').replaceChildren(el('option', { value: '' }, 'All references'),
    ...data.projects.map((p) => el('option', { value: p.id }, `${p.name} (${p.itemIds.length})`)))
  const lastProject = store.get('zotlet-project')
  if (lastProject && data.projects.some((p) => p.id === lastProject)) $('pick-project').value = lastProject
  $('pick-style').replaceChildren(...data.styles.map((s) => el('option', { value: s.id }, s.label)))
  $('pick-style').value = data.style
  // Like Zotero: the style is chosen with the first citation, later via Document Preferences.
  $('pick-style').hidden = !data.askStyle
  $('pick-search').addEventListener('input', () => { state.cursor = 0; renderItems() })
  $('pick-project').addEventListener('change', () => { state.cursor = 0; renderItems() })
  renderItems()
  $('pick-search').focus()
}

init()
