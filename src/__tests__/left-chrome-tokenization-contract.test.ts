import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('left chrome tokens centralize side panel shell and rail track colors', () => {
  const styles = readRendererStyles()

  assert.match(styles, /--workbench-side-panel-bg:/)
  assert.match(styles, /--workbench-side-panel-border:/)
  assert.match(styles, /--workbench-side-panel-shadow:/)
  assert.match(styles, /--workbench-rail-slot-bg:/)
  assert.match(styles, /--workbench-rail-slot-border:/)
  assert.match(styles, /--workbench-rail-slot-shadow:/)
  assert.match(styles, /--workbench-rail-slot-overlay:/)
})

test('the shell sidebar sits on the window glass in both themes, with no dark-only patch rules', () => {
  const styles = readRendererStyles()
  const shell = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')

  // W2 §2.2: one sidebar column, no frame of its own; the navigator inside draws on the glass.
  assert.match(shell, /\.shell-sidebar:not\(\.shell-float-drawer\)\s*\{[\s\S]*?background:\s*transparent/)
  assert.match(shell, /\.shell-sidebar:not\(\.shell-float-drawer\)\s*\{[\s\S]*?box-shadow:\s*none/)
  // The old per-variant frame is gone, and nothing patches the sidebar for dark mode alone.
  assert.doesNotMatch(styles, /data-side-panel-variant/)
  assert.doesNotMatch(styles, /\[data-theme=['"]dark['"]\][^{]*(?:\.shell-sidebar|\[data-shell-sidebar)/)
})

test('icon rail stays transparent with shared glyph tokens', () => {
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  // 2026-10-30 icon rail 改为贴边图标列：无槽底、无 track。B13：选中字形与底块只走 --rn-rail-*（tokens.css）。
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?background:\s*transparent/)
  assert.match(styles, /\.icon-rail-slider__button\.is-active,[\s\S]*?color:\s*var\(--rn-rail-glyph\);\s*background:\s*var\(--rn-rail-tile\)/)
  assert.match(styles, /\.icon-rail-slider__button\.is-remembered,[\s\S]*?color:\s*var\(--rn-rail-glyph\);\s*background:\s*transparent/)
  assert.doesNotMatch(styles, /\.icon-rail-slider__track/)

})
