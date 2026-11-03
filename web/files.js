// Read-only PDF discovery. Hashes identify copies/moves; filenames only suggest links.
import fs from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const within = (file, folder) => { const relative = path.relative(folder, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }
const idFor = (file) => createHash('sha256').update(file).digest('hex').slice(0, 24)
const hashFile = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) })) hash.update(chunk)
  return hash.digest('hex')
}
export async function inspectPdf(file, previous, root) {
  const stat = await fs.lstat(file)
  if (!stat.isFile()) throw new Error('Not a regular file')
  const hash = previous?.size === stat.size && previous?.mtimeMs === stat.mtimeMs && previous?.ctimeMs === stat.ctimeMs && previous.hash ? previous.hash : await hashFile(file)
  const after = await fs.lstat(file)
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('File changed while being checked; check again')
  return { id: previous?.id || idFor(file), path: file, root, name: path.basename(file), size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash, status: 'available', movedFrom: previous?.movedFrom || null }
}
export async function scanFiles(roots, previous, progress, cancelled = () => false) {
  const oldByPath = new Map(previous.map((file) => [file.path, file])), found = new Map(), errors = [], visited = new Set()
  let skipped = 0
  for (const root of roots) {
    const folders = [root]
    while (folders.length) {
      if (cancelled()) throw new Error('File check cancelled')
      const folder = folders.pop()
      if (visited.has(folder)) continue
      visited.add(folder)
      try {
        if (!(await fs.lstat(folder)).isDirectory()) throw new Error('Folder is no longer a regular directory')
        const entries = await fs.opendir(folder)
        for await (const entry of entries) {
          const file = path.join(folder, entry.name)
          if (entry.isSymbolicLink()) { skipped++; continue }
          if (entry.isDirectory()) folders.push(file)
          else if (entry.isFile() && /\.pdf$/i.test(entry.name) && !found.has(file)) {
            try { found.set(file, await inspectPdf(file, oldByPath.get(file), root)) }
            catch (error) { errors.push({ path: file, message: error.message }) }
            progress({ checked: found.size, current: file })
          }
        }
      } catch (error) { errors.push({ path: folder, message: error.message }) }
    }
  }
  for (const old of previous) {
    if (cancelled()) throw new Error('File check cancelled')
    if (found.has(old.path) || old.status === 'moved') continue
    try { found.set(old.path, await inspectPdf(old.path, old, old.root)) }
    catch (error) {
      const blocked = errors.some((entry) => within(old.path, entry.path))
      found.set(old.path, { ...old, status: error.code === 'ENOENT' && !blocked ? 'missing' : 'unavailable', error: error.message })
    }
  }
  const files = [...found.values()], moves = []
  for (const file of files.filter((entry) => entry.status === 'missing' && entry.hash)) {
    const candidates = files.filter((entry) => entry.status === 'available' && entry.hash === file.hash && entry.path !== file.path)
    if (candidates.length === 1) {
      file.status = 'moved'; file.movedTo = candidates[0].id
      candidates[0].movedFrom = file.path
      moves.push({ from: file.id, to: candidates[0].id })
    } else if (candidates.length) file.possibleCopies = candidates.map((entry) => entry.id)
  }
  return { files, moves, errors, skipped }
}
const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
export function fileSuggestions(items, files) {
  const lookup = new Map()
  for (const item of items) for (const value of [item.id, item.title]) {
    const key = normalize(value)
    if (key.length >= 5) lookup.set(key, [...(lookup.get(key) || []), item.id])
  }
  return Object.fromEntries(files.filter((file) => file.status === 'available').map((file) =>
    [file.id, [...new Set(lookup.get(normalize(file.name.replace(/\.pdf$/i, ''))) || [])]]))
}
