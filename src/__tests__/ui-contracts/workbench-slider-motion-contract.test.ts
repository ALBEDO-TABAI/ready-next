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
  assert.match(modeTabs, /WORKBENCH_SLIDER_CLICK_DURATION_MS/)
  assert.match(modeTabs, /easeWorkbenchSliderClick/)
  assert.match(modeTabs, /const startClickAnimation = useCallback\(\(\) => \{/)
  assert.match(modeTabs, /useEffect\(\(\) => \{[\s\S]*startClickAnimation\(\)/)
  assert.match(modeTabs, /handleMouseUp[\s\S]*startSpringAnimation\(\)/)

  assert.match(iconRailGroup, /from '\.\.\/\.\.\/modules\/workbench\/slider-motion'/)
  assert.match(iconRailGroup, /WORKBENCH_SLIDER_MOTION_TRANSITION/)
  assert.match(iconRailGroup, /REDUCED_MOTION_TRANSITION/)
  assert.match(iconRailGroup, /const THUMB_REOPEN_DELAY_MS = 140/)
  assert.match(iconRailGroup, /const THUMB_REST_SETTLE_MS = 120/)
  assert.match(iconRailGroup, /const ICON_RAIL_ITEM_PITCH = 40/)
  assert.match(iconRailGroup, /const thumbIndex = Math\.max\(items\.findIndex\(\(\{ id \}\) => id === thumbId\), 0\)/)
  assert.match(iconRailGroup, /const thumbOffset = thumbIndex \* ICON_RAIL_ITEM_PITCH/)
  assert.match(iconRailGroup, /animate=\{reduceMotion \? \{ y: thumbOffset \} : \{ y: thumbOffset \}\}/)
  assert.doesNotMatch(iconRailGroup, /layoutId=\{`\$\{layoutId\}-thumb`\}/)
  assert.doesNotMatch(iconRailGroup, /<motion\.button[\s\S]*layout/)
  assert.doesNotMatch(iconRailGroup, /THUMB_LIFT_BEFORE_SLIDE_MS = 1500/)
  assert.doesNotMatch(iconRailGroup, /THUMB_PRESS_SETTLE_MS = 750/)
  assert.doesNotMatch(iconRailGroup, /stiffness:\s*60/)
  assert.doesNotMatch(iconRailGroup, /mass:\s*3\.2/)

  assert.match(motionProfile, /stiffness:\s*120/)
  assert.match(motionProfile, /damping:\s*40/)
  assert.match(motionProfile, /mass:\s*1\.8/)
  assert.match(motionProfile, /WORKBENCH_SLIDER_FRAME_STEP = 0\.016/)
  assert.match(motionProfile, /WORKBENCH_SLIDER_CLICK_DURATION_MS = 200/)
  assert.match(motionProfile, /export function easeWorkbenchSliderClick\(progress: number\)/)
})
