// Open a URL in the default browser without blocking or failing the caller.
import { spawn } from 'node:child_process'

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => console.log(`Open ${url} in your browser.`))
    child.unref()
  } catch { console.log(`Open ${url} in your browser.`) }
}
