import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tabs publish chat-reference drag payloads from both tab rail surfaces', () => {
  const tabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')
  const activeTabSurface = readWorkspaceFile('src/renderer/components/browser/ActiveTabSurface.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const fileTree = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  assert.match(chatPanel, /data\.type === 'browser-tab' && data\.url/)
  assert.match(tabRail, /setData\('application\/x-ready-drag', data\)/)
  assert.match(tabRail, /beginBrowserTabDragSession\(/)
  assert.match(tabRail, /endBrowserTabDragSession\(\)/)
  assert.match(tabRail, /window\.addEventListener\('dragend', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /window\.addEventListener\('drop', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /window\.addEventListener\('pointerup', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /window\.addEventListener\('pointercancel', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /document\.addEventListener\('visibilitychange', handleVisibilityCleanup\)/)
  assert.match(tabRail, /return clearGlobalDragState/)
  assert.match(tabRail, /setDraggingTabId\(null\)/)
  assert.match(tabRail, /type:\s*'browser-tab'/)
  assert.match(tabRail, /tabId:\s*tab\.id/)
  assert.match(fileTree, /getActiveBrowserTabDragPayload\(\)/)
  assert.match(activeTabSurface, /draggable=\{draggable\}/)
  assert.match(activeTabSurface, /onDragStart=\{onDragStart\}/)
  assert.match(activeTabSurface, /onDragEnd=\{onDragEnd\}/)
})
