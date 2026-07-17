import assert from 'node:assert/strict'
import test from 'node:test'

import { OverlayWindowFollower } from '../main/modules/browser-engine/overlay-window-follower'

test('overlay follower collapses a move storm to leading and trailing frame updates', () => {
  let applyCalls = 0
  let scheduled: (() => void) | null = null
  const follower = new OverlayWindowFollower({
    apply: () => { applyCalls += 1 },
    getDisplayMatching: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      workArea: { x: 0, y: 0, width: 1000, height: 760 },
    }),
    setTimeout: (callback) => {
      scheduled = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => { scheduled = null },
  })

  for (let index = 0; index < 100; index += 1) follower.schedule()
  assert.equal(applyCalls, 1)
  assert.ok(scheduled)
  ;(scheduled as () => void)()
  assert.equal(applyCalls, 2)
})

test('overlay follower reuses the display until the parent crosses display bounds', () => {
  let matchingCalls = 0
  const follower = new OverlayWindowFollower({
    apply: () => undefined,
    getDisplayMatching: (bounds) => {
      matchingCalls += 1
      const second = bounds.x >= 1000
      return {
        id: second ? 2 : 1,
        bounds: { x: second ? 1000 : 0, y: 0, width: 1000, height: 800 },
        workArea: { x: second ? 1000 : 0, y: 0, width: 1000, height: 760 },
      }
    },
  })
  follower.displayFor({ x: 100, y: 100, width: 800, height: 600 })
  follower.displayFor({ x: 120, y: 100, width: 800, height: 600 })
  follower.displayFor({ x: 1200, y: 100, width: 700, height: 600 })
  assert.equal(matchingCalls, 2)
})

test('temporarily hiding an overlay cancels work without losing display tracking', () => {
  let subscriptions = 0
  let unsubscriptions = 0
  const follower = new OverlayWindowFollower({
    apply: () => undefined,
    getDisplayMatching: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      workArea: { x: 0, y: 0, width: 1000, height: 760 },
    }),
    onDisplayMetricsChanged: () => { subscriptions += 1 },
    offDisplayMetricsChanged: () => { unsubscriptions += 1 },
  })

  follower.cancel()
  assert.equal(subscriptions, 1)
  assert.equal(unsubscriptions, 0)

  follower.dispose()
  assert.equal(unsubscriptions, 1)
})
