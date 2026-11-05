// The picker as a pop-up window, and switching back to the word processor afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { findAppBrowser, popupCommand } from '../src/popup.js'
import { startServer } from '../src/server.js'
import { createStore } from '../src/store.js'
import { tempDir } from './helpers.js'

test('finds a Chromium browser that can open app windows, on each platform', () => {
  const has = (...files) => (p) => files.includes(p)
  assert.deepEqual(findAppBrowser({ platform: 'darwin', home: '/Users/jh', exists: has('/Applications/Microsoft Edge.app') }), { platform: 'darwin', app: 'Microsoft Edge' })
  assert.deepEqual(findAppBrowser({ platform: 'darwin', home: '/Users/jh', exists: has('/Users/jh/Applications/Google Chrome.app', '/Applications/Brave Browser.app') }), { platform: 'darwin', app: 'Google Chrome' })
  assert.equal(findAppBrowser({ platform: 'darwin', home: '/Users/jh', exists: () => false }), null, 'Safari only: fall back to a tab')
  const exe = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
  assert.deepEqual(findAppBrowser({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' }, exists: has(exe) }), { platform: 'win32', exe })
  assert.deepEqual(findAppBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/chromium') }), { platform: 'linux', exe: '/usr/bin/chromium' })
})

test('pop-up command: an app window of the given size', () => {
  assert.deepEqual(popupCommand({ platform: 'darwin', app: 'Google Chrome' }, 'http://127.0.0.1:1/pick.html?id=x'),
    ['open', ['-na', 'Google Chrome', '--args', '--app=http://127.0.0.1:1/pick.html?id=x', '--window-size=780,560']])
  assert.deepEqual(popupCommand({ platform: 'linux', exe: '/usr/bin/chromium' }, 'u', { width: 600, height: 400 }), ['/usr/bin/chromium', ['--app=u', '--window-size=600,400']])
})

test('the picker brings the word processor back to the front when it is done', async () => {
  const dir = tempDir(), opened = [], activated = []
  const server = await startServer({ port: 0, dir, store: createStore({ dir }), quiet: true, openUrl: (url) => opened.push(url),
    focus: { front: async () => 'cn.genoffice.app', activate: (app) => activated.push(app) } })
  try {
    const result = server.pick({ mode: 'style', style: 'nature' })
    while (!opened.length) await new Promise((r) => setTimeout(r, 5))
    const id = new URL(opened[0]).searchParams.get('id')
    await fetch(new URL('api/pick/done', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zotlet-Token': server.token }, body: JSON.stringify({ id, style: 'cell' }) })
    assert.deepEqual(await result, { style: 'cell' })
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(activated, ['cn.genoffice.app'])
  } finally { server.close(); server.closeAllConnections() }
})
