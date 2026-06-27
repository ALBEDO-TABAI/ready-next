import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat input toolbar removes undo and at-sign shortcut buttons', () => {
  const source = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')

  assert.doesNotMatch(source, /\bUndo2\b/)
  assert.doesNotMatch(source, /\bAtSign\b/)
  assert.doesNotMatch(source, /\bIconButton\b/)
  assert.doesNotMatch(source, /撤回上一条消息/)
  assert.doesNotMatch(source, /引用文件或文件夹/)
  assert.match(source, /<ContextUsageMeter usage=\{contextUsage\} dimmed=\{composerLocked\} \/>/)
})

test('chat input keeps typed-at reference menu path', () => {
  const source = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')

  assert.match(source, /textBeforeCursor\.match\(\/@/)
  assert.match(source, /setShowAtMenu\(true\)/)
  assert.match(source, /insertAtReference/)
})
