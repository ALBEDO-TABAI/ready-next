import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser active tab keeps its edit hotspot separate from the drag handle', () => {
  const activeTabSurface = readWorkspaceFile('src/renderer/components/browser/ActiveTabSurface.tsx')
  const tabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(activeTabSurface, /data-browser-active-hotspot/)
  assert.match(activeTabSurface, /ref=\{surfaceRef\}[\s\S]*draggable=\{draggable && !isExpanded\}/)
  assert.match(tabRail, /draggable=\{activeTabMode !== 'expanded' && activeTabMode !== 'editing'\}/)
})
