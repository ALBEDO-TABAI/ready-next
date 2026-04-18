import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('icon rail thumb keeps a resting depth state and lifts before sliding when reopening panels', () => {
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const iconRailGroup = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(iconRail, /expanded\?: boolean/)
  assert.match(iconRail, /expanded = true/)
  assert.match(iconRail, /expanded=\{expanded\}/)
  assert.match(workbenchMode, /<IconRail activeIcon=\{activeIcon\} onIconClick=\{handleIconClick\} hidden=\{hideIconRail\} expanded=\{sidebarVisible\} \/>/)

  assert.match(iconRailGroup, /expanded\?: boolean/)
  assert.match(iconRailGroup, /const \[thumbId, setThumbId\] = useState\(activeId\)/)
  assert.match(iconRailGroup, /const THUMB_REOPEN_DELAY_MS = 140/)
  assert.match(iconRailGroup, /const THUMB_REST_SETTLE_MS = 120/)
  assert.match(iconRailGroup, /const \[thumbState, setThumbState\] = useState<'elevated' \| 'pressing' \| 'resting'>/)
  assert.match(iconRailGroup, /setThumbState\('pressing'\)/)
  assert.match(iconRailGroup, /window\.setTimeout\(\(\) => \{\s*setThumbState\('resting'\)/)
  assert.match(iconRailGroup, /window\.setTimeout\(\(\) => \{\s*setThumbId\(activeId\)/)
  assert.match(iconRailGroup, /thumbState === 'pressing'/)
  assert.match(iconRailGroup, /thumbState === 'resting'/)
  assert.match(iconRailGroup, /isRemembered \? 'is-remembered' : ''/)
  assert.match(iconRailGroup, /thumbState === 'resting' \? 'is-resting' : thumbState === 'pressing' \? 'is-pressing' : 'is-elevated'/)
  assert.doesNotMatch(iconRailGroup, /layoutId=\{`\$\{layoutId\}-thumb`\}/)
  assert.doesNotMatch(iconRailGroup, /<motion\.button[\s\S]*layout/)
  assert.doesNotMatch(iconRailGroup, /THUMB_LIFT_BEFORE_SLIDE_MS = 1500/)
  assert.doesNotMatch(iconRailGroup, /THUMB_PRESS_SETTLE_MS = 750/)

  assert.match(styles, /\.icon-rail-slider__button\.is-remembered\s*\{/)
  assert.match(styles, /\.icon-rail-slider__thumb\.is-pressing\s*\{/)
  assert.match(styles, /\.icon-rail-slider__thumb\.is-resting\s*\{/)
  assert.match(styles, /\.icon-rail-slider__thumb\.is-elevated\s*\{/)
})
