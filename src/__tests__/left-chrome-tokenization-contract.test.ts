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

test('icon rail and mode rail carry their own base materials after the liquid glass polish', () => {
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  // 8ab48cd7 style(ui): checkpoint liquid glass polish — 基础槽位不再消费共享 rail-slot token：
  // icon rail 改中性实底凹槽，四模式槽改 Ready 橙渐变轨道；track/::before 覆层同步去 token 化。
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?border:\s*0\.5px solid rgba\(255, 255, 255, 0\.34\)/)
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?background:\s*rgba\(214, 214, 211, 0\.86\)/)
  assert.match(
    styles,
    /\.icon-rail-slider\s*\{[\s\S]*?box-shadow:\s*inset 0 1px 0 rgba\(255, 255, 255, 0\.46\),\s*inset 0 -1px 0 rgba\(42, 45, 48, 0\.045\)/,
  )
  assert.match(styles, /\.icon-rail-slider__track\s*\{[\s\S]*?background:\s*transparent/)

  assert.match(
    styles,
    /\.draggable-mode-tabs\s*\{[\s\S]*?border:\s*0\.5px solid color-mix\(in srgb, var\(--color-ready-orange\) 46%, rgba\(92, 26, 10, 0\.38\)\)/,
  )
  assert.match(
    styles,
    /\.draggable-mode-tabs\s*\{[\s\S]*?background:\s*linear-gradient\(180deg, color-mix\(in srgb, var\(--color-ready-orange, #ff4b2b\) 84%, white\) 0%, var\(--color-ready-orange, #ff4b2b\) 54%, color-mix\(in srgb, var\(--color-ready-orange, #ff4b2b\) 86%, black\) 100%\)/,
  )
  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?box-shadow:\s*inset 0 1px 0 rgba\(255, 255, 255, 0\.24\)/)
  assert.match(
    styles,
    /\.draggable-mode-tabs::before\s*\{[\s\S]*?background:\s*linear-gradient\(90deg, rgba\(255, 255, 255, 0\.14\), transparent 18%, transparent 82%, rgba\(71, 13, 3, 0\.06\)\)/,
  )
})
