// Stage 1 contract: window-material module 状态表 + computeMaterial 行为。
//
// 这是窗口材料逻辑的核心契约。任何想改材料策略的 PR 都必须先改这份测试，
// 改测试时必须能解释清楚为什么这是 spec §1-4 允许的变化。
//
// spec: docs/superpowers/specs/2026-05-16-liquid-glass-ui-layering-and-motion-contract.md

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyMaterial,
  computeMaterial,
  DARWIN_LIQUID_GLASS_TRANSPARENT,
  NON_DARWIN_BACKGROUND_DARK,
  NON_DARWIN_BACKGROUND_LIGHT,
  createWindowMaterialController,
  type MaterialInputs,
  type MaterialOutputs,
} from '../main/modules/window-material/main-window-material'

test('module exports the public surface required by main/index.ts', () => {
  assert.equal(typeof computeMaterial, 'function')
  assert.equal(typeof applyMaterial, 'function')
  assert.equal(typeof createWindowMaterialController, 'function')

  const sampleInput: MaterialInputs = {
    platform: 'darwin',
    skin: 'liquid-glass',
    resolvedTheme: 'dark',
    isFullscreen: false,
  }
  assert.deepEqual(computeMaterial(sampleInput), {
    backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT,
    vibrancy: 'under-window',
  })
})

test('验证 2 — Darwin computeMaterial returns frozen { transparent, under-window } for every input', () => {
  // 验证 2 架构：darwin 上 CALayer 永远透明，vibrancy 永远 under-window。所有 skin / fullscreen
  // / resolvedTheme 组合都映射到同一个稳定输出——backing 完全由 DOM 层 .ready-app-bg 承担。
  // 这是防"CALayer opaque 覆盖 → NSVisualEffectView 静默 quiesce → 切回透明黑屏"的核心合同。
  const expected = { backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT, vibrancy: 'under-window' } as const
  for (const skin of ['liquid-glass', 'ready-glass'] as const) {
    for (const isFullscreen of [false, true]) {
      for (const resolvedTheme of ['light', 'dark'] as const) {
        assert.deepEqual(
          computeMaterial({ platform: 'darwin', skin, resolvedTheme, isFullscreen }),
          expected,
          `darwin/${skin}/fs=${isFullscreen}/${resolvedTheme} must always be transparent+under-window`,
        )
      }
    }
  }
})

test('Non-darwin platforms use neutral theme-matched bg, never vibrancy', () => {
  // Win/Linux 不区分 skin 也不区分 fullscreen —— Bug 2 桌面采样泄漏只在 macOS vibrancy 发生
  for (const platform of ['win32', 'linux'] as const) {
    for (const skin of ['liquid-glass', 'ready-glass'] as const) {
      for (const isFullscreen of [false, true]) {
        const lightResult = computeMaterial({ platform, skin, resolvedTheme: 'light', isFullscreen })
        assert.deepEqual(
          lightResult,
          { backgroundColor: NON_DARWIN_BACKGROUND_LIGHT, vibrancy: null },
          `${platform}/${skin}/fs=${isFullscreen}/light should use NON_DARWIN_BACKGROUND_LIGHT`,
        )
        const darkResult = computeMaterial({ platform, skin, resolvedTheme: 'dark', isFullscreen })
        assert.deepEqual(
          darkResult,
          { backgroundColor: NON_DARWIN_BACKGROUND_DARK, vibrancy: null },
          `${platform}/${skin}/fs=${isFullscreen}/dark should use NON_DARWIN_BACKGROUND_DARK`,
        )
      }
    }
  }
})

test('Color constants — darwin transparent + non-darwin neutral theme bg', () => {
  // 验证 2 之后 darwin 只剩透明常量；fullscreen / ready-glass backing 全部移到 CSS .ready-app-bg
  assert.equal(DARWIN_LIQUID_GLASS_TRANSPARENT, '#00000000')
  // 非 macOS 仍按 light/dark 切 bg（vibrancy 不可用，必须有不透明 bg）
  assert.equal(NON_DARWIN_BACKGROUND_LIGHT, '#F7F9FC')
  assert.equal(NON_DARWIN_BACKGROUND_DARK, '#1A1B1E')
})

