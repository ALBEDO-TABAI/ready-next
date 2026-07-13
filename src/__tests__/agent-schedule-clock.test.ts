import assert from 'node:assert/strict'
import test from 'node:test'

import { ScheduleClock } from '../main/modules/scheduled-tasks/schedule-clock'

test('schedule clock keeps one timer and replaces it on reschedule', () => {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = []
  const clock = new ScheduleClock({
    now: () => Date.parse('2026-07-13T00:00:00Z'),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false }
      timers.push(timer)
      return timer as unknown as NodeJS.Timeout
    },
    clearTimer: (handle) => { (handle as unknown as { cancelled: boolean }).cancelled = true },
  })

  clock.schedule('2026-07-13T00:10:00Z', () => undefined)
  clock.schedule('2026-07-13T00:05:00Z', () => undefined)

  assert.equal(timers[0].cancelled, true)
  assert.equal(timers[1].cancelled, false)
  assert.equal(timers[1].delay, 300_000)
})

test('schedule clock fires overdue work immediately and clears ownership', () => {
  let fired = 0
  let timer: { callback: () => void; cancelled: boolean } | null = null
  const clock = new ScheduleClock({
    now: () => 1_000,
    setTimer: (callback, delay) => {
      assert.equal(delay, 0)
      timer = { callback, cancelled: false }
      return timer as unknown as NodeJS.Timeout
    },
    clearTimer: (handle) => { (handle as unknown as { cancelled: boolean }).cancelled = true },
  })
  clock.schedule(new Date(500).toISOString(), () => { fired += 1 })
  ;(timer as unknown as { callback: () => void }).callback()
  clock.cancel()
  assert.equal(fired, 1)
  assert.equal((timer as unknown as { cancelled: boolean }).cancelled, false)
})
