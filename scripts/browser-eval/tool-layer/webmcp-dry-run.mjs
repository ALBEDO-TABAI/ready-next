// No Electron, sockets or model: validate the fixture registrations and compile the eval files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url)
const checked = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', fileURLToPath(new URL('../tsconfig.json', import.meta.url))], { stdio: 'inherit' })
if (checked.error) throw checked.error
if (checked.status !== 0) process.exit(checked.status || 1)
const registered = []
const html = readFileSync(new URL('../sites/webmcp-tools.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const window = {}
await runInNewContext(script, { window, document: { modelContext: { registerTool: async tool => registered.push(tool) }, querySelector: () => ({ textContent: '' }) } })
assert.equal(window.webmcpError, null)
assert.equal(window.webmcpReady, true)
assert.deepEqual(registered.map(tool => tool.name), ['lookup', 'commit'])
assert.equal(registered[0].annotations.readOnlyHint, true)
assert.equal(registered[1].annotations.consequentialHint, true)
assert.equal((await registered[0].execute({ query: 'dry' })).content[0].text, 'WEBMCP-READ:dry')
console.log('WebMCP dry-run: eval typecheck, fixture registrations, annotations and read result passed (no CDP/runtime claim).')
