import assert from 'node:assert/strict'
import test from 'node:test'

import { parkedBrowserHostBounds } from '../main/modules/browser-engine/host-types'

test('a parked agent view stays offscreen while retaining a usable viewport', () => {
  assert.deepEqual(
    parkedBrowserHostBounds({ x: 40, y: 80, width: 960.4, height: 639.6 }),
    { x: -100000, y: -100000, width: 960, height: 640 },
  )
})