test('applyMaterial only calls setters for changed fields (idempotency)', () => {
  // Mock BrowserWindow with call counters
  const calls: { setBackgroundColor: string[]; setVibrancy: (string | null)[] } = {
    setBackgroundColor: [],
    setVibrancy: [],
  }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { calls.setBackgroundColor.push(c) },
    setVibrancy: (v: 'under-window' | null) => { calls.setVibrancy.push(v) },
  } as unknown as Parameters<typeof applyMaterial>[0]

  const target1: MaterialOutputs = { backgroundColor: '#00000000', vibrancy: 'under-window' }
  // 首次应用，current=null，两个 setter 都应该被调用
  applyMaterial(fakeWindow, target1, null, 'darwin')
  assert.deepEqual(calls.setBackgroundColor, ['#00000000'])
  assert.deepEqual(calls.setVibrancy, ['under-window'])

  // 第二次应用同样目标，无变化字段 → 两个 setter 都不应被再调用
  applyMaterial(fakeWindow, target1, target1, 'darwin')
  assert.deepEqual(calls.setBackgroundColor, ['#00000000'], 'setBackgroundColor should not be re-called for same value')
  assert.deepEqual(calls.setVibrancy, ['under-window'], 'setVibrancy should not be re-called for same value')

  // 只 bg 变化 → 只 setBackgroundColor 被调用
  const target2: MaterialOutputs = { backgroundColor: '#DEE1E4', vibrancy: 'under-window' }
  applyMaterial(fakeWindow, target2, target1, 'darwin')
  assert.deepEqual(calls.setBackgroundColor, ['#00000000', '#DEE1E4'])
  assert.deepEqual(calls.setVibrancy, ['under-window'], 'vibrancy unchanged should not re-set')

  // 只 vibrancy 变化 → 只 setVibrancy 被调用
  const target3: MaterialOutputs = { backgroundColor: '#DEE1E4', vibrancy: null }
  applyMaterial(fakeWindow, target3, target2, 'darwin')
  assert.deepEqual(calls.setBackgroundColor, ['#00000000', '#DEE1E4'], 'bg unchanged should not re-set')
  assert.deepEqual(calls.setVibrancy, ['under-window', null])
})

test('applyMaterial on non-darwin does not call setVibrancy at all', () => {
  const calls: { setBackgroundColor: string[]; setVibrancy: (string | null)[] } = {
    setBackgroundColor: [],
    setVibrancy: [],
  }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { calls.setBackgroundColor.push(c) },
    setVibrancy: (v: 'under-window' | null) => { calls.setVibrancy.push(v) },
  } as unknown as Parameters<typeof applyMaterial>[0]

  applyMaterial(fakeWindow, { backgroundColor: '#1A1B1E', vibrancy: null }, null, 'win32')
  assert.deepEqual(calls.setBackgroundColor, ['#1A1B1E'])
  assert.deepEqual(calls.setVibrancy, [], 'setVibrancy should not be invoked on non-darwin')

  applyMaterial(fakeWindow, { backgroundColor: '#F7F9FC', vibrancy: null }, null, 'linux')
  assert.deepEqual(calls.setBackgroundColor, ['#1A1B1E', '#F7F9FC'])
  assert.deepEqual(calls.setVibrancy, [], 'setVibrancy should not be invoked on linux either')
})

test('controller exposes isFullscreen() flag, not mainWindow.isFullScreen()', () => {
  // 计划要求：内部维护 materialFullscreenState flag，不读 mainWindow.isFullScreen()，
  // 因为 will-enter-full-screen 触发时 isFullScreen() 仍 false，会查错状态表。
  // Stage 1 PR 阶段没有 lifecycle handler 翻转 flag，所以一直是初始值 false。
  const setters: { bg: string[]; vibrancy: (string | null)[] } = { bg: [], vibrancy: [] }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => undefined,
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
  })

  assert.equal(controller.isFullscreen(), false, 'initial materialFullscreenState should be false')
  controller.applyInitial()
  assert.deepEqual(setters.bg, ['#00000000'], 'initial sync should set transparent bg for darwin liquid-glass windowed')
  assert.deepEqual(setters.vibrancy, ['under-window'], 'initial sync should set under-window vibrancy')
})

