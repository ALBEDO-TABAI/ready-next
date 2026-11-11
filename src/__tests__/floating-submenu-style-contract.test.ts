import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildFloatingMenuCheckStyle } from '../renderer/components/ui/floatingMenuStyles'
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
  assert.match(filesPanel, /ready-floating-menu-item/)
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
  assert.match(filesPanel, /const filterMenuStyle = buildFloatingMenuSurfaceStyle\(168/)
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

  assert.match(contextMenu, /portal = true/)
  assert.match(contextMenu, /createPortal\(menu, document\.body\)/)
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

test('shared submenu styles use the denser browser-like frosted background and hover treatment', () => {
  const styles = readWorkspaceFile('src/renderer/components/layout/filesPanelFloatingMenu.css')
  const themeStyles = readRendererStyles()
  const menuHelpers = readWorkspaceFile('src/renderer/components/ui/floatingMenuStyles.ts')

  assert.match(styles, /\.ready-floating-menu\s*\{/)
  assert.match(styles, /background:\s*var\(--chat-menu-frost-bg\) !important/)
  assert.match(styles, /background:\s*var\(--chat-menu-hover-bg\) !important/)
  assert.match(styles, /html:root \.ready-floating-menu\s*\{/)
  assert.match(styles, /backdrop-filter:\s*blur\(calc\(var\(--lg-blur-strong\) \* 1\.28\)\)/)
  assert.match(styles, /\.ready-floating-menu-item:hover\s*\{/)
  assert.match(themeStyles, /html\[data-theme='dark'\]\s*\{[\s\S]*--chat-menu-frost-bg:\s*color-mix\(in srgb,\s*var\(--surface-floating-bg\) 88%,\s*rgba\(255,\s*255,\s*255,\s*0\.02\)\);/)
  assert.match(menuHelpers, /background:\s*'var\(--chat-menu-frost-bg,/)
  assert.doesNotMatch(styles, /rgba\(236,\s*239,\s*243,\s*0\.92\) !important/)
})

test('floating submenu check indicators stay neutral instead of blue', () => {
  const checkedStyle = buildFloatingMenuCheckStyle(true)
  const uncheckedStyle = buildFloatingMenuCheckStyle(false)

  assert.doesNotMatch(String(checkedStyle.border), /color-blue/)
  assert.doesNotMatch(String(checkedStyle.background), /color-blue/)
  assert.doesNotMatch(String(checkedStyle.background), /linear-gradient/)
  assert.doesNotMatch(String(checkedStyle.background), /255,255,255,0\.82/)
  assert.doesNotMatch(String(uncheckedStyle.border), /color-blue/)
})
