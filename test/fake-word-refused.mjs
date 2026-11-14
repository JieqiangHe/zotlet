// A Word helper that is refused by macOS: every request fails with error -1743.
import readline from 'node:readline'
for await (const line of readline.createInterface({ input: process.stdin })) {
  let id = null
  try { id = JSON.parse(line).id } catch { continue }
  process.stdout.write(JSON.stringify({ id, error: 'macOS did not allow zotlet to control Microsoft Word. Allow it in System Settings → Privacy & Security → Automation, then try again.' }) + '\n')
}
