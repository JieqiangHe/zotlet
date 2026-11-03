import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { DATA_HOME } from '../style-catalog.js'
import { loadLib, LIB } from '../session.js'
import { scanFiles, fileSuggestions } from './files.js'

const fresh = () => ({ version: 1, roots: [], files: [], links: {}, checkEveryDays: 0, lastCheck: null, errors: [], skipped: 0, projects: [], activeProject: null })
export async function createStore({ home = DATA_HOME, now = () => Date.now() } = {}) {
  const stateFile = path.join(home, 'web-state.json')
  let state
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    if (state.version !== 1 || !Array.isArray(state.roots) || !Array.isArray(state.files) || !state.links || typeof state.links !== 'object') throw new Error('Unsupported web-state.json format')
    if (!Array.isArray(state.projects)) state.projects = []
    if (state.activeProject === undefined) state.activeProject = null
  } catch (error) { if (error.code !== 'ENOENT') throw error; state = fresh() }
  let writes = Promise.resolve(), running = null, stopped = false
  const mutate = (change) => {
    const task = writes.then(async () => {
      const next = structuredClone(state)
      change(next)
      await fs.mkdir(home, { recursive: true })
      const temp = path.join(home, `.web-${randomUUID()}.tmp`)
      try { await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temp, stateFile) }
      finally { await fs.rm(temp, { force: true }) }
      state = next
    })
    writes = task.catch(() => {})
    return task
  }
  let job = { running: false, checked: 0, current: '', error: null }
  const snapshot = () => {
    const counts = new Map()
    for (const file of state.files) if (file.status === 'available') counts.set(file.hash, (counts.get(file.hash) || 0) + 1)
    const items = loadLib(), files = state.files.map((file) => ({ ...file,
      copies: file.status === 'available' ? counts.get(file.hash) : 0 }))
    return { ...structuredClone(state), files, items, libraryPath: LIB, statePath: stateFile,
      suggestions: fileSuggestions(items, files), job: { ...job } }
  }
  const startCheck = () => {
    if (running) throw new Error('A file check is already running')
    if (stopped) throw new Error('The local page is shutting down')
    if (!state.roots.length && !state.files.length) throw new Error('Add a folder before checking files')
    job = { running: true, checked: 0, current: '', error: null }
    const roots = [...state.roots], previous = structuredClone(state.files)
    running = (async () => {
      try {
        const result = await scanFiles(roots, previous, (value) => { job = { ...job, ...value } }, () => stopped)
        if (stopped) return
        await mutate((next) => {
          next.files = result.files; next.errors = result.errors; next.skipped = result.skipped; next.lastCheck = new Date(now()).toISOString()
          for (const move of result.moves) for (const key of Object.keys(next.links)) next.links[key] = [...new Set(next.links[key].map((id) => id === move.from ? move.to : id))]
        })
      } catch (error) { job.error = error.message }
      finally { job.running = false; job.current = ''; running = null }
    })()
    return { ...job }
  }
  return {
    snapshot, startCheck, progress: () => ({ ...job }),
    async addRoot(value) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Enter an absolute folder path')
      const requested = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
      if (!path.isAbsolute(requested)) throw new Error('Enter an absolute folder path')
      const folder = await fs.realpath(requested)
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder')
      await mutate((next) => { if (!next.roots.includes(folder)) next.roots.push(folder) })
      return snapshot()
    },
    async removeRoot(folder) { await mutate((next) => { next.roots = next.roots.filter((root) => root !== folder) }); return snapshot() },
    async setInterval(days) {
      if (![0, 1, 7, 30].includes(days)) throw new Error('Choose manual, daily, weekly or monthly checks')
      await mutate((next) => { next.checkEveryDays = days }); return snapshot()
    },
    async link(itemID, fileID, remove = false) {
      if (!loadLib().some((item) => item.id === itemID)) throw new Error('Reference not found')
      if (!state.files.some((file) => file.id === fileID && file.status !== 'moved')) throw new Error('PDF not found')
      await mutate((next) => {
        const current = Object.hasOwn(next.links, itemID) ? next.links[itemID] : []
        next.links = { ...next.links, [itemID]: remove ? current.filter((id) => id !== fileID) : [...new Set([...current, fileID])] }
      })
      return snapshot()
    },
    file(id) { const file = state.files.find((entry) => entry.id === id && entry.status === 'available'); if (!file) throw new Error('Available PDF not found'); return file },
    async createProject(name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a project name')
      const id = randomUUID()
      await mutate((next) => { next.projects.push({ id, name: name.trim(), itemIds: [], created: new Date(now()).toISOString() }); next.activeProject = id })
      return snapshot()
    },
    async renameProject(id, name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a project name')
      await mutate((next) => {
        const p = next.projects.find((x) => x.id === id)
        if (!p) throw new Error('Project not found')
        p.name = name.trim()
      })
      return snapshot()
    },
    async deleteProject(id) {
      await mutate((next) => {
        next.projects = next.projects.filter((x) => x.id !== id)
        if (next.activeProject === id) next.activeProject = next.projects[0]?.id || null
      })
      return snapshot()
    },
    async setActiveProject(id) {
      await mutate((next) => { next.activeProject = id || null })
      return snapshot()
    },
    async addToProject(projectId, itemIds) {
      if (!Array.isArray(itemIds)) itemIds = [itemIds]
      const lib = loadLib().map((i) => i.id)
      await mutate((next) => {
        const p = next.projects.find((x) => x.id === projectId)
        if (!p) throw new Error('Project not found')
        for (const id of itemIds) if (lib.includes(id) && !p.itemIds.includes(id)) p.itemIds.push(id)
      })
      return snapshot()
    },
    async removeFromProject(projectId, itemIds) {
      if (!Array.isArray(itemIds)) itemIds = [itemIds]
      await mutate((next) => {
        const p = next.projects.find((x) => x.id === projectId)
        if (!p) throw new Error('Project not found')
        p.itemIds = p.itemIds.filter((id) => !itemIds.includes(id))
      })
      return snapshot()
    },
    tick() {
      if (!running && state.checkEveryDays && (state.roots.length || state.files.length)
        && (!state.lastCheck || now() - Date.parse(state.lastCheck) >= state.checkEveryDays * 86400000)) startCheck()
    },
    async idle() { await running; await writes },
    async stop() { stopped = true; await running; await writes },
  }
}
