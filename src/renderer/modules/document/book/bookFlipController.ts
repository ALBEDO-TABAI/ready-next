/**
 * bookFlipController.ts — 翻页运动状态机（纯逻辑，不触碰 DOM）。
 *
 * 状态机：idle → dragging → settling → idle。
 * 拖拽、松手弹簧、脚本翻页（键盘/按钮/滑杆）全部走同一条 Θ 轨道，
 * 消灭「只有边缘拖拽才有翻页动效」的硬切。视图层通过 onFrame 拿到
 * 逐帧 {theta, skew} 驱动 Leaf transform，通过 onSettle 提交页索引。
 */

import { BOOK_CURL_MAX_ANGLE, resolveDragSkew } from './bookCurlMath'

export type BookFlipPhase = 'idle' | 'dragging' | 'settling'
export type BookFlipDirection = 'forward' | 'backward'
export type BookKeyboardAction = BookFlipDirection | 'first' | 'last' | 'escape' | null

export function resolveBookKeyboardAction(key: string, shiftKey = false): BookKeyboardAction {
  if (key === 'Escape') return 'escape'
  if (key === 'ArrowRight' || key === 'PageDown' || (key === ' ' && !shiftKey)) return 'forward'
  if (key === 'ArrowLeft' || key === 'PageUp' || (key === ' ' && shiftKey)) return 'backward'
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  return null
}

export interface BookFlipFrameState {
  phase: BookFlipPhase
  direction: BookFlipDirection
  theta: number
  skew: number
  /** 当前角速度（rad/s）；拖拽方向与松手动量共同塑造叶片曲率。 */
  velocity: number
  /** Leaf 是否应可见（dragging/settling 为 true） */
  active: boolean
}

export interface BookFlipSettleResult {
  committed: boolean
  direction: BookFlipDirection
}

