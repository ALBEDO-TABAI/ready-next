/**
 * 阅读模式翻页控制器合同：
 * idle→dragging→settling→idle 迁移；commit/revert 阈值（进度/甩动速度）；
 * 弹簧收敛；脚本翻页与拖拽同一条 settle 路径；cancel 不提交；settle 中途可接管。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBookFlipController,
  resolveBookKeyboardAction,
  resolveDirectedPageX,
  type BookFlipFrameState,
  type BookFlipSettleResult,
} from '../renderer/modules/document/book/bookFlipController'

test('键盘翻页合同：Space 与 Shift+Space 分向，首尾和 Escape 保持独立动作', () => {
  assert.equal(resolveBookKeyboardAction(' '), 'forward')
  assert.equal(resolveBookKeyboardAction(' ', true), 'backward')
  assert.equal(resolveBookKeyboardAction('ArrowRight'), 'forward')
  assert.equal(resolveBookKeyboardAction('PageUp'), 'backward')
  assert.equal(resolveBookKeyboardAction('Home'), 'first')
  assert.equal(resolveBookKeyboardAction('End'), 'last')
  assert.equal(resolveBookKeyboardAction('Escape'), 'escape')
  assert.equal(resolveBookKeyboardAction('Enter'), null)
})

test('拖拽坐标越过书脊后保持负值，正反向都持续向完成态推进', () => {
  assert.equal(resolveDirectedPageX(800, 500, 'forward'), 300)
  assert.equal(resolveDirectedPageX(400, 500, 'forward'), -100)
  assert.equal(resolveDirectedPageX(200, 500, 'backward'), 300)
  assert.equal(resolveDirectedPageX(600, 500, 'backward'), -100)
})

function createHarness() {
  let now = 0
  const queue: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let nextTimerId = 1
  const frames: BookFlipFrameState[] = []
  const settles: BookFlipSettleResult[] = []
  const events: string[] = []
  const controller = createBookFlipController({
    now: () => now,
    raf: (cb) => {
      queue.push(cb)
      return queue.length
    },
    cancelRaf: (id) => {
      queue[id - 1] = () => undefined
    },
    setTimeout: (cb) => {
      const id = nextTimerId++
      timers.set(id, cb)
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
    pageWidth: () => 420,
    pageHeight: () => 560,
    onFrame: (state) => {
      frames.push(state)
      events.push(`frame:${state.phase}`)
    },
    onSettle: (result) => {
      settles.push(result)
      events.push('settle')
    },
  })
  const step = (ms = 8) => {
    now += ms
    const cb = queue.shift()
    if (cb) cb()
  }
  const runUntil = (predicate: () => boolean, maxMs = 4000) => {
    let elapsed = 0
    while (!predicate() && elapsed < maxMs) {
      step(8)
      elapsed += 8
    }
  }
  const advance = (ms: number) => {
    now += ms
  }
  const fireSettleTimeout = () => {
    const callbacks = [...timers.values()]
    timers.clear()
    callbacks.forEach((cb) => cb())
  }
  return { controller, frames, settles, events, step, runUntil, advance, fireSettleTimeout }
}

test('拖拽过半松手：commit 并回零待下次', () => {
  const { controller, settles, runUntil } = createHarness()
  controller.press('forward', 380, 0.9)
  controller.move(60, 0.85) // theta ≈ π·320/(1.35·420) ≈ 1.77 > π/2
  assert.ok(controller.getState().theta > Math.PI / 2)
  controller.release()
  runUntil(() => settles.length === 1)
  assert.equal(settles[0].committed, true)
  assert.equal(settles[0].direction, 'forward')
  assert.equal(controller.getState().phase, 'idle')
  assert.ok(controller.getState().theta < 0.001)
  controller.dispose()
})

test('纵向抓取方向按页高归一化后进入形变状态', () => {
  const { controller } = createHarness()
  controller.press('forward', 380, 0.85)
  controller.move(260, 0.25)
  assert.ok(controller.getState().skew < -0.8, `向上拖动应形成明显负偏斜：${controller.getState().skew}`)
  controller.cancel()
  controller.dispose()
})

test('点击翻页保留抓取高度，上下页角不再共用同一形变', () => {
  const top = createHarness()
  top.controller.press('forward', 380, 0.1)
  top.controller.flipTo('forward')
  assert.ok(top.controller.getState().skew < -0.5)
  top.controller.dispose()

  const bottom = createHarness()
  bottom.controller.press('forward', 380, 0.9)
  bottom.controller.flipTo('forward')
  assert.ok(bottom.controller.getState().skew > 0.5)
  bottom.controller.dispose()
})

test('拖拽不足且速度归零：revert 回起点', () => {
  const { controller, settles, runUntil } = createHarness()
  controller.press('forward', 380, 0.9)
  controller.move(340, 0.9) // theta ≈ 0.22
  controller.release()
  runUntil(() => settles.length === 1)
  assert.equal(settles[0].committed, false)
  assert.ok(controller.getState().theta < 0.001)
  controller.dispose()
})

test('快速甩动不过半：按速度 commit（flick）', () => {
  const { controller, settles, runUntil, advance } = createHarness()
  controller.press('forward', 380, 0.9)
  advance(10)
  controller.move(340, 0.9)
  advance(10)
  controller.move(300, 0.9)
  advance(10)
  controller.move(260, 0.9)
  // 30ms 内 theta 0→0.66 ≈ 22rad/s，远超阈值 2.4
  assert.ok(controller.getState().theta < Math.PI / 2)
  controller.release()
  runUntil(() => settles.length === 1)
  assert.equal(settles[0].committed, true)
  controller.dispose()
})

test('脚本翻页 flipTo：与拖拽同一 settle 路径，提交一次', () => {
  const { controller, frames, settles, runUntil } = createHarness()
  controller.flipTo('forward')
  runUntil(() => settles.length === 1)
  assert.deepEqual(settles[0], { committed: true, direction: 'forward' })
  assert.ok(frames.every((frame) => frame.direction === 'forward'))
  assert.ok(frames.some((frame) => frame.phase === 'settling'))
  controller.dispose()
})

test('落定交接：先通知静态页换新，再隐藏活动叶片', () => {
  const { controller, settles, events, runUntil } = createHarness()
  controller.flipTo('forward')
  runUntil(() => settles.length === 1)
  assert.deepEqual(events.slice(-2), ['settle', 'frame:idle'])
  controller.dispose()
})

test('窗口暂停动画帧时，落定看门狗仍会完成翻页并清除活动叶片', () => {
  const { controller, settles, fireSettleTimeout } = createHarness()
  controller.flipTo('forward')
  assert.equal(controller.getState().phase, 'settling')
  fireSettleTimeout()
  assert.deepEqual(settles, [{ committed: true, direction: 'forward' }])
  assert.equal(controller.getState().phase, 'idle')
  assert.equal(controller.getState().active, false)
  controller.dispose()
})

test('cancel：回零、不提交、可复用', () => {
  const { controller, settles, runUntil } = createHarness()
  controller.press('forward', 380, 0.9)
  controller.move(120, 0.9)
  controller.cancel()
  assert.equal(controller.getState().phase, 'idle')
  assert.ok(controller.getState().theta < 0.001)
  assert.equal(settles.length, 0)
  controller.flipTo('backward')
  runUntil(() => settles.length === 1)
  assert.equal(settles[0].direction, 'backward')
  controller.dispose()
})

test('settle 中途同向接管：保留手感继续拖拽', () => {
  const { controller, settles, runUntil, step } = createHarness()
  controller.press('forward', 380, 0.9)
  controller.move(120, 0.9)
  controller.release()
  step(16)
  step(16)
  assert.equal(controller.getState().phase, 'settling')
  controller.press('forward', 300, 0.9)
  assert.equal(controller.getState().phase, 'dragging')
  assert.ok(controller.getState().theta > 0.5, '接管应保留当前 theta')
  controller.release()
  runUntil(() => settles.length === 1)
  controller.dispose()
})

test('点击提交可从 dragging 原位接续；反向 press 于 settle 中被拒绝', () => {
  const { controller, settles, runUntil, step } = createHarness()
  controller.press('forward', 380, 0.9)
  controller.move(350, 0.9)
  const beforeTap = controller.getState().theta
  controller.flipTo('forward')
  assert.equal(controller.getState().phase, 'settling')
  assert.equal(controller.getState().theta, beforeTap, '点击提交不应先回零')
  step(16)
  assert.equal(controller.getState().phase, 'settling')
  controller.press('backward', 300, 0.9)
  assert.equal(controller.getState().phase, 'settling', '反向接管不应生效')
  runUntil(() => settles.length === 1)
  assert.equal(settles[0].committed, true)
  controller.dispose()
})
