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
  const attachmentIntake = readWorkspaceFile('src/renderer/components/agent/chat-panel/drag-drop/use-attachment-intake.ts')
  const fileTree = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  const dropReference = readWorkspaceFile('src/renderer/modules/agent/drop-reference.ts')
  assert.match(attachmentIntake, /dropAgentReference\(e\.dataTransfer,/)
  assert.match(dropReference, /case 'web':[\s\S]*tabs\.find\(tab => tab\.url === ref\.url\)/)
  assert.match(dropReference, /source: 'browser-tab', browserTabId: tab\.id/)
  assert.doesNotMatch(attachmentIntake, /browser\.getTabContext/)
  assert.match(tabRail, /ReadyRefSchema\.safeParse\(\{ kind: 'web', url: tab\.url \}\)/)
  assert.match(tabRail, /writeReadyRefTransfer\(event\.dataTransfer, ref\.data, tab\.title \|\| tab\.url\)/)
  assert.match(tabRail, /beginBrowserTabDragSession\(/)
  assert.match(tabRail, /endBrowserTabDragSession\(\)/)
  assert.match(tabRail, /window\.addEventListener\('dragend', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /window\.addEventListener\('drop', handleGlobalDragCleanup\)/)
  assert.doesNotMatch(tabRail, /window\.addEventListener\('mouseup', handleGlobalDragCleanup\)/)
  assert.doesNotMatch(tabRail, /window\.addEventListener\('pointerup', handleGlobalDragCleanup\)/)
  assert.doesNotMatch(tabRail, /window\.addEventListener\('pointercancel', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /document\.addEventListener\('visibilitychange', handleVisibilityCleanup\)/)
  assert.doesNotMatch(tabRail, /window\.addEventListener\('blur', handleGlobalDragCleanup\)/)
  assert.match(tabRail, /return clearGlobalDragState/)
  assert.match(tabRail, /setDraggingTabId\(null\)/)
  assert.match(tabRail, /type:\s*'browser-tab'/)
  assert.match(tabRail, /tabId:\s*tab\.id/)
  assert.match(fileTree, /e\.dataTransfer\.types\.includes\(READY_REF_MIME\)/)
  assert.match(fileTree, /dropPageTreeReference\(e\.dataTransfer,/)
  assert.doesNotMatch(dropReference, /browser\.getTabContext/)
  assert.match(activeTabSurface, /ref=\{surfaceRef\}[\s\S]*draggable=\{draggable && !isExpanded\}/)
  assert.doesNotMatch(activeTabSurface, /data-browser-active-drag-handle/)
  assert.match(activeTabSurface, /onDragStart=\{\(event\) => \{[\s\S]*onDragStart\?\.?\(event\)/)
  assert.match(activeTabSurface, /onDragEnd=\{onDragEnd\}/)
  assert.match(activeTabSurface, /data-browser-active-action/)
})
