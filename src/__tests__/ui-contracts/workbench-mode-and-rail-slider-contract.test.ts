import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench mode switch keeps the Ready accent slider geometry and the icon rail sits flush on the frame', () => {
  const modeTabs = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const iconRailGroup = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(styles, /var\(--color-ready-orange(?:,\s*#ff4b2b)?\)/)

  assert.match(iconRail, /className="icon-rail-slider-shell"/)
  assert.match(iconRailGroup, /icon-rail-slider/)
  assert.match(iconRailGroup, /className=\{`icon-rail-slider__button/)
  assert.doesNotMatch(iconRailGroup, /<motion\.button[\s\S]*layout/)
  // 2026-10-30 图标列改为 Codex 式贴边：无槽底、无滑块 thumb（激活字形行为见 icon-rail-active-glyph.test.tsx）。
  assert.doesNotMatch(iconRailGroup, /icon-rail-slider__(?:track|thumb)/)
  assert.doesNotMatch(styles, /icon-rail-slider__(?:track|thumb)/)

  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?flex-direction:\s*column/)
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?background:\s*transparent/)
  assert.doesNotMatch(styles, /\.icon-rail-slider\s*\{[^}]*border-radius/)
  assert.match(styles, /\.icon-rail-slider-shell\s*\{[\s\S]*?width:\s*100%/)
  assert.match(styles, /\.icon-rail-slider-shell\s*\{[\s\S]*?justify-content:\s*flex-start/)

  assert.match(modeTabs, /<Icon style=\{\{ width: 15, height: 15 \}\} strokeWidth=\{2\} \/>/)
  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?width:\s*140px/)
  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?height:\s*38px/)
  assert.match(styles, /\.draggable-mode-tabs\s*\{[\s\S]*?border-radius:\s*18px/)
  assert.match(styles, /\.draggable-mode-tabs__thumb\s*\{[\s\S]*?border-radius:\s*16px/)
  assert.match(modeTabs, /data-mode=\{mode\.id\}/)
  assert.match(styles, /\.draggable-mode-tabs__icon\[data-mode='calendar'\]\s+svg\s*\{[\s\S]*?transform:\s*translateX\(-0\.5px\);/)
})
