import { Worker } from 'node:worker_threads'

export function createCitations({ ports = [23116, 23119] } = {}) {
  let worker = null, state = 'stopped', error = null, actualPorts = [...ports], logs = '', closing = false, stopped = Promise.resolve()
  const status = () => ({ state, error, ports: [...actualPorts], logs })
  return {
    status,
    start() {
      if (worker || state === 'starting' || closing) return status()
      state = 'starting'; error = null; logs = ''
      void stopped.then(() => {
        if (closing) return
        const current = worker = new Worker(new URL('./citation-worker.js', import.meta.url), {
          workerData: { ports }, stdout: true, stderr: true,
        })
        const fail = (message) => { if (worker !== current || closing) return; state = 'error'; error = message; worker = null; stopped = current.terminate().catch(() => {}) }
        for (const stream of [current.stdout, current.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-12000) })
        current.on('message', (message) => {
          if (worker !== current) return
          if (message.type === 'ready') { state = 'running'; actualPorts = message.ports }
          else if (message.type === 'error') fail(message.message)
        })
        current.on('error', (failure) => fail(failure.message))
        current.on('exit', (code) => { if (worker === current) fail(`Citation service stopped (${code})`) })
      }).catch((failure) => { if (!closing) { state = 'error'; error = failure.message } })
      return status()
    },
    async close() { closing = true; const current = worker; worker = null; await Promise.all([stopped, current?.terminate()]); state = 'stopped' },
  }
}
