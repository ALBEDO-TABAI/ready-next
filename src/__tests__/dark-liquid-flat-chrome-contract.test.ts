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
  const panelBlock = styles.match(/html\[data-theme='dark'\]:root \.glass-surface-panel\s*\{([\s\S]*?)\n\}/)
  const cardBlock = styles.match(/html\[data-theme='dark'\]:root \.glass-surface-card\s*\{([\s\S]*?)\n\}/)

  assert.match(styles, /html\[data-theme='dark'\]:root \.glass-surface-panel\s*\{/)
  assert.ok(panelBlock)
  assert.ok(cardBlock)
  assert.doesNotMatch(panelBlock[1], /radial-gradient\(/)
  assert.doesNotMatch(panelBlock[1], /linear-gradient\(180deg,\s*color-mix\(in srgb,\s*var\(--lg-specular-top\)/)
  assert.doesNotMatch(cardBlock[1], /radial-gradient\(/)
})

test('the shared sidebar identifies its mode and stays transparent on the window glass', () => {
  const sidebar = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const styles = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')

  assert.match(sidebar, /data-shell-sidebar="true"/)
  assert.match(sidebar, /data-shell-sidebar-mode=\{mode\}/)
  assert.match(sidebar, /className=\{`shell-sidebar workbench-panel-frame/)
  assert.match(styles, /\.shell-sidebar:not\(\.shell-float-drawer\)\s*\{\s*background:\s*transparent;\s*box-shadow:\s*none;/)
})
