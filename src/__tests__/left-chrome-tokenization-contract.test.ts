import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('left chrome tokens centralize side panel shell and rail track colors', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(styles, /--workbench-side-panel-bg:/)
  assert.match(styles, /--workbench-side-panel-border:/)
  assert.match(styles, /--workbench-side-panel-shadow:/)
  assert.match(styles, /--workbench-rail-slot-bg:/)
  assert.match(styles, /--workbench-rail-slot-border:/)
  assert.match(styles, /--workbench-rail-slot-shadow:/)
  assert.match(styles, /--workbench-rail-slot-overlay:/)
})

test('files side panel shell styling comes from shared shell tokens instead of dark-only patch rules', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

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

test('icon rail and mode rail consume the same shared track tokens', () => {
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?border:\s*1px solid var\(--workbench-rail-slot-border\)/)
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-bg\)/)
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?box-shadow:\s*var\(--workbench-rail-slot-shadow\)/)
  assert.match(styles, /\.icon-rail-slider__track\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-overlay\)/)

  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?border:\s*1px solid var\(--workbench-rail-slot-border\)/)
  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-bg\)/)
  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?box-shadow:\s*var\(--workbench-rail-slot-shadow\)/)
  assert.match(styles, /\.draggable-mode-tabs::before\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-overlay\)/)
})
