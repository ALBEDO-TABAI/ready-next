import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid chrome removes the old top-edge glow from shared panel surfaces', () => {
  const styles = readRendererStyles()
  // B13: the legacy panel/card surfaces are token-only regions on the glass; no theme needs its own patch rule.
  const panelBlock = styles.match(/\n\.glass-surface-panel\s*\{([\s\S]*?)\n\}/)
  const cardBlock = styles.match(/\n\.glass-surface-card\s*\{([\s\S]*?)\n\}/)
  assert.ok(panelBlock)
  assert.ok(cardBlock)
  assert.doesNotMatch(styles, /html\[data-theme='dark'\]:root \.glass-surface-(?:panel|card)\s*\{/)
  assert.doesNotMatch(panelBlock[1], /gradient\(|backdrop-filter/)
  assert.doesNotMatch(cardBlock[1], /gradient\(|backdrop-filter/)
})

test('the shared sidebar identifies its mode; its column paints nothing and, docked, its slot is the panel glass (V18)', () => {
  const sidebar = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const styles = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')

  assert.match(sidebar, /data-shell-sidebar="true"/)
  assert.match(sidebar, /data-shell-sidebar-mode=\{mode\}/)
  assert.match(sidebar, /className=\{`shell-sidebar workbench-panel-frame/)
  assert.match(styles, /\.shell-sidebar:not\(\.shell-float-drawer\)\s*\{\s*background:\s*transparent;\s*box-shadow:\s*none;/)
  assert.match(sidebar, /className=\{`shell-sidebar__slot\$\{floating \? '' : ' rn-panel'\}`\}/)
})