test('controller preserves constructor-applied darwin material without duplicate setters', () => {
  const setters: { bg: string[]; vibrancy: (string | null)[]; buttonPos: { x: number; y: number }[] } = {
    bg: [],
    vibrancy: [],
    buttonPos: [],
  }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: (position: { x: number; y: number }) => { setters.buttonPos.push(position) },
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    initialMaterial: { backgroundColor: '#00000000', vibrancy: 'under-window' },
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
  })

  controller.applyInitial()
  controller.sync()
  assert.deepEqual(setters.bg, [], 'constructor-applied transparent bg should not be set again')
  assert.deepEqual(setters.vibrancy, [], 'constructor-applied vibrancy should not be set again')
  assert.deepEqual(setters.buttonPos, [{ x: 20, y: 20 }], 'traffic lights are centered in the 52px top band')
})

test('验证 2 — controller.sync() on darwin is no-op regardless of theme/skin (no setter calls after applyInitial)', () => {
  let currentSkin: 'liquid-glass' | 'ready-glass' = 'liquid-glass'
  let currentTheme: 'light' | 'dark' = 'light'

  const setters: { bg: string[]; vibrancy: (string | null)[] } = { bg: [], vibrancy: [] }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => undefined,
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: currentSkin, resolvedTheme: currentTheme }),
  })
  controller.applyInitial()
  // 初始：darwin 上无论 skin/theme，都是稳定的 '#00000000' + 'under-window'
  assert.deepEqual(setters.bg, ['#00000000'])
  assert.deepEqual(setters.vibrancy, ['under-window'])

  // 切 skin / theme 各种组合都是 no-op——computeMaterial 永远返回相同值，applyMaterial diff 不调 setter
  for (const skin of ['ready-glass', 'liquid-glass', 'ready-glass'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      currentSkin = skin
      currentTheme = theme
      controller.sync()
    }
  }
  assert.deepEqual(setters.bg, ['#00000000'], 'theme/skin sync must not trigger setBackgroundColor on darwin')
  assert.deepEqual(setters.vibrancy, ['under-window'], 'theme/skin sync must not trigger setVibrancy on darwin')
})

test('non-darwin sync responds to theme changes (bg flips between light/dark)', () => {
  let currentTheme: 'light' | 'dark' = 'light'
  const setters: { bg: string[]; vibrancy: (string | null)[] } = { bg: [], vibrancy: [] }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => undefined,
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'win32',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: currentTheme }),
  })
  controller.applyInitial()
  assert.equal(setters.bg.at(-1), NON_DARWIN_BACKGROUND_LIGHT)

  currentTheme = 'dark'
  controller.sync()
  assert.equal(setters.bg.at(-1), NON_DARWIN_BACKGROUND_DARK, 'win32: theme change should switch bg')
  // setVibrancy 在非 darwin 上从未被调用
  assert.deepEqual(setters.vibrancy, [], 'non-darwin must never call setVibrancy')
})

test('controller does no-op when window is destroyed', () => {
  let isDestroyed = false
  const setters: { bg: string[]; vibrancy: (string | null)[] } = { bg: [], vibrancy: [] }
  const fakeWindow = {
    isDestroyed: () => isDestroyed,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => undefined,
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
  })
  controller.applyInitial()
  const initialBgCalls = setters.bg.length

  isDestroyed = true
  controller.sync()
  assert.equal(setters.bg.length, initialBgCalls, 'sync on destroyed window should be no-op')
})

test('platform input is explicit, not read from process.platform', () => {
  assert.deepEqual(
    computeMaterial({
      platform: 'darwin',
      skin: 'ready-glass',
      resolvedTheme: 'dark',
      isFullscreen: true,
    }),
    { backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT, vibrancy: 'under-window' },
  )
  assert.deepEqual(
    computeMaterial({
      platform: 'win32',
      skin: 'ready-glass',
      resolvedTheme: 'dark',
      isFullscreen: true,
    }),
    { backgroundColor: NON_DARWIN_BACKGROUND_DARK, vibrancy: null },
  )
})

// ----- Stage 2: fullscreen lifecycle behavior -----

