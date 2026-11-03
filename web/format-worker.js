import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const CSL = require('citeproc')
const locale = fs.readFileSync(new URL('../locales/locales-en-US.xml', import.meta.url), 'utf8')

try {
  const { xml, items, mode } = workerData
  const byID = Object.fromEntries(items.map((item) => [item.id, item]))
  const engine = new CSL.Engine({ retrieveLocale: () => locale, retrieveItem: (id) => byID[id] }, xml)
  engine.setOutputFormat('text')

  const citationItems = items.map((item, i) => ({
    citationID: `cite-${i}`,
    citationItems: [{ id: item.id }],
    properties: { noteIndex: 0 }
  }))

  const citations = engine.rebuildProcessorState(citationItems, 'text').map((entry) => entry[2])
  let bibliography = ''
  try {
    const bib = engine.makeBibliography()
    if (bib) bibliography = bib[1].map((s) => s.replace(/\s+$/, '')).join('\n\n')
  } catch {}

  parentPort.postMessage({ citations, bibliography, text: mode === 'citation' ? citations.join('\n') : bibliography })
} catch (error) {
  parentPort.postMessage({ error: error.message })
}
