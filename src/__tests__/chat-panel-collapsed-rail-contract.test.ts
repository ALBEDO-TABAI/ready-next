import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('collapsed chat rail keeps its outer shell border fully transparent', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(chatPanel, /border:\s*'1px solid transparent'/)
  assert.match(workbenchMode, /const chatShellWidth = chatPanelState === 'collapsed' \? WORKBENCH_EDGE_RAIL_SIZE : chatPanelWidth/)
})
