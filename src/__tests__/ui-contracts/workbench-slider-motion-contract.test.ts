import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('icon rail buttons retain direct click feedback and reduced-motion support', () => {
  const iconRailGroup = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')

  assert.match(iconRailGroup, /from '\.\.\/\.\.\/modules\/workbench\/slider-motion'/)
  // Retain direct hover/tap feedback and reduced-motion support without a sliding thumb.
  assert.match(iconRailGroup, /WORKBENCH_SLIDER_CLICK_TRANSITION/)
  assert.match(iconRailGroup, /REDUCED_MOTION_TRANSITION/)
  assert.doesNotMatch(iconRailGroup, /thumbOffset/)
  assert.doesNotMatch(iconRailGroup, /layoutId=\{`\$\{layoutId\}-thumb`\}/)
  assert.doesNotMatch(iconRailGroup, /<motion\.button[\s\S]*layout/)
  assert.doesNotMatch(iconRailGroup, /THUMB_LIFT_BEFORE_SLIDE_MS = 1500/)
  assert.doesNotMatch(iconRailGroup, /THUMB_PRESS_SETTLE_MS = 750/)
  assert.doesNotMatch(iconRailGroup, /stiffness:\s*60/)
  assert.doesNotMatch(iconRailGroup, /mass:\s*3\.2/)
})
