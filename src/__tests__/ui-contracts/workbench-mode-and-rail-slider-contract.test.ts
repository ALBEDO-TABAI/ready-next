import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('shell rail keeps transparent vertical groups without a track or thumb', () => {
  const iconRail = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellRail.tsx')
  const iconRailGroup = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')


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

})
