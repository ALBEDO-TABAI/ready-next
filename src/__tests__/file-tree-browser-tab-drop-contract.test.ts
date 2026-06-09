import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('file tree offers a browser-style placeholder action menu for dropped browser tabs', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  const dispatcher = readWorkspaceFile('src/renderer/components/layout/fileTreeExternalDrop.ts')

  assert.match(dispatcher, /type:\s*'browser-tab'/)
  assert.match(source, /label:\s*'网页剪藏'/)
  assert.match(source, /label:\s*'内容学习'/)
  assert.match(source, /label:\s*'文案分析'/)
  assert.match(source, /label:\s*'视觉分析'/)
  assert.match(source, /glass-surface-floating ready-floating-menu/)
  assert.match(source, /ready-floating-menu-item/)
})

test('browser tab drop menu clamps to the file panel boundary without resetting back to raw pointer coordinates', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  assert.match(source, /clampDropMenuPositionToBoundary\(/)
  assert.doesNotMatch(
    source,
    /useEffect\(\(\)\s*=>\s*\{\s*setAdjustedPos\(\{\s*x:\s*menu\.x,\s*y:\s*menu\.y\s*\}\)\s*\}\s*,\s*\[menu\.x,\s*menu\.y\]\s*\)/,
  )
})

test('completed web clip placeholders can be dismissed instead of sticking in the file tree', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  assert.match(source, /onDismissPendingClip/)
  assert.match(source, /点击清除提示/)
  assert.match(source, /patch\.status === 'completed'/)
  assert.match(source, /schedulePlaceholderRemoval\(taskId,\s*1800\)/)
})

test('selected file rows use a brighter active surface instead of the generic hover darkening', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  assert.doesNotMatch(source, /isActive \? \{ background: 'var\(--bg-hover\)' \} : \{\}/)
  assert.match(source, /background: 'rgba\(255,\s*255,\s*255,\s*0\.36\)'/)
})

test('hovering unselected rows uses the intermediate bright state instead of the old dark hover wash', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  assert.doesNotMatch(source, /hover:bg-black\/5/)
  assert.match(source, /const \[isHovered,\s*setIsHovered\] = useState\(false\)/)
  assert.match(source, /background: 'rgba\(255,\s*255,\s*255,\s*0\.28\)'/)
})

test('browser tab drag affordances brighten the target row and render a thicker glowing insertion marker', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')

  assert.match(source, /const isBrowserDropAccent = isBrowserDropInside \|\| Boolean\(browserDropLine\)/)
  assert.match(source, /background: 'color-mix\(in srgb, rgba\(255,\s*255,\s*255,\s*0\.28\) 62%, var\(--color-blue-light\) 38%\)'/)
  assert.match(source, /height: 3,/)
  assert.match(source, /width: 8,/)
  assert.match(source, /boxShadow: '0 0 0 2px rgba\(255,\s*255,\s*255,\s*0\.76\), 0 4px 12px rgba\(59,\s*130,\s*246,\s*0\.24\)'/)
})
