// Unit checks of the Java code the end-to-end tests cannot reach (java/test/UnitTest.java), and a
// syntax check of the native macOS picker script (it only runs on a Mac, through osascript).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, buildOrSkip } from './zotlet.js'

const skip = buildOrSkip()

test('Java unit checks: native picker request/answer, lsof parsing, JSON numbers', { skip }, () => {
  const r = spawnSync('java', ['-cp', path.join(ROOT, 'java/build/lib/zotlet.jar'), path.join(ROOT, 'java/test/UnitTest.java')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^ok$/m)
})

test('the macOS picker script is valid JavaScript', () => {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, 'java/quickformat.jxa.js')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
