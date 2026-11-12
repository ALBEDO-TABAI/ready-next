import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('button-triggered dropdown menus opt into the shared frosted submenu treatment', () => {
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')

  // W1: dropdowns use FloatPanel while retaining their placement and item behavior.
  const floatingPanel = readWorkspaceFile('src/renderer/components/ui/float/FloatPanel.tsx')
  assert.match(filesPanel, /import \{ FloatPanel \} from '\.\.\/ui\/float\/FloatPanel'/)
  assert.match(filesPanel, /<FloatPanel/)
  assert.match(
    floatingPanel,
    /className=\{\['rn-float', 'rn-float-panel', className\]/,
  )
  // B13: the filter rows are the shared menu list (checkable items), kept open while filters are toggled.
  assert.match(filesPanel, /<MenuList items=\{filterMenuItems\} label="筛选" onDone=\{\(\) => \{\}\} \/>/)
  assert.match(filesPanel, /checked: filters\[key\]/)
  assert.doesNotMatch(filesPanel, /ready-floating-menu-item|floatingMenuStyles/)
  assert.match(filesPanel, /position:\s*'fixed'/)
})

test('files panel dropdown menus stay within the sidebar and do not hide browser content', () => {
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')

  assert.doesNotMatch(filesPanel, /BROWSER_OVERLAY_LOCK_EVENT/)
  assert.doesNotMatch(filesPanel, /files-panel-menu/)
  assert.match(filesPanel, /import \{ createPortal \} from 'react-dom'/)
  assert.match(filesPanel, /createPortal\(/)
  assert.match(filesPanel, /document\.body/)
  assert.match(filesPanel, /position:\s*'fixed'/)
  assert.match(filesPanel, /computeMenuPosition\(filterTriggerRef\.current, FILTER_MENU_WIDTH\)/)
})

test('file tree context menus use a native popup above BrowserView without hiding browser content', () => {
  const contextMenu = readWorkspaceFile('src/renderer/components/layout/ContextMenu.tsx')
  // 2026-07-06 拆分随迁：ContextMenuBridge 实现从 FileTree 门面移到 floating-menus.tsx。
  const fileTree = [
    readWorkspaceFile('src/renderer/components/layout/FileTree.tsx'),
    readWorkspaceFile('src/renderer/components/layout/file-tree/floating-menus.tsx'),
  ].join('\n')
  const editorContextMenu = readWorkspaceFile('src/renderer/components/document/EditorContextMenu.tsx')
  const skillsCenter = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const browserContextMenu = readWorkspaceFile('src/main/modules/browser-engine/context-menu-service.ts')
  const nativeMenuIpc = readWorkspaceFile('src/main/modules/app-control/native-context-menu-ipc.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')

  // B13: drawn by the shared float host (above the page, native web layer hand-off), not a private portal.
  assert.match(contextMenu, /openFloat\(/)
  assert.doesNotMatch(contextMenu, /BROWSER_OVERLAY_LOCK_EVENT/)
  assert.doesNotMatch(contextMenu, /browser\?\.hideAll/)
  assert.doesNotMatch(contextMenu, /browser\?\.showActive/)
  assert.match(fileTree, /<ContextMenuBridge/)
  assert.match(fileTree, /showNativeContextMenu/)
  assert.match(fileTree, /iconTextById/)
  assert.match(fileTree, /if \(nativeMenuAvailable\) \{\s*return null\s*\}/)
  assert.doesNotMatch(fileTree, /portal=\{false\}/)
  assert.match(editorContextMenu, /<ContextMenu/)
  assert.doesNotMatch(editorContextMenu, /portal=\{false\}/)
  assert.match(skillsCenter, /<ContextMenu/)
  assert.doesNotMatch(skillsCenter, /portal=\{false\}/)
  assert.match(chatPanelBody, /<ContextMenu[\s\S]*portal/)
  assert.match(browserContextMenu, /menu\.popup\(\{ window: this\.host\.mainWindow \}\)/)
  assert.match(nativeMenuIpc, /Menu\.buildFromTemplate\(template\)/)
  assert.match(nativeMenuIpc, /menu\.popup\(/)
  assert.match(preload, /showNativeContextMenu/)
})

test('the files panel stylesheet keeps only the tree row flash, on tokens, and the hand-rolled menu helpers are gone', () => {
  const styles = readWorkspaceFile('src/renderer/components/layout/filesPanelFloatingMenu.css')
  const shell = readRendererStyles()

  // B13: the file panel's menus moved to the shared float (FloatPanel + MenuList); its stylesheet keeps only the
  // tree's row flash, on --rn-* tokens, and no blur of its own (W1 §4). The private menu helpers
  // (ui/floatingMenuStyles.ts) and their .ready-floating-menu classes are deleted (W1 DS4: one menu implementation).
  assert.doesNotMatch(styles, /\.ready-floating-menu/)
  assert.doesNotMatch(styles, /backdrop-filter/)
  assert.match(styles, /@keyframes file-tree-flash-glow[\s\S]*var\(--rn-accent-soft\)/)
  assert.doesNotMatch(shell, /\.ready-floating-menu|\.chat-header-floating-menu/)
  assert.equal(existsSync(resolve(process.cwd(), 'src/renderer/components/ui/floatingMenuStyles.ts')), false)
})