export interface BookFlipControllerDeps {
  now: () => number
  raf: (cb: () => void) => number
  cancelRaf: (id: number) => void
  setTimeout: (cb: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  pageWidth: () => number
  pageHeight: () => number
  onFrame: (state: BookFlipFrameState) => void
  onSettle: (result: BookFlipSettleResult) => void
}

/** 指针越过书脊后必须保留负值，否则进度会在书脊处掉头并回弹。 */
export function resolveDirectedPageX(
  pointerX: number,
  spineX: number,
  direction: BookFlipDirection,
): number {
  const fromSpine = pointerX - spineX
  return direction === 'forward' ? fromSpine : -fromSpine
}

export interface BookFlipController {
  /** 按下：nx 为页局部 x（书脊=0，页缘=页宽），ny ∈ [0,1]。
   *  拖拽为相对模型：页角从页缘出发，跟随指针位移（theta 在按下时连续）。 */
  press: (direction: BookFlipDirection, nx: number, ny: number) => void
  move: (nx: number, ny: number) => void
  release: () => void
  /** 脚本翻页：以初速度驱向完成态；settle 路径与拖拽完全一致 */
  flipTo: (direction: BookFlipDirection) => void
  /** 打断（重排/退出/场景隐藏）：回零且不调 onSettle */
  cancel: () => void
  isAnimating: () => boolean
  getState: () => BookFlipFrameState
  dispose: () => void
}

/** 弹簧参数：保留一次可感知的减速与轻回弹，不做线性收页。 */
const SPRING_STIFFNESS = 130
const SPRING_DAMPING = 18
/** 松手速度阈值（rad/s）：超过即按甩动方向收束 */
const FLICK_VELOCITY = 2.4
const SCRIPTED_FLIP_VELOCITY = 3.5
const MAX_INHERIT_VELOCITY = 8
const SETTLE_EPSILON_ANGLE = 0.003
const SETTLE_EPSILON_VELOCITY = 0.06
const VELOCITY_SAMPLE_WINDOW_MS = 90
const SETTLE_WATCHDOG_MS = 900

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function createBookFlipController(deps: BookFlipControllerDeps): BookFlipController {
  let phase: BookFlipPhase = 'idle'
  let direction: BookFlipDirection = 'forward'
  let theta = 0
  let skew = 0
  let velocity = 0
  let springTarget = 0
  let rafId: number | null = null
  let settleTimerId: number | null = null
  let lastTickAt = 0
  let grabNy = 0.5
  let pressNx = 0
  let pressTheta = 0
  let samples: Array<{ t: number; theta: number }> = []
  let disposed = false

  const emit = () => {
    if (disposed) return
    deps.onFrame({
      phase,
      direction,
      theta,
      skew,
      velocity,
      active: phase !== 'idle' || theta > 1e-4,
    })
  }

  const stopLoop = () => {
    if (rafId !== null) {
      deps.cancelRaf(rafId)
      rafId = null
    }
  }

  const clearSettleWatchdog = () => {
    if (settleTimerId !== null) {
      deps.clearTimeout(settleTimerId)
      settleTimerId = null
    }
  }

  const convergeIfSettled = (): boolean => {
    if (Math.abs(theta - springTarget) > SETTLE_EPSILON_ANGLE) return false
    if (Math.abs(velocity) > SETTLE_EPSILON_VELOCITY) return false
    theta = springTarget
    velocity = 0
    stopLoop()
    return true
  }

  const finishSettle = () => {
    clearSettleWatchdog()
    const committed = springTarget > Math.PI / 2
    // 先让视图同步换好落地后的静态对开页，再隐藏活动叶片；否则会短暂露出旧页。
    deps.onSettle({ committed, direction })
    phase = 'idle'
    theta = 0
    skew = 0
    emit()
  }

  const tick = () => {
    rafId = null
    if (disposed) return
    const t = deps.now()
    const dt = clamp((t - lastTickAt) / 1000, 0.001, 0.05)
    lastTickAt = t
    const acceleration = -SPRING_STIFFNESS * (theta - springTarget) - SPRING_DAMPING * velocity
    velocity += acceleration * dt
    theta += velocity * dt
    if (convergeIfSettled()) {
      if (phase === 'settling') {
        finishSettle()
        return
      }
      emit()
      return
    }
    emit()
    rafId = deps.raf(tick)
  }

  const startLoop = () => {
    if (rafId === null && !disposed) {
      lastTickAt = deps.now()
      rafId = deps.raf(tick)
    }
  }

  const trackSample = () => {
    const t = deps.now()
    samples.push({ t, theta })
    const cutoff = t - VELOCITY_SAMPLE_WINDOW_MS
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift()
  }

  const sampleVelocity = (): number => {
    if (samples.length < 2) return 0
    const first = samples[0]
    const last = samples[samples.length - 1]
    const dt = (last.t - first.t) / 1000
    if (dt <= 1e-3) return 0
    return (last.theta - first.theta) / dt
  }

  const press: BookFlipController['press'] = (nextDirection, nx, ny) => {
    if (disposed) return
    if (phase === 'settling' && nextDirection !== direction) return
    direction = nextDirection
    grabNy = ny
    // 点击也要保留抓取高度：上、中、下部起翻不再共用同一张动画。
    skew = clamp((ny - 0.5) * 1.4, -0.7, 0.7)
    pressNx = nx
    // 从 settle 接管时 theta 连续；否则从 0 起
    pressTheta = phase === 'settling' ? theta : 0
    clearSettleWatchdog()
    samples = []
    phase = 'dragging'
    trackSample()
    stopLoop()
    emit()
  }

  const move: BookFlipController['move'] = (nx, ny) => {
    if (phase !== 'dragging') return
    const width = Math.max(1, deps.pageWidth())
    const raw = pressTheta + (Math.PI * (pressNx - nx)) / (1.35 * width)
    theta = clamp(raw, 0, BOOK_CURL_MAX_ANGLE)
    trackSample()
    velocity = sampleVelocity()
    const height = Math.max(1, deps.pageHeight())
    skew = resolveDragSkew(ny * height, grabNy * height, height)
    emit()
  }

  const beginSettle = (target: number, initialVelocity: number) => {
    clearSettleWatchdog()
    phase = 'settling'
    springTarget = target
    velocity = clamp(initialVelocity, -MAX_INHERIT_VELOCITY, MAX_INHERIT_VELOCITY)
    settleTimerId = deps.setTimeout(() => {
      settleTimerId = null
      if (disposed || phase !== 'settling') return
      theta = springTarget
      velocity = 0
      stopLoop()
      finishSettle()
    }, SETTLE_WATCHDOG_MS)
    startLoop()
  }

  const release = () => {
    if (phase !== 'dragging') return
    const v = sampleVelocity()
    const commit = theta > Math.PI / 2 || v > FLICK_VELOCITY
    const revertFast = theta <= Math.PI / 2 && v < -FLICK_VELOCITY
    beginSettle(commit ? Math.PI : 0, revertFast ? v : v * 0.6)
  }

  const flipTo: BookFlipController['flipTo'] = (nextDirection) => {
    if (disposed || phase === 'settling') return
    const inheritedVelocity = phase === 'dragging'
      ? Math.max(sampleVelocity(), SCRIPTED_FLIP_VELOCITY)
      : SCRIPTED_FLIP_VELOCITY
    direction = nextDirection
    if (phase === 'idle') {
      theta = 0
      skew = 0
    }
    beginSettle(Math.PI, inheritedVelocity)
  }

  const cancel = () => {
    clearSettleWatchdog()
    stopLoop()
    phase = 'idle'
    theta = 0
    skew = 0
    velocity = 0
    samples = []
    emit()
  }

  return {
    press,
    move,
    release,
    flipTo,
    cancel,
    isAnimating: () => phase === 'dragging' || phase === 'settling',
    getState: () => ({ phase, direction, theta, skew, velocity, active: phase !== 'idle' || theta > 1e-4 }),
    dispose: () => {
      disposed = true
      clearSettleWatchdog()
      stopLoop()
    },
  }
}
