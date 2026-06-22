import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed UI contract: FileTree context-menu and drag affordances are closure-local; live surface tests cover the user behavior.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('file tree right-click menu keeps remove-from-list available for top-level folders', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /workspaceRoot=\{workspaceRoot\}/)
  assert.match(source, /\(pinnedFolderSet\.has\(item\.path\) \|\| item\.path === workspaceRoot \?/)
  assert.match(source, /label: '从列表中移除'/)
  assert.match(source, /if \(pendingDelete\.path === workspaceRoot\)/)
})

test('file tree keeps direct delete and removes trash affordances', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /label: deleteTargets\.length > 1 \? `删除 \$\{deleteTargets\.length\} 项` : '删除'/)
  assert.match(source, /onRequestDelete\(deleteTargets\)/)
  assert.doesNotMatch(source, /aria-label="打开回收站"/)
  assert.doesNotMatch(source, /label: '回收站'/)
  assert.doesNotMatch(source, /label: '删除到回收站'/)
  assert.doesNotMatch(source, /onRequestTrash/)
  assert.doesNotMatch(source, /openTrashPanel/)
  assert.doesNotMatch(source, /listTrash|restoreTrash|deleteTrashItem|clearTrash/)
})

test('file tree delete action receives selected targets for bulk deletion', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /selectedDeleteTargets=\{selectedDeleteTargets\}/)
  assert.match(source, /selectedDeleteTargets\.length > 1 && selectedDeleteTargetSet\.has\(item\.path\)/)
  assert.match(source, /for \(const target of targets\)/)
  assert.match(source, /await deleteItem\(target\.path\)/)
})

test('file tree right-click menu moves selected items through the folder picker', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /selectedMoveItems=\{selectedMoveItems\}/)
  assert.match(source, /selectedMoveItems\.length > 1 && selectedMoveItemSet\.has\(item\.path\)/)
  assert.match(source, /label: '移动到'/)
  assert.match(source, /openFolder\?\.\(\{ title: '选择移动目标文件夹' \}\)/)
  assert.match(source, /canMoveAllToDirectory\(payloads, result\.path\)/)
  assert.match(source, /await moveItem\(payload\.path, nextPath\)/)
  assert.match(source, /pinnedFolderSet\.has\(path\) \|\| path === workspaceRoot/)
})

test('file tree internal native drags can drop without a system Files dataTransfer type', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  assert.match(source, /const payloads = parseWorkspaceDragPayloads\(e\.dataTransfer\)\s+if \(!canMoveAllToDirectory\(payloads, dirPath\)\) return/)
  assert.match(source, /const payloads = parseWorkspaceDragPayloads\(e\.dataTransfer\)\s+if \(canMoveAllToDirectory\(payloads, currentPath\)\) \{\s+await moveWorkspaceItems\(payloads, currentPath\)/)
  assert.doesNotMatch(source, /nativePayload && hasNativeFileDrop\(e\.dataTransfer\) && canMoveToDirectory\(nativePayload, dirPath\)/)
  assert.doesNotMatch(source, /nativePayload && hasNativeFileDrop\(e\.dataTransfer\) && canMoveToDirectory\(nativePayload, currentPath\)/)
})