// 测试 helper：构造一个模拟 BrowserWindow + 可触发的 lifecycle 事件
function createFakeWindowWithEvents() {
  type Listener = () => void
  const listeners = new Map<string, Listener[]>()
  const wcListeners = new Map<string, Listener[]>()
  const setters: { bg: string[]; vibrancy: (string | null)[]; buttonPos: number } = {
    bg: [],
    vibrancy: [],
    buttonPos: 0,
  }
  // 验证 3：controller 在 webContents 上挂 enter/leave-html-full-screen handler 作为 OOPIF 兜底；
  // 模拟 webContents.on 接 wcListeners，让测试能直接 emit 这两个事件。
  // window.isFullScreen() 由测试通过 setIsFullScreen 控制返回值。
  let isFullScreenValue = false
  const fakeWindow = {
    isDestroyed: () => false,
    isFullScreen: () => isFullScreenValue,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => { setters.buttonPos += 1 },
    webContents: {
      on: (event: string, cb: Listener) => {
        const arr = wcListeners.get(event) ?? []
        arr.push(cb)
        wcListeners.set(event, arr)
      },
    },
    on: (event: string, cb: Listener) => {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
    },
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  function emit(event: string) {
    for (const cb of listeners.get(event) ?? []) cb()
  }

  function emitWebContents(event: string) {
    for (const cb of wcListeners.get(event) ?? []) cb()
  }

  function setIsFullScreen(value: boolean) {
    isFullScreenValue = value
  }

  return { fakeWindow, setters, listeners, wcListeners, emit, emitWebContents, setIsFullScreen }
}

test('Stage 2 — attachLifecycle attaches 4 fullscreen handlers on darwin', () => {
  const { fakeWindow, listeners } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
  })
  controller.attachLifecycle()

  assert.equal(listeners.get('will-enter-full-screen')?.length, 1, 'will-enter-full-screen should be attached')
  assert.equal(listeners.get('enter-full-screen')?.length, 1, 'enter-full-screen should be attached')
  assert.equal(listeners.get('will-leave-full-screen')?.length, 1, 'will-leave-full-screen should be attached')
  assert.equal(listeners.get('leave-full-screen')?.length, 1, 'leave-full-screen should be attached')
})

test('Stage 2 — attachLifecycle is no-op on non-darwin (events do not exist there)', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { fakeWindow, listeners } = createFakeWindowWithEvents()
    const controller = createWindowMaterialController({
      window: fakeWindow,
      platform,
      getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
    })
    controller.attachLifecycle()
    assert.equal(listeners.size, 0, `attachLifecycle should not register listeners on ${platform}`)
  }
})

test('验证 2 — will-enter-full-screen: no setter calls, only flag + IPC', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  let fullscreenNotifications: boolean[] = []
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'dark' }),
    notifyFullscreenChanged: (isFullscreen) => fullscreenNotifications.push(isFullscreen),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  // applyInitial 已经 set bg='#00000000' + vibrancy='under-window'，记下基线
  const bgCallsAfterInit = setters.bg.length
  const vibrancyCallsAfterInit = setters.vibrancy.length

  emit('will-enter-full-screen')
  // 关键：darwin 上 will-enter 不调任何 setter。bg/vibrancy 永远停在 applyInitial 的稳定值。
  // backing 完全由 DOM 层 .ready-app-bg 承担（renderer 收到 IPC 后写 data-native-fullscreen，
  // 让 CSS 切 .ready-app-bg 的 opacity）。
  assert.equal(setters.bg.length, bgCallsAfterInit, 'will-enter must NOT call setBackgroundColor (validation 2)')
  assert.equal(setters.vibrancy.length, vibrancyCallsAfterInit, 'will-enter must NOT call setVibrancy')

  assert.equal(controller.isFullscreen(), true, 'materialFullscreenState should flip true')
  assert.deepEqual(fullscreenNotifications, [true], 'notifyFullscreenChanged(true) should fire')
})

test('验证 2 — will-leave-full-screen is no-op (does not flip flag yet)', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  let fullscreenNotifications: boolean[] = []
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
    notifyFullscreenChanged: (isFullscreen) => fullscreenNotifications.push(isFullscreen),
  })
  controller.applyInitial()
  controller.attachLifecycle()
  emit('will-enter-full-screen')

  const bgBefore = setters.bg.length
  const vibrancyBefore = setters.vibrancy.length
  fullscreenNotifications = []

  emit('will-leave-full-screen')

  assert.equal(setters.bg.length, bgBefore, 'will-leave should not touch bg')
  assert.equal(setters.vibrancy.length, vibrancyBefore, 'will-leave should not touch vibrancy')
  assert.equal(controller.isFullscreen(), true, 'will-leave should not flip materialFullscreenState yet')
  assert.deepEqual(fullscreenNotifications, [], 'will-leave should not push IPC yet (renderer keeps backing during animation)')
})

