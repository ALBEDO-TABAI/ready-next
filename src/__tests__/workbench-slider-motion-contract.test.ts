import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('icon rail slider reuses the same motion profile as the workbench mode slider', () => {
  const modeTabs = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')
  const iconRailGroup = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')
  const motionProfile = readWorkspaceFile('src/renderer/modules/workbench/slider-motion.ts')

  assert.match(modeTabs, /from '\.\.\/\.\.\/modules\/workbench\/slider-motion'/)
  assert.match(modeTabs, /WORKBENCH_SLIDER_SPRING/)
  assert.match(modeTabs, /WORKBENCH_SLIDER_FRAME_STEP/)

  assert.match(iconRailGroup, /from '\.\.\/\.\.\/modules\/workbench\/slider-motion'/)
  assert.match(iconRailGroup, /WORKBENCH_SLIDER_MOTION_TRANSITION/)
  assert.match(iconRailGroup, /REDUCED_MOTION_TRANSITION/)

  assert.match(motionProfile, /stiffness:\s*120/)
  assert.match(motionProfile, /damping:\s*40/)
  assert.match(motionProfile, /mass:\s*1\.8/)
  assert.match(motionProfile, /WORKBENCH_SLIDER_FRAME_STEP = 0\.016/)
})
