// Preview and import validation run outside the HTTP event loop.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
const CSL = createRequire(import.meta.url)('citeproc')
const locale = fs.readFileSync(new URL('../locales/locales-en-US.xml', import.meta.url), 'utf8')
try {
  const { xml, items } = workerData, byID = Object.fromEntries(items.map((item) => [item.id, item]))
  const engine = new CSL.Engine({ retrieveLocale: () => locale, retrieveItem: (id) => byID[id] }, xml)
  engine.setOutputFormat('html')
  const citations = engine.rebuildProcessorState(items.map((item, i) => ({ citationID: `preview-${i}`,
    citationItems: [{ id: item.id }], properties: { noteIndex: 0 } })), 'html').map((entry) => entry[2])
  const bibliography = engine.makeBibliography()
  if (!bibliography) throw new Error('This style did not produce a bibliography')
  parentPort.postMessage({ citations, bibliography: bibliography[0].bibstart + bibliography[1].join('') + bibliography[0].bibend,
    format: bibliography[0] })
} catch (error) { parentPort.postMessage({ error: error.message }) }