test('验证 2 — leave-full-screen: flag + IPC only, no setter calls', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  let fullscreenNotifications: boolean[] = []
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
    notifyFullscreenChanged: (isFullscreen) => fullscreenNotifications.push(isFullscreen),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  fullscreenNotifications = []
  const bgBeforeLeave = setters.bg.length
  const vibrancyBeforeLeave = setters.vibrancy.length

  emit('leave-full-screen')

  // 验证 2 核心合同：leave 不调 setBackgroundColor，不调 setVibrancy。
  // 整个 fullscreen lifecycle 里 BrowserWindow 的 CALayer 永远停留在 applyInitial 的透明态。
  assert.equal(setters.bg.length, bgBeforeLeave, 'leave must NOT call setBackgroundColor (CALayer stays frozen transparent)')
  assert.equal(setters.vibrancy.length, vibrancyBeforeLeave, 'leave must NOT call setVibrancy')
  assert.equal(controller.isFullscreen(), false, 'materialFullscreenState should flip false synchronously')
  assert.deepEqual(fullscreenNotifications, [false])
})

test('验证 2 — leave-full-screen lifecycle handler bails when window destroyed', () => {
  let isDestroyed = false
  type Listener = () => void
  const listeners = new Map<string, Listener[]>()
  const setters: { bg: string[]; vibrancy: (string | null)[] } = { bg: [], vibrancy: [] }
  let fullscreenNotifications: boolean[] = []
  const fakeWindow = {
    isDestroyed: () => isDestroyed,
    isFullScreen: () => false,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => undefined,
    webContents: { on: () => undefined },
    on: (event: string, cb: Listener) => {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
    },
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
    notifyFullscreenChanged: (isFullscreen) => fullscreenNotifications.push(isFullscreen),
  })
  controller.applyInitial()
  controller.attachLifecycle()
  for (const cb of listeners.get('will-enter-full-screen') ?? []) cb()
  fullscreenNotifications = []

  isDestroyed = true
  for (const cb of listeners.get('leave-full-screen') ?? []) cb()
  // 因为 destroyed，handler early return，flag 也不翻、IPC 也不发
  assert.equal(controller.isFullscreen(), true, 'destroyed window: leave handler bails before flipping flag')
  assert.deepEqual(fullscreenNotifications, [], 'destroyed window: no IPC sent')
})

test('验证 2 — full entry+exit cycle on darwin: zero setter calls after applyInitial', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'dark' }),
  })
  controller.applyInitial()
  const bgAfterInit = [...setters.bg]
  const vibrancyAfterInit = [...setters.vibrancy]
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  emit('enter-full-screen')
  emit('will-leave-full-screen')
  emit('leave-full-screen')

  // 整个 fullscreen 循环里没有任何额外的 setBackgroundColor / setVibrancy 调用
  assert.deepEqual(setters.bg, bgAfterInit, 'no bg setter calls after applyInitial across full fullscreen cycle')
  assert.deepEqual(setters.vibrancy, vibrancyAfterInit, 'no vibrancy setter calls after applyInitial')
  // applyInitial 设的初值是稳定值
  assert.deepEqual(bgAfterInit, ['#00000000'])
  assert.deepEqual(vibrancyAfterInit, ['under-window'])
})

