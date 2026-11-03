// Select the native adapter from the local socket owner, without protocol probes.
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { endianness } from 'node:os'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const nativeNames = new Set(['soffice', 'soffice.bin', 'libreoffice', 'libreofficedev', 'uno', 'uno.bin'])
const host = (value) => value.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '')
const native = (name) => nativeNames.has(name.toLowerCase())

// lsof emits process sets (p/c) followed by file names (n), including both ends.
export function lsofClient(output, socket) {
  let pid, command
  const owners = new Map()
  for (const line of output.split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); command = '' }
    else if (line[0] === 'c') command = line.slice(1)
    else if (line[0] === 'n') {
      const peer = /^(\[[^\]]+\]|[^:]+):(\d+)->(\[[^\]]+\]|[^:]+):(\d+)(?:\s|$)/.exec(line.slice(1))
      if (peer && host(peer[1]) === host(socket.remoteAddress) && +peer[2] === socket.remotePort
        && host(peer[3]) === host(socket.localAddress) && +peer[4] === socket.localPort
        && Number.isSafeInteger(pid) && pid > 0) owners.set(pid, { pid, command })
    }
  }
  if (owners.size !== 1) throw new Error('TCP peer has no unique process owner')
  return [...owners.values()][0]
}

function procEndpoint(value) {
  const [address, port] = value.split(':')
  const bytes = Buffer.from(address, 'hex')
  if (endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse()
  const mapped = bytes.length === 16 && bytes.subarray(0, 12).equals(Buffer.from('00000000000000000000ffff', 'hex'))
  return { address: bytes.length === 4 || mapped ? [...bytes.subarray(-4)].join('.') : bytes.toString('hex'), port: parseInt(port, 16) }
}

async function linuxClient(socket) {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(async (file) => {
    try { return await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
  }))
  const inodes = new Set()
  for (const line of tables.join('\n').split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns[3] !== '01') continue
    const local = procEndpoint(columns[1]), remote = procEndpoint(columns[2])
    if (local.address === host(socket.remoteAddress) && local.port === socket.remotePort
      && remote.address === host(socket.localAddress) && remote.port === socket.localPort && columns[9] !== '0') inodes.add(columns[9])
  }
  if (!inodes.size) throw new Error('TCP peer is absent from the process table')
  // Only inspect descriptors of candidate office processes; unrelated applications stay legacy.
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const command = (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim()
      if (!native(command)) continue
      for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
        let target
        try { target = await fs.readlink(`/proc/${pid}/fd/${fd}`) } catch { continue }
        if (inodes.has(/^socket:\[(\d+)\]$/.exec(target)?.[1])) return { pid: Number(pid), command }
      }
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error }
  }
  return null
}

export async function libreOfficeClient(socket) {
  if (process.platform === 'linux') return linuxClient(socket)
  if (process.platform === 'darwin') {
    // This bounds the OS query only; document transactions have no timeout.
    const { stdout } = await execute('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${socket.localPort}`, '-sTCP:ESTABLISHED', '-Fpcn'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 })
    const owner = lsofClient(stdout, socket)
    return native(owner.command) ? owner : null
  }
  throw new Error(`TCP process inspection is unavailable on ${process.platform}`)
}
