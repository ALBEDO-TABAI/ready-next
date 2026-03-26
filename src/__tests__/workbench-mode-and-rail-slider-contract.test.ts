import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench mode switch and icon rail share the blue slider treatment', () => {
  const modeTabs = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const iconRailGroup = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(modeTabs, /var\(--color-blue,\s*#5B8DEF\)/)

  assert.match(iconRail, /className="icon-rail-slider-shell"/)
  assert.match(iconRailGroup, /icon-rail-slider/)
  assert.match(iconRailGroup, /className="icon-rail-slider__track"/)
  assert.match(iconRailGroup, /layoutId=\{`\$\{layoutId\}-thumb`\}/)
  assert.match(iconRailGroup, /className="icon-rail-slider__thumb"/)
  assert.match(iconRailGroup, /className=\{`icon-rail-slider__button/)

  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?flex-direction:\s*column/)
  assert.match(styles, /\.icon-rail-slider\s*\{[\s\S]*?border-radius:\s*18px/)
  assert.match(styles, /\.icon-rail-slider-shell\s*\{[\s\S]*?width:\s*100%/)
  assert.match(styles, /\.icon-rail-slider-shell\s*\{[\s\S]*?justify-content:\s*flex-end/)
  assert.match(styles, /\.icon-rail-slider__thumb\s*\{[\s\S]*?height:\s*34px/)
  assert.match(styles, /\.icon-rail-slider__button\s*\{[\s\S]*?z-index:\s*3/)
})
