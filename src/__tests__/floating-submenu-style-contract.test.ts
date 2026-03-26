import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildFloatingMenuCheckStyle } from '../renderer/components/ui/floatingMenuStyles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('button-triggered dropdown menus opt into the shared frosted submenu treatment', () => {
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')

  assert.match(filesPanel, /glass-surface-floating ready-floating-menu/)
  assert.match(filesPanel, /ready-floating-menu-item/)
  assert.match(filesPanel, /className="glass-surface-floating ready-floating-menu"/)
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
  assert.match(filesPanel, /const moreMenuStyle = buildFloatingMenuSurfaceStyle\(188/)
})

test('shared submenu styles use the denser browser-like frosted background and hover treatment', () => {
  const styles = readWorkspaceFile('src/renderer/components/layout/filesPanelFloatingMenu.css')

  assert.match(styles, /\.ready-floating-menu\s*\{/)
  assert.match(styles, /rgba\(236,\s*239,\s*243,\s*0\.92\)/)
  assert.match(styles, /rgba\(246,\s*248,\s*251,\s*0\.72\)/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.ready-floating-menu\s*\{/)
  assert.match(styles, /backdrop-filter:\s*blur\(calc\(var\(--lg-blur-strong\) \* 1\.28\)\)/)
  assert.match(styles, /\.ready-floating-menu-item:hover\s*\{/)
})

test('floating submenu check indicators stay neutral instead of blue', () => {
  const checkedStyle = buildFloatingMenuCheckStyle(true)
  const uncheckedStyle = buildFloatingMenuCheckStyle(false)

  assert.doesNotMatch(String(checkedStyle.border), /color-blue/)
  assert.doesNotMatch(String(checkedStyle.background), /color-blue/)
  assert.doesNotMatch(String(checkedStyle.background), /linear-gradient/)
  assert.doesNotMatch(String(uncheckedStyle.border), /color-blue/)
})
