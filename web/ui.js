const token = document.querySelector('meta[name="zotlet-token"]').content
export const $ = (id) => document.getElementById(id)
export async function api(route, body) {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-zotlet-token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`)
  return value
}
export function el(tag, className = '', text = '') { const node = document.createElement(tag); node.className = className; node.textContent = text; return node }
export function button(text, action, className = 'small') {
  const node = el('button', className, text)
  node.type = 'button'; node.addEventListener('click', async () => { try { await action() } catch (error) { toast(error.message) } })
  return node
}
let toastTimer
export function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000) }
export const author = (item) => (item.author || []).map((name) => name.family || name.literal || '').filter(Boolean).join(', ')
export const year = (item) => item.issued?.['date-parts']?.[0]?.[0] || 'n.d.'
export const bytes = (value) => value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
export async function copy(value) { await navigator.clipboard.writeText(value); toast('Path copied') }
export function badge(text, tone = '') { return el('span', `badge ${tone}`, text) }
