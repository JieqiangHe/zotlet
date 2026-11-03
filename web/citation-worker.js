// The native picker stays synchronous inside the existing integration server.
// A separate worker keeps the management page responsive without changing its protocol.
import { parentPort, workerData } from 'node:worker_threads'
import { serve } from '../server.js'
try {
  const server = serve(...workerData.ports)
  await server.ready
  parentPort.postMessage({ type: 'ready', ports: [server.address().port, server.http.address().port] })
} catch (error) {
  const message = error.code === 'EADDRINUSE' ? `Port ${error.port} is in use. Quit Zotero or the other zotlet citation server, then try again.` : error.message
  parentPort.postMessage({ type: 'error', message }); parentPort.close()
}