test('验证 3 — webContents.leave-html-full-screen fallback IPC pushes window.isFullScreen() reality', () => {
  // OOPIF iframe（B 站 iframe 视频）退出 fullscreen 时 BrowserWindow.leave-full-screen 可能不 fire，
  // webContents.leave-html-full-screen 兜底。它必须用 window.isFullScreen() 真实查询值推 IPC，
  // 而不是硬编码——这样能正确处理"用户先 CMD+CTRL+F + 然后 iframe 全屏 + 退 iframe 但仍 native fullscreen"
  // 的嵌套边界 case：退出 html-fullscreen 时 isFullScreen() 仍 true → IPC 推 true → renderer 保留 attr。
  const { fakeWindow, emitWebContents, setIsFullScreen } = createFakeWindowWithEvents()
  let fullscreenNotifications: boolean[] = []
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'dark' }),
    notifyFullscreenChanged: (isFullscreen) => fullscreenNotifications.push(isFullscreen),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  // 场景 A：iframe 触发的 fullscreen，BrowserWindow 真的进了 native fullscreen，退出时 isFullScreen()=false
  setIsFullScreen(true)
  fullscreenNotifications = []
  emitWebContents('enter-html-full-screen')
  assert.deepEqual(fullscreenNotifications, [true], 'enter-html should push true when window.isFullScreen() is true')
  assert.equal(controller.isFullscreen(), true)

  setIsFullScreen(false) // 模拟 BrowserWindow 已退出 native fullscreen 但 leave-full-screen 没 fire
  fullscreenNotifications = []
  emitWebContents('leave-html-full-screen')
  assert.deepEqual(fullscreenNotifications, [false], 'leave-html must push false when window.isFullScreen() is false (the bug case)')
  assert.equal(controller.isFullscreen(), false, 'materialFullscreenState must sync to authoritative isFullScreen()')

  // 场景 B：CMD+CTRL+F 嵌套 iframe 全屏，退 iframe 时 window 仍 native fullscreen
  setIsFullScreen(true)
  fullscreenNotifications = []
  emitWebContents('enter-html-full-screen') // iframe 进 html-fullscreen，window 已在 native fullscreen
  assert.deepEqual(fullscreenNotifications, [true])

  // 退 iframe 但 native 还在
  // isFullScreen 仍 true（用户仍在 CMD+CTRL+F native fullscreen）
  fullscreenNotifications = []
  emitWebContents('leave-html-full-screen')
  assert.deepEqual(fullscreenNotifications, [true], 'nested case: leave-html should push true when native fullscreen still active')
  assert.equal(controller.isFullscreen(), true, 'native fullscreen flag preserved across iframe-only exit')
})

test('验证 2 — theme/skin sync() on darwin is a no-op (target equals applyInitial values)', () => {
  let currentTheme: 'light' | 'dark' = 'dark'
  let currentSkin: 'liquid-glass' | 'ready-glass' = 'liquid-glass'
  const { fakeWindow, setters } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: currentSkin, resolvedTheme: currentTheme }),
  })
  controller.applyInitial()
  const bgAfterInit = setters.bg.length
  const vibrancyAfterInit = setters.vibrancy.length

  // 各种 theme/skin 切换都不能让 darwin 上的 controller 调 setter——computeMaterial 永远返回同一个值
  currentTheme = 'light'
  controller.sync()
  currentSkin = 'ready-glass'
  controller.sync()
  currentTheme = 'dark'
  controller.sync()
  currentSkin = 'liquid-glass'
  controller.sync()

  assert.equal(setters.bg.length, bgAfterInit, 'theme/skin changes must not trigger setBackgroundColor on darwin')
  assert.equal(setters.vibrancy.length, vibrancyAfterInit, 'theme/skin changes must not trigger setVibrancy on darwin')
})

test('MaterialInputs type carries platform field (testing-friendly explicit input)', () => {
  const inputs: MaterialInputs[] = [
    { platform: 'darwin', skin: 'liquid-glass', resolvedTheme: 'light', isFullscreen: false },
    { platform: 'win32', skin: 'liquid-glass', resolvedTheme: 'light', isFullscreen: false },
    { platform: 'linux', skin: 'liquid-glass', resolvedTheme: 'light', isFullscreen: false },
  ]
  assert.deepEqual(inputs.map((input) => input.platform), ['darwin', 'win32', 'linux'])
})

// Type-level smoke: ensure MaterialInputs type can be constructed from caller side.
// (TypeScript compile is the real check; this just keeps the type imports anchored.)
test('MaterialInputs can be constructed at the call site', () => {
  const inputs: MaterialInputs = {
    platform: 'darwin',
    skin: 'liquid-glass',
    resolvedTheme: 'dark',
    isFullscreen: false,
  }
  assert.equal(inputs.platform, 'darwin')
})
