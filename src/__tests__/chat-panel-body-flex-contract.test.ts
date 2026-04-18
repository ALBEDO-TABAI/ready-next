import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('ChatPanelMotionLayer body grid cell keeps a flex column context so ChatMessages flex-1 fills the height and the composer stays pinned to the bottom', () => {
  const source = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(
    source,
    /<div\s+className="relative min-h-0 overflow-hidden flex flex-col"\s+style=\{\{\s*zIndex:\s*1\s*\}\}>\s*\{body\}/,
  )
})

test('ChatMessages still carries flex-1 + overflow-auto so it actually consumes the body cell height the flex context provides', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /flex-1/)
  assert.match(chatMessages, /overflow-auto/)
})
