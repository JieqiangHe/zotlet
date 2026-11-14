// AppleScript handler bindings are part of the implementation, beyond the mocked Word RPCs.
// The native language check runs on macOS without Word; Word's Apple events still need real Word.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const source = fs.readFileSync(new URL('../java/word/word-mac.applescript', import.meta.url), 'utf8')

function collisions(script) {
  const handlers = new Set([...script.matchAll(/^on (\w+)\(/gm)].map((m) => m[1].toLowerCase()))
  const bindings = [...script.matchAll(/\b(?:set|repeat with|local|global|property)\s+(\w+)/gi)].map((m) => m[1].toLowerCase())
  for (const m of script.matchAll(/^on \w+\(([^)]*)\)/gm)) bindings.push(...m[1].split(',').map((p) => p.trim().toLowerCase()))
  return [...new Set(bindings.filter((name) => handlers.has(name)))].sort()
}

test('AppleScript handlers have distinct names from variables and parameters', () => {
  assert.deepEqual(collisions(source), [], 'assigning a text range must not replace a callable handler')
  // The 0.5.0 pattern must be caught: its second call failed after the first stored a Word range.
  assert.deepEqual(collisions('on zRange(zDoc)\nreturn zDoc\nend zRange\non zSetText(zDoc)\nset zRange to my zRange(zDoc)\nset zRange to my zRange(zDoc)\nend zSetText'), ['zrange'])
})

function rangeProbe(script) {
  const body = /^on zSetText\([^\n]*\)\n([\s\S]*?)\nend zSetText/m.exec(script)?.[1]
  assert.ok(body)
  const bindings = [...body.matchAll(/^\s*set (?:zDoc|zRange) to my \w+\([^\n]*\)$/gm)].map((m) => m[0].trim())
  assert.equal(bindings.length, 3, 'exercise document lookup and both actual range bindings in zSetText')
  const document = /my (\w+)\(/.exec(bindings[0])[1]
  const range = /my (\w+)\(/.exec(bindings[1])[1]
  return `on ${document}(zName, zPath)
return zName
end ${document}
on ${range}(zDoc, zKind, zIndex, zMarkName)
return {zDoc, zKind, zIndex, zMarkName}
end ${range}
on zProbe(zName, zPath, zKind, zIndex, zMarkName)
tell current application
${bindings.join('\n')}
if zRange is not {"Document1", 0, 1, ""} then error "Wrong range returned"
end tell
return "ok"
end zProbe
return zProbe("Document1", "Document1", 0, 1, "")
`
}

test('macOS AppleScript: both production range bindings remain callable after the first assignment', { skip: process.platform !== 'darwin' && 'requires the macOS AppleScript runtime' }, () => {
  const run = (probe) => spawnSync('/usr/bin/osascript', ['-l', 'AppleScript', '-'], { input: probe, encoding: 'utf8', timeout: 30000 })
  const fixed = run(rangeProbe(source))
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
  assert.equal(fixed.stdout.trim(), 'ok')
  // A native negative control makes sure the probe actually detects the reported binding bug.
  const oldProbe = rangeProbe(source.replace(/\bzGetRange\b/g, 'zRange'))
  const old = run(oldProbe)
  assert.notEqual(old.status, 0, 'the original same-name handler must fail in this probe')
  // Replacing the handler with our list raises -1708 (message not handled); the user's Word
  // range object raised -1700 (coercion). Both must fail at the second call to that same handler.
  assert.match(old.stderr, /\(-170(?:0|8)\)/)
  const location = /^(\d+):(\d+): execution error:/m.exec(old.stderr)
  assert.ok(location, old.stderr)
  const call = 'zRange(zDoc, zKind, zIndex, zMarkName)'
  assert.equal(Number(location[1]), oldProbe.lastIndexOf(call), 'failure is at the second range lookup')
  assert.equal(oldProbe.slice(Number(location[1]), Number(location[2])), call)
})
