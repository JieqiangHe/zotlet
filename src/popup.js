// The citation picker as a pop-up window: a Chromium browser's "app" window (no tabs, no address
// bar) that comes to the front over the word processor. Falls back to a normal browser tab.
// On macOS the app that was in front (GenOffice, LibreOffice) is brought back afterwards.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { openBrowser } from './open.js'

const execute = promisify(execFile)
const MAC_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi']
const WIN_BROWSERS = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'], ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
]
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']

/** A Chromium-based browser that can open app windows, as { platform, app | exe }, or null. */
export function findAppBrowser({ platform = process.platform, exists = fs.existsSync, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') {
    for (const app of MAC_BROWSERS) {
      if ([path.join('/Applications', `${app}.app`), path.join(home, 'Applications', `${app}.app`)].some((p) => exists(p))) return { platform, app }
    }
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      for (const parts of WIN_BROWSERS) { const exe = path.join(base, ...parts); if (exists(exe)) return { platform, exe } }
    }
  } else {
    for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of LINUX_BROWSERS) { const exe = path.join(dir, name); if (exists(exe)) return { platform, exe } }
    }
  }
  return null
}

/** The command that opens `url` as an app window of `browser`. */
export function popupCommand(browser, url, { width = 780, height = 560 } = {}) {
  const args = [`--app=${url}`, `--window-size=${width},${height}`]
  if (browser.platform === 'darwin') return ['open', ['-na', browser.app, '--args', ...args]]
  return [browser.exe, args]
}

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => { child.unref(); resolve(true) })
    } catch { resolve(false) }
  })
}

/** Open the picker: a pop-up app window when possible, else a browser tab. */
export async function openPicker(url, { browser = findAppBrowser() } = {}) {
  if (browser && await run(...popupCommand(browser, url))) return 'window'
  openBrowser(url)
  return 'tab'
}

/** macOS: the bundle id of the app in front (no permission prompt: uses lsappinfo). */
export async function frontApp() {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout: asn } = await execute('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 1500 })
    const { stdout } = await execute('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn.trim()], { encoding: 'utf8', timeout: 1500 })
    return /"CFBundleIdentifier"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] || null
  } catch { return null }
}

/** macOS: bring an app back to the front by bundle id (`open -b`, no Apple events). */
export function activateApp(bundleId) {
  if (process.platform !== 'darwin' || !bundleId || !/^[\w.-]+$/.test(bundleId)) return
  run('open', ['-b', bundleId])
}
