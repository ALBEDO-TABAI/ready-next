const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { checkIPCContract } = require('../check-ipc-contract.cjs')

function check(t, type, listeners) {
  const root = mkdtempSync(join(tmpdir(), 'ready-ipc-forwarder-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['src/main', 'src/preload', 'src/renderer/types', 'scripts']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'src/main/index.ts'), `declare const webContents: {send(channel: string, data: unknown): void}; function forward(channel: ${type}) { webContents.send(channel, {}); }`)
  writeFileSync(join(root, 'src/preload/index.ts'), listeners.map((channel) => `ipcRenderer.on('${channel}', () => {});`).join('\n'))
  writeFileSync(join(root, 'src/renderer/types/electron.d.ts'), '')
  writeFileSync(join(root, 'scripts/ipc-contract-allowlist.json'), JSON.stringify({
    $schema_version: 1, invoke_only: [], invoke_unhandled: [], send_unreceived: [], push_unlistened: [], methods_exposed_only: [], methods_typed_only: [],
  }))
  const result = checkIPCContract({ root })
  assert.deepEqual(result.fatal, [])
  return result
}

test('finite forwarded events are included in the ordinary producer/consumer comparison', (t) => {
  const result = check(t, "'one' | 'two'", ['one', 'two'])
  assert.equal(result.counts.pushEmitted, 2)
  assert.deepEqual(result.nonLiteral.violations, [])
  assert.ok(result.sections.every((section) => section.violations.length === 0))
})

test('a forwarded union member without a listener is still rejected', (t) => {
  const result = check(t, "'one' | 'missing'", ['one'])
  assert.ok(result.sections.some((section) => section.violations.some((violation) => violation.includes('missing'))))
})

test('unbounded forwarded channels are rejected rather than silently exempted', (t) => {
  for (const type of ['string', 'any', 'unknown', "'one' | string", "'one' | undefined"]) {
    const result = check(t, type, ['one'])
    assert.ok(result.nonLiteral.violations.length > 0, type)
  }
})
