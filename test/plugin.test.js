// The TBtools plugin: package it, unpack it like TBtools' Install Plugin, and load it the way TBtools
// does (java/test/VerifyPlugin.java, with stand-ins for TBtools' browser panel in java/test/tbtools).
// Checks normal loading, the Intel-build licence work-around, the fallback panel, and reinstalling
// while TBtools runs. With TBTOOLS_JAR set, the plugin is also loaded through TBtools' own code.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempDir } from './helpers.js'
import { ROOT, buildOrSkip } from './zotlet.js'

let skip = buildOrSkip()
if (!skip && spawnSync('unzip', ['-v']).status !== 0) skip = 'unzip is not installed'
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const PLUGIN = path.join(ROOT, 'dist', `zotlet-${VERSION}.plugin`)
let classes

before(() => {
  if (skip) return
  const packaged = spawnSync('sh', [path.join(ROOT, 'scripts', 'package-java.sh'), '--no-repo-copy'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(packaged.status, 0, packaged.stdout + packaged.stderr)
  classes = tempDir()
  const sources = [path.join(ROOT, 'java', 'test', 'VerifyPlugin.java')]
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.java')) sources.push(p) } }
  walk(path.join(ROOT, 'java', 'test', 'tbtools'))
  const compiled = spawnSync('javac', ['-d', classes, ...sources], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
})

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

/** Unpack the plugin into a fresh TBtools home and run VerifyPlugin in a JVM of its own. */
async function verify(javaArgs = [], extra = []) {
  const home = tempDir(), pluginRoot = path.join(home, '.Plugin')
  fs.mkdirSync(pluginRoot)
  assert.equal(spawnSync('unzip', ['-q', PLUGIN, '-d', pluginRoot]).status, 0)
  const env = { ...process.env, ZOTLET_HOME: home, ZOTLET_PORT: String(await freePort()), ZOTLET_TCP_PORT: String(await freePort()),
    ZOTLET_HTTP_PORT: String(await freePort()), ZOTLET_WORD_INSTALL: '0', ZOTLET_PICKER: 'web' }
  const r = spawnSync('java', ['-Djava.awt.headless=true', `-Duser.home=${home}`, ...javaArgs, '-cp', classes, 'VerifyPlugin', path.join(pluginRoot, 'zotlet'), ...extra],
    { encoding: 'utf8', env, timeout: 120000 })
  const out = r.stdout + r.stderr
  assert.equal(r.status, 0, out)
  return out
}

test('the plugin package has one top-level jar, zotlet in lib/, and everything zotlet needs', { skip }, () => {
  const list = spawnSync('unzip', ['-Z1', PLUGIN], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  assert.deepEqual(list.filter((f) => /^zotlet\/[^/]+\.jar$/.test(f)), ['zotlet/zotlet-plugin.jar'])
  for (const f of ['zotlet/lib/zotlet.jar', 'zotlet/citeproc/citeproc_commonjs.js', 'zotlet/public/index.html', 'zotlet/styles/nature.csl',
    'zotlet/locales/locales-en-US.xml', 'zotlet/quickformat.jxa.js', 'zotlet/word/mac/Zotero.dotm', 'zotlet/word/mac/Zotero.scpt',
    'zotlet/word/win/Zotero.dotm', 'zotlet/word/word-mac.js', 'zotlet/word/word-win.ps1', 'zotlet/THIRD-PARTY.txt', 'zotlet/LICENSE']) {
    assert.ok(list.includes(f), f)
  }
  assert.ok(list.some((f) => /^zotlet\/lib\/rhino-[\d.]+\.jar$/.test(f)))
  assert.ok(list.every((f) => f.startsWith('zotlet/')), 'one folder, named like the plugin')
})

test('TBtools loads the plugin: zotlet starts, survives the closed class loader, cites; a second tab reuses it; reinstalling takes over', { skip }, async () => {
  const out = await verify([], ['reinstall', PLUGIN])
  assert.match(out, /OK all checks passed/)
  assert.match(out, /panel: biocjava\.GUIexcutors\.WebGuiApp\.WebGuiJPanel/)
})

test('Intel build of TBtools on a Mac: the macOS licence key is refused, the other key works', { skip }, async () => {
  const out = await verify(['-Dverify.osName=Mac OS X', '-Dstub.licenses=OTHER-KEY'])
  assert.match(out, /refused the macOS license key; trying TBtools' other key/)
  assert.match(out, /panel: biocjava\.GUIexcutors\.WebGuiApp\.WebGuiJPanel/)
})

test('no licence key works: the plugin still registers, with a panel that opens zotlet in the web browser', { skip }, async () => {
  const out = await verify(['-Dstub.licenses=none'])
  assert.match(out, /panel: javax\.swing\.JPanel/)
  assert.match(out, /OK all checks passed/, 'zotlet itself runs')
})

test("TBtools' own plugin loader accepts the package (only with TBTOOLS_JAR)", { skip: skip || (!process.env.TBTOOLS_JAR && 'set TBTOOLS_JAR to TBtools\' main jar') }, () => {
  const home = tempDir()
  const verifier = path.join(home, 'TBtoolsVerify.java')
  fs.writeFileSync(verifier, `import java.io.File;
public class TBtoolsVerify {
  public static void main(String[] a) throws Exception {
    File[] dirs = new File(a[0]).listFiles(File::isDirectory);
    try {
      Object[] r = Plugin.PluginUtils.readPluginDirJAR(dirs[0]);
      System.out.println(r == null ? "REJECTED" : "OK loaded " + r[0]);
    } catch (java.lang.reflect.InvocationTargetException e) {
      System.out.println("OK reached TBtools' browser: " + e.getCause());
    }
    System.exit(0);
  }
}`)
  // Unpacked like Install Plugin (plain unzip: TBtools' own unzip helper is not what is tested here).
  const unpacked = path.join(home, 'unpacked')
  assert.equal(spawnSync('unzip', ['-q', PLUGIN, '-d', unpacked]).status, 0)
  const r = spawnSync('java', ['-Djava.awt.headless=true', '-cp', process.env.TBTOOLS_JAR, verifier, unpacked], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ZOTLET_HOME: home, ZOTLET_PORT: '0', ZOTLET_TCP_PORT: '0', ZOTLET_HTTP_PORT: '0', ZOTLET_WORD_INSTALL: '0' } })
  assert.match(r.stdout, /^OK/m, r.stdout + r.stderr)
})
