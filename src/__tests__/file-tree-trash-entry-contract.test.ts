import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed UI contract: FileTree context-menu and drag affordances are closure-local; live surface tests cover the user behavior.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('file tree exposes a visible trash recovery entry outside the right-click menu', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  const marker = 'aria-label="打开回收站"'
  const markerIndex = source.indexOf(marker)
  assert.ok(markerIndex > 0, 'file tree must expose a visible trash entry')

  const visibleBlock = source.slice(Math.max(0, markerIndex - 500), markerIndex + 500)
  assert.match(visibleBlock, /onClick=\{openTrashPanel\}/)
  assert.match(visibleBlock, />\s*回收站\s*</)

  const contextBridgeIndex = source.indexOf('<ContextMenuBridge')
  assert.ok(contextBridgeIndex > markerIndex, 'visible trash entry must render before the context menu bridge')
})

test('file tree right-click menu keeps remove-from-list available for top-level folders', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /workspaceRoot=\{workspaceRoot\}/)
  assert.match(source, /\(pinnedFolderSet\.has\(item\.path\) \|\| item\.path === workspaceRoot \?/)
  assert.match(source, /label: '从列表中移除'/)
  assert.match(source, /if \(pendingDelete\.path === workspaceRoot\)/)
})

test('file tree distinguishes permanent delete from delete-to-trash', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /label: '删除到回收站'/)
  assert.match(source, /onRequestTrash\(\{ path: item\.path, name: item\.name \}\)/)
  assert.match(source, /label: '删除'/)
  assert.match(source, /onRequestDelete\(\{ path: item\.path, name: item\.name \}\)/)
  assert.match(source, /清空回收站/)
  assert.match(source, /deleteTrashItemPermanently/)
})

test('file tree internal native drags can drop without a system Files dataTransfer type', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /function hasRememberedNativeFileDrag\(/)
  assert.match(source, /return Boolean\(payload && canMoveToDirectory\(payload, targetDir\)\)/)
  assert.doesNotMatch(source, /nativePayload && hasNativeFileDrop\(e\.dataTransfer\) && canMoveToDirectory\(nativePayload, dirPath\)/)
  assert.doesNotMatch(source, /nativePayload && hasNativeFileDrop\(e\.dataTransfer\) && canMoveToDirectory\(nativePayload, currentPath\)/)
})
