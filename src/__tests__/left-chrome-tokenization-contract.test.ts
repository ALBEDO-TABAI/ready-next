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

test('files side panel shell styling comes from shared shell tokens instead of dark-only patch rules', () => {
  const styles = readRendererStyles()

  assert.match(
    styles,
    /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?background:\s*var\(--workbench-side-panel-bg\)/,
  )
  assert.match(
    styles,
    /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?border-color:\s*var\(--workbench-side-panel-border\)/,
  )
  assert.match(
    styles,
    /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?box-shadow:\s*var\(--workbench-side-panel-shadow\)/,
  )
})

test('icon rail stays transparent with shared glyph tokens', () => {
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  // 2026-10-30 icon rail 改为贴边图标列：无槽底、无 track，配色只走自身 --icon-rail-* 令牌。
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?background:\s*transparent/)
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?--icon-rail-ink:\s*var\(--text-muted\)/)
  assert.doesNotMatch(styles, /\.icon-rail-slider__track/)

})
