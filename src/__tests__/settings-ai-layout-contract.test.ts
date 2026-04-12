import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('ai settings panel defines compact field cards and capability chips', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.match(settingsPage, /function AISettingsFieldCard/)
  assert.match(settingsPage, /function AISettingsCapabilityChip/)
  assert.match(settingsPage, /grid gap-3 md:grid-cols-2/)
  assert.match(settingsPage, /能力分组/)
  assert.match(settingsPage, /capabilityModes/)
  assert.match(settingsPage, /当前状态/)
})
