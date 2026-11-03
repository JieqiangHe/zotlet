import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { readStyle } from '../style-catalog.js'

const require = createRequire(import.meta.url)
const CSL = require('citeproc')
const locale = fs.readFileSync(new URL('../locales/locales-en-US.xml', import.meta.url), 'utf8')

export async function formatItems({ style = 'nature', items = [], mode = 'bibliography' } = {}) {
  if (!items.length) return { text: '', citations: [], bibliography: '' }
  const xml = readStyle(style)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./format-worker.js', import.meta.url), {
      workerData: { xml, items, mode },
      resourceLimits: { maxOldGenerationSizeMb: 128 }
    })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Formatting timed out')), 8000)
    worker.once('message', (value) => finish(value.error ? new Error(value.error) : null, value))
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => { if (!settled) finish(new Error(`Formatter exited (${code})`)) })
  })
}
