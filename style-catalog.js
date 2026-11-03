// Built-in resources stay in the program directory; user styles live with user data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { styleMetadata } from './web/xml.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DATA_HOME = path.join(process.env.ZOTLET_HOME || os.homedir(), '.zotlet')
export const BUILTIN_STYLES = path.join(HERE, 'styles')
export const USER_STYLES = path.join(DATA_HOME, 'styles')
const FIRST = ['nature', 'science', 'cell']
const safe = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id)
export function styleFile(id) {
  if (!safe(id)) return null
  for (const directory of [BUILTIN_STYLES, USER_STYLES]) {
    const file = path.join(directory, `${id}.csl`)
    if (fs.existsSync(file) && fs.lstatSync(file).isFile()) return file
  }
  return null
}
export const hasStyle = (id) => !!styleFile(id)
export function styleURI(id) { return FIRST.includes(id) ? `http://www.zotero.org/styles/${id}` : styleMetadata(readStyle(id)).uri }
export function resolveStyle(uri) {
  if (typeof uri !== 'string') return null
  const value = uri.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), suffix = value.split('/').pop()
  if (hasStyle(suffix)) return suffix
  // Keep an unknown stored suffix: legacy refresh falls back without rewriting it.
  return styleCatalog().find((entry) => entry.uri === value)?.id || suffix
}
export function readStyle(id) {
  const file = styleFile(id)
  if (!file) throw new Error(`Style "${id}" is not installed. Put ${id}.csl into ${BUILTIN_STYLES}.`)
  return fs.readFileSync(file, 'utf8')
}
export function styleCatalog() {
  const ids = new Set()
  for (const directory of [BUILTIN_STYLES, USER_STYLES]) {
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.csl') && safe(name.slice(0, -4)) && styleFile(name.slice(0, -4))) ids.add(name.slice(0, -4))
    }
  }
  return [...ids].sort((a, b) => ((FIRST.indexOf(a) + 1 || 99) - (FIRST.indexOf(b) + 1 || 99)) || a.localeCompare(b)).flatMap((id) => {
    const file = styleFile(id), xml = fs.readFileSync(file, 'utf8')
    try {
      const meta = styleMetadata(xml)
      return [{ id, title: meta.title, uri: meta.uri, builtin: path.dirname(file) === BUILTIN_STYLES, path: file }]
    } catch (error) {
      if (path.dirname(file) === BUILTIN_STYLES) throw error
      return []
    }
  })
}
