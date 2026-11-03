// Public facade shared by the CLI and integration tests.
import { createTcpServer } from './tcp.js'
import { createHttpServer } from './http.js'
import { runSession, tty, loadLib, styles } from './session.js'
export { styles, LIB, SCHEMA, uri, loadLib, tty, authors, year, ui } from './session.js'

export const run = (cmd, call) => runSession(cmd, (method, args) => call(method.replace('.', '_'), args))

export function serve(port = 23116, httpPort = port === 0 ? 0 : 23119) {
  const server = createTcpServer(), web = createHttpServer()
  server.http = web
  const closeTcp = server.close.bind(server)
  server.close = (callback) => {
    let remaining = 2
    const closed = () => { if (!--remaining) callback?.() }
    web.close(closed); web.closeAllConnections(); closeTcp(closed)
    return server
  }
  const listen = (listener, requested) => new Promise((resolve, reject) => {
    const failed = (error) => { listener.off('listening', bound); error.listenPort = requested; reject(error) }
    const bound = () => { listener.off('error', failed); resolve() }
    listener.once('error', failed); listener.once('listening', bound)
    listener.listen(requested, '127.0.0.1')
  })
  server.ready = Promise.all([listen(server, port), listen(web, httpPort)]).then(() => {
    console.log(`${tty.bold('zotlet')} ${tty.dim('·')} listening on 127.0.0.1:${server.address().port} ${tty.dim('·')} ${loadLib().length} papers ${tty.dim('·')} ${styles().map((s) => s.id).join(', ')}`)
    console.log(tty.dim(`HTTP citing protocol on 127.0.0.1:${web.address().port}. Ctrl+C to quit.\n`))
    return server
  })
  server.ready.catch((error) => {
    console.error(tty.red(error.code === 'EADDRINUSE' ? `Port ${error.listenPort} is in use. Quit Zotero (or another zotlet) and try again.` : error.message))
    server.close()
  })
  return server
}
