import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench mode outlet keeps bidirectional slide with finishing stage', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')

  assert.match(
    outlet,
    /type TransitionStage = 'settled' \| 'preparing' \| 'animating' \| 'finishing'/,
    'TransitionStage union must include finishing',
  )

  const leavingOffsetMatch = outlet.match(/MODE_LEAVING_OFFSET_PERCENT\s*=\s*(\d+)/)
  assert.ok(leavingOffsetMatch, 'MODE_LEAVING_OFFSET_PERCENT must be declared')
  const leavingOffset = Number(leavingOffsetMatch![1])
  assert.ok(leavingOffset >= 24, `leaving slide offset must be >= 24% (got ${leavingOffset})`)

  const enteringOffsetMatch = outlet.match(/MODE_ENTERING_OFFSET_PERCENT\s*=\s*(\d+)/)
  assert.ok(enteringOffsetMatch, 'MODE_ENTERING_OFFSET_PERCENT must be declared')
  const enteringOffset = Number(enteringOffsetMatch![1])
  assert.ok(enteringOffset >= 24, `entering slide offset must be >= 24% (got ${enteringOffset})`)

  assert.match(outlet, /MODE_LEAVING_FADE_OPACITY\s*=\s*0\.\d+/)
  assert.match(outlet, /onTransitionEnd=\{handleTransitionEnd\}/)
  assert.match(outlet, /handleLeavingTransformEnd/)
  assert.match(outlet, /MODE_FINISHING_SAFETY_MS\s*=\s*\d+/)
})
