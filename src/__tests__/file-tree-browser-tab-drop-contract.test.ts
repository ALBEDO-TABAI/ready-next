import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('file tree offers a browser-style placeholder action menu for dropped browser tabs', () => {
  // 2026-07-06 拆分随迁：外部拖放菜单实现从 FileTree 门面移到 floating-menus.tsx。
  const source = readWorkspaceFile('src/renderer/components/layout/file-tree/floating-menus.tsx')
  const dispatcher = readWorkspaceFile('src/renderer/components/layout/fileTreeExternalDrop.ts')

  assert.match(dispatcher, /type:\s*'browser-tab'/)
  assert.match(source, /label:\s*'网页剪藏'/)
  assert.match(source, /label:\s*'内容学习'/)
  assert.match(source, /label:\s*'文案分析'/)
  assert.match(source, /label:\s*'视觉分析'/)
  // B13: the drop menu is the shared menu list on the shared float material (W1 §5), not a private frosted menu.
  assert.match(source, /<FloatPanel ref=\{ref\}/)
  assert.match(source, /<MenuList items=\{entries\}/)
  assert.doesNotMatch(source, /ready-floating-menu|floatingMenuStyles/)
})

test('browser tab drop menu clamps to the file panel boundary without resetting back to raw pointer coordinates', () => {
  // 2026-07-06 拆分随迁：外部拖放菜单实现从 FileTree 门面移到 floating-menus.tsx。
  const source = readWorkspaceFile('src/renderer/components/layout/file-tree/floating-menus.tsx')

  assert.match(source, /clampDropMenuPositionToBoundary\(/)
  assert.doesNotMatch(
    source,
    /useEffect\(\(\)\s*=>\s*\{\s*setAdjustedPos\(\{\s*x:\s*menu\.x,\s*y:\s*menu\.y\s*\}\)\s*\}\s*,\s*\[menu\.x,\s*menu\.y\]\s*\)/,
  )
})

test('completed web clip placeholders can be dismissed instead of sticking in the file tree', () => {
  // 2026-07-06 拆分随迁：占位行实现从 FileTree 门面移到 pending-placeholders.tsx，调度仍在门面。
  const source = [
    readWorkspaceFile('src/renderer/components/layout/FileTree.tsx'),
    readWorkspaceFile('src/renderer/components/layout/file-tree/pending-placeholders.tsx'),
  ].join('\n')

  assert.match(source, /onDismissPendingClip/)
  assert.match(source, /点击清除提示/)
  assert.match(source, /patch\.status === 'completed'/)
  assert.match(source, /schedulePlaceholderRemoval\(taskId,\s*1800\)/)
})

test('selected file rows use a brighter active surface instead of the generic hover darkening', () => {
  // 2026-07-06 拆分随迁：文件行实现从 FileTree 门面移到 FileTreeItem.tsx。
  const source = readWorkspaceFile('src/renderer/components/layout/file-tree/FileTreeItem.tsx')

  assert.doesNotMatch(source, /isActive \? \{ background: 'var\(--bg-hover\)' \} : \{\}/)
  // B13 (W1 §5, DL5): the selected row wears ListRow's current look — the signal colour's soft fill, its text in the accent.
  assert.match(source, /\.\.\.\(isActive\s+\? \{\s+background: 'var\(--rn-accent-soft\)',/)
  assert.match(source, /color: isActive \? 'var\(--rn-accent-text\)'/)
  assert.match(source, /height: 'var\(--rn-row-h\)'/)
})

test('hovering unselected rows uses the intermediate bright state instead of the old dark hover wash', () => {
  // 2026-07-06 拆分随迁：文件行实现从 FileTree 门面移到 FileTreeItem.tsx。
  const source = readWorkspaceFile('src/renderer/components/layout/file-tree/FileTreeItem.tsx')

  assert.doesNotMatch(source, /hover:bg-black\/5/)
  assert.match(source, /const \[isHovered,\s*setIsHovered\] = useState\(false\)/)
  // B13 (W1 §5): hover is ListRow's quiet fill.
  assert.match(source, /!isActive && !isDropTarget && !isBrowserDropAccent && isHovered\s+\? \{\s+background: 'var\(--rn-fill\)',/)
})

test('browser tab drag affordances brighten the target row and render a thicker glowing insertion marker', () => {
  // 2026-07-06 拆分随迁：文件行实现从 FileTree 门面移到 FileTreeItem.tsx。
  const source = readWorkspaceFile('src/renderer/components/layout/file-tree/FileTreeItem.tsx')

  assert.match(source, /const isBrowserDropAccent = isBrowserDropInside \|\| Boolean\(browserDropLine\)/)
  // B13: a drop target is "here" (DL5) — the signal colour's soft fill with an accent ring, as in the document tree.
  assert.match(source, /isDropTarget \|\| isBrowserDropAccent\s+\? \{\s+background: 'var\(--rn-accent-soft\)',\s+boxShadow: 'inset 0 0 0 1\.5px var\(--rn-accent\)',/)
  assert.match(source, /height: 3,/)
  assert.match(source, /width: 8,/)
  assert.match(source, /boxShadow: '0 0 0 2px var\(--rn-sheet\)'/)
})
