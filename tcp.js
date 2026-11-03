// Native integration transport: 8-byte big-endian headers and JSON/ERR payloads.
import net from 'node:net'
import { runSession, tty } from './session.js'
import { libreOfficeClient } from './tcp-client.js'

const libreOfficeSession = { modernData: true, nativeFieldTypes: ['ReferenceMark', 'Bookmark'],
  setBibliographyStyle: true, finalCommit: true, supportedNotes: ['footnote', 'endnote'], version: '6.0.0' }

export function createTcpServer() {
  return net.createServer((sock) => {
    let buffer = Buffer.alloc(0), tx = 0, closed = false, commands = Promise.resolve()
    // Resolve once per connection; native commands reuse the same socket.
    const profile = libreOfficeClient(sock).then((owner) => {
      if (owner) console.log(tty.dim(`TCP client ${owner.command} (PID ${owner.pid}): LibreOffice adapter.`))
      return owner ? libreOfficeSession : {}
    }).catch((error) => {
      console.error(tty.dim(`TCP process inspection failed: ${error.message}. Using GenOffice compatibility.`))
      return {}
    })
    const waiting = new Map()
    const call = (method, args) => new Promise((resolve, reject) => {
      if (closed || sock.destroyed || sock.writableEnded) { reject(new Error('GenOffice closed the connection')); return }
      const id = ++tx, body = Buffer.from(JSON.stringify([method, args])), header = Buffer.alloc(8)
      header.writeUInt32BE(id); header.writeUInt32BE(body.length, 4)
      waiting.set(id, { resolve, reject })
      sock.write(Buffer.concat([header, body]))
    })
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const id = buffer.readUInt32BE(), length = buffer.readUInt32BE(4)
        if (buffer.length < 8 + length) break
        const payload = buffer.subarray(8, 8 + length).toString('utf8')
        buffer = buffer.subarray(8 + length)
        if (id === 0) {
          let command
          try { ({ command } = JSON.parse(payload)); if (typeof command !== 'string') throw new Error('Invalid command') }
          catch { sock.destroy(); return }
          const time = new Date().toTimeString().slice(0, 8)
          commands = commands.then(async () => {
            const session = await profile, native = !!session.nativeFieldTypes
            const invoke = async (method, args) => {
              const value = await call(method.replace('.', '_'), args)
              if (native && method === 'Field.setCode') {
                const code = args[2], start = code.indexOf('{')
                if (start !== -1) {
                  const text = JSON.parse(code.slice(start, code.lastIndexOf('}') + 1)).properties?.formattedCitation
                  if (text?.includes('\\')) await call('Field_setText', [args[0], args[1], text.startsWith('{\\rtf') ? text : `{\\rtf ${text}}`, true])
                }
              }
              return value
            }
            try {
              const note = await runSession(command, invoke, session)
              console.log(`${tty.dim(time)}  ${command.padEnd(20)} ${tty.dim(note || '')}`)
            } finally { if (!native) sock.end() }
          }).catch((error) => console.error(tty.red(error.message)))
          continue
        }
        const pending = waiting.get(id)
        if (!pending) continue
        waiting.delete(id)
        if (payload.startsWith('ERR:')) pending.reject(new Error(payload.slice(4)))
        else { try { pending.resolve(JSON.parse(payload)) } catch (error) { pending.reject(error) } }
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      closed = true
      waiting.forEach((pending) => pending.reject(new Error('GenOffice closed the connection')))
      waiting.clear()
    })
  })
}
