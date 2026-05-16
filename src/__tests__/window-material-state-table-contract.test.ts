// Stage 1 contract: window-material module 状态表 + computeMaterial 行为。
//
// 这是窗口材料逻辑的核心契约。任何想改材料策略的 PR 都必须先改这份测试，
// 改测试时必须能解释清楚为什么这是 spec §1-4 允许的变化。
//
// spec: docs/superpowers/specs/2026-05-16-liquid-glass-ui-layering-and-motion-contract.md

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  applyMaterial,
  computeMaterial,
  DARWIN_FULLSCREEN_BACKING_DARK,
  DARWIN_FULLSCREEN_BACKING_LIGHT,
  DARWIN_LIQUID_GLASS_TRANSPARENT,
  NON_DARWIN_BACKGROUND_DARK,
  NON_DARWIN_BACKGROUND_LIGHT,
  READY_GLASS_BACKING_DARK,
  READY_GLASS_BACKING_LIGHT,
  createWindowMaterialController,
  type MaterialInputs,
  type MaterialOutputs,
} from '../main/modules/window-material/main-window-material'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('module exports the public surface required by main/index.ts', () => {
  const source = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // computeMaterial + applyMaterial 是状态表的纯函数 + 应用器
  assert.match(source, /export function computeMaterial/)
  assert.match(source, /export function applyMaterial/)
  // controller 工厂是 main/index.ts 的入口
  assert.match(source, /export function createWindowMaterialController/)
  // 类型导出
  assert.match(source, /export type ThemeSkin/)
})

test('Darwin state table — 4 rows match spec §3.3 colors', () => {
  // 行 1: liquid-glass + windowed → 透明 + under-window vibrancy
  assert.deepEqual(
    computeMaterial({ platform: 'darwin', skin: 'liquid-glass', resolvedTheme: 'light', isFullscreen: false }),
    { backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT, vibrancy: 'under-window' },
  )
  assert.deepEqual(
    computeMaterial({ platform: 'darwin', skin: 'liquid-glass', resolvedTheme: 'dark', isFullscreen: false }),
    { backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT, vibrancy: 'under-window' },
  )

  // 行 2: liquid-glass + fullscreen → 中性 backing + vibrancy 仍 'under-window'。
  // 不透明 bg 在合成层级上覆盖 vibrancy backdrop，桌面壁纸不可见（修 Bug 2）；
  // vibrancy 从未被禁用，退出时 bg 变回透明，桌面立刻可见——避免 vibrancy 重建 race。
  assert.deepEqual(
    computeMaterial({ platform: 'darwin', skin: 'liquid-glass', resolvedTheme: 'light', isFullscreen: true }),
    { backgroundColor: DARWIN_FULLSCREEN_BACKING_LIGHT, vibrancy: 'under-window' },
  )
  assert.deepEqual(
    computeMaterial({ platform: 'darwin', skin: 'liquid-glass', resolvedTheme: 'dark', isFullscreen: true }),
    { backgroundColor: DARWIN_FULLSCREEN_BACKING_DARK, vibrancy: 'under-window' },
  )

  // 行 3-4: ready-glass + windowed/fullscreen → Ready 稳定底 + vibrancy 仍 'under-window'。
  // 不透明 bg 在合成层级覆盖 vibrancy backdrop → 视觉等同于"关闭 vibrancy"，但避免
  // ready-glass ↔ liquid-glass 切换时的 vibrancy 重建 race（用户报的"实色黑"bug）。
  // isFullscreen 不影响 ready-glass 的输出（bg 和 vibrancy 都不变）。
  for (const isFullscreen of [false, true]) {
    assert.deepEqual(
      computeMaterial({ platform: 'darwin', skin: 'ready-glass', resolvedTheme: 'light', isFullscreen }),
      { backgroundColor: READY_GLASS_BACKING_LIGHT, vibrancy: 'under-window' },
      `ready-glass + isFullscreen=${isFullscreen} light should use READY_GLASS_BACKING_LIGHT`,
    )
    assert.deepEqual(
      computeMaterial({ platform: 'darwin', skin: 'ready-glass', resolvedTheme: 'dark', isFullscreen }),
      { backgroundColor: READY_GLASS_BACKING_DARK, vibrancy: 'under-window' },
      `ready-glass + isFullscreen=${isFullscreen} dark should use READY_GLASS_BACKING_DARK`,
    )
  }
})

test('Darwin: vibrancy is "under-window" for ALL skin × fullscreen combinations (no rebuild race possible)', () => {
  // 这条是 Stage 2.3 + 2.4 的核心架构保证：darwin 上 vibrancy 字段永远 'under-window'，
  // applyMaterial 的 diff 永远不会变化 vibrancy 字段，根本消除 macOS vibrancy 重建 race。
  for (const skin of ['liquid-glass', 'ready-glass'] as const) {
    for (const isFullscreen of [false, true]) {
      for (const resolvedTheme of ['light', 'dark'] as const) {
        const output = computeMaterial({ platform: 'darwin', skin, resolvedTheme, isFullscreen })
        assert.equal(
          output.vibrancy,
          'under-window',
          `darwin / ${skin} / fs=${isFullscreen} / ${resolvedTheme} must use vibrancy='under-window' (architecture rule)`,
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

test('Color constants match spec §3.3 — neutral, not ritual endpoints', () => {
  // spec §3.3 显式：#DEE1E4 / #282D33 中性 fullscreen backing；不允许 #F6F1E7 / #192131
  assert.equal(DARWIN_FULLSCREEN_BACKING_LIGHT, '#DEE1E4')
  assert.equal(DARWIN_FULLSCREEN_BACKING_DARK, '#282D33')
  // Ready-glass 稳定底必须是 #FFFFFF / #1A1B1E 中性色（与 --bg-primary 同源）
  assert.equal(READY_GLASS_BACKING_LIGHT, '#FFFFFF')
  assert.equal(READY_GLASS_BACKING_DARK, '#1A1B1E')
  // 非 macOS 沿用 #F7F9FC / #1A1B1E
  assert.equal(NON_DARWIN_BACKGROUND_LIGHT, '#F7F9FC')
  assert.equal(NON_DARWIN_BACKGROUND_DARK, '#1A1B1E')
  // liquid-glass 窗口态透明（让 vibrancy 桌面壁纸做底）
  assert.equal(DARWIN_LIQUID_GLASS_TRANSPARENT, '#00000000')
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

test('controller sync respects getTheme() callback for live theme/skin reads', () => {
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
  // Initial: liquid-glass + light + windowed → '#00000000' + 'under-window'
  assert.equal(setters.bg.at(-1), '#00000000')
  assert.equal(setters.vibrancy.at(-1), 'under-window')

  // 切到 ready-glass: bg 变 '#FFFFFF'。vibrancy **不变**（始终 'under-window'，由不透明 bg 覆盖）。
  const vibrancyCallsBeforeReadyGlass = setters.vibrancy.length
  currentSkin = 'ready-glass'
  controller.sync()
  assert.equal(setters.bg.at(-1), '#FFFFFF', 'ready-glass + light should set #FFFFFF')
  assert.equal(
    setters.vibrancy.length,
    vibrancyCallsBeforeReadyGlass,
    'ready-glass: vibrancy stays under-window (no setter call) — avoids null↔under-window rebuild race',
  )

  // 切到 dark: bg 变 '#1A1B1E'。vibrancy 仍不变。
  const vibrancyCallsBeforeDark = setters.vibrancy.length
  currentTheme = 'dark'
  controller.sync()
  assert.equal(setters.bg.at(-1), '#1A1B1E', 'ready-glass + dark should set #1A1B1E')
  assert.equal(setters.vibrancy.length, vibrancyCallsBeforeDark, 'vibrancy still unchanged')

  // 切回 liquid-glass: bg 变回透明，vibrancy **仍不变**（一直 'under-window'）。
  // 这是修 ready-glass→liquid-glass 实色黑色 bug 的关键：vibrancy 从未被 null 化，
  // 所以 macOS 不存在"vibrancy=null 稳定状态后 setVibrancy('under-window') no-op"的 race。
  const vibrancyCallsBeforeLiquidGlass = setters.vibrancy.length
  currentSkin = 'liquid-glass'
  controller.sync()
  assert.equal(setters.bg.at(-1), '#00000000', 'liquid-glass windowed should set transparent')
  assert.equal(
    setters.vibrancy.length,
    vibrancyCallsBeforeLiquidGlass,
    'liquid-glass: vibrancy stays under-window throughout — no rebuild race possible',
  )
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
  const source = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')
  // computeMaterial 内禁止读 process.platform；platform 必须由调用方传入（测试友好性）。
  // 注释里可以提及 process.platform（解释意图），但不能在代码里真实访问它。
  // 去掉单行注释（// ...）和块注释（/* ... */）后再 grep。
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/\/\/.*$/gm, '')           // line comments
  assert.doesNotMatch(
    codeOnly,
    /process\.platform/,
    'window-material module should not read process.platform in code (only in comments)',
  )
})

// ----- Stage 2: fullscreen lifecycle behavior -----

// 测试 helper：构造一个模拟 BrowserWindow + 可触发的 lifecycle 事件
function createFakeWindowWithEvents() {
  type Listener = () => void
  const listeners = new Map<string, Listener[]>()
  const setters: { bg: string[]; vibrancy: (string | null)[]; buttonPos: number } = {
    bg: [],
    vibrancy: [],
    buttonPos: 0,
  }
  const fakeWindow = {
    isDestroyed: () => false,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => { setters.buttonPos += 1 },
    on: (event: string, cb: Listener) => {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
    },
  } as unknown as Parameters<typeof createWindowMaterialController>[0]['window']

  function emit(event: string) {
    for (const cb of listeners.get(event) ?? []) cb()
  }

  return { fakeWindow, setters, listeners, emit }
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

test('Stage 2 — will-enter-full-screen flips flag and applies opaque fullscreen backing (vibrancy stays under-window)', () => {
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

  // applyInitial 已经 set bg='#00000000' + vibrancy='under-window'
  const bgBeforeEnter = setters.bg.length
  const vibrancyBeforeEnter = setters.vibrancy.length

  emit('will-enter-full-screen')

  // 关键：vibrancy 保持 'under-window'，不切到 null。
  // applyMaterial 的 diff 只看到 bg 变化（透明→backing），所以只调 setBackgroundColor，不调 setVibrancy。
  // 不透明 bg 在合成层级上覆盖 vibrancy backdrop → 桌面壁纸看不见（修 Bug 2）。
  assert.equal(setters.bg.at(-1), '#DEE1E4', 'should set fullscreen backing color (light)')
  assert.equal(setters.bg.length, bgBeforeEnter + 1)
  assert.equal(setters.vibrancy.length, vibrancyBeforeEnter, 'vibrancy should NOT be touched (still under-window)')

  assert.equal(controller.isFullscreen(), true, 'materialFullscreenState should be true after will-enter')
  assert.deepEqual(fullscreenNotifications, [true], 'notifyFullscreenChanged(true) should fire')
})

test('Stage 2 — will-enter-full-screen with dark theme uses dark backing (vibrancy still under-window)', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'dark' }),
  })
  controller.applyInitial()
  // applyInitial 设 bg='#00000000' + vibrancy='under-window'
  const vibrancyBefore = setters.vibrancy.length
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  assert.equal(setters.bg.at(-1), '#282D33', 'should set dark fullscreen backing')
  assert.equal(setters.vibrancy.length, vibrancyBefore, 'vibrancy not touched (stays under-window)')
})

test('Stage 2 — will-leave-full-screen is no-op (do not expose transparent during exit animation)', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
  })
  controller.applyInitial()
  controller.attachLifecycle()
  emit('will-enter-full-screen')

  const bgBeforeWillLeave = setters.bg.length
  const vibrancyBeforeWillLeave = setters.vibrancy.length
  emit('will-leave-full-screen')
  // will-leave 不应触发任何 setter 或 flag 翻转
  assert.equal(setters.bg.length, bgBeforeWillLeave, 'will-leave should not touch bg')
  assert.equal(setters.vibrancy.length, vibrancyBeforeWillLeave, 'will-leave should not touch vibrancy')
  assert.equal(controller.isFullscreen(), true, 'will-leave should not flip materialFullscreenState yet')
})

test('验证 1 — leave-full-screen liquid-glass: synchronous bg transparent, vibrancy untouched', () => {
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
  const bgIndexBeforeLeave = setters.bg.length
  const vibrancyIndexBeforeLeave = setters.vibrancy.length

  emit('leave-full-screen')

  // 验证 1：撤回 rebuild 后，leave 同步走 flag + sync + notify。
  // - bg 立刻从 backing 切到透明（diff 检测到变化）
  // - vibrancy 在 darwin 上始终 'under-window'，diff 无变化，setVibrancy 不调
  // - materialFullscreenState 同步翻 false
  // - notifyFullscreenChanged(false) 同步发
  assert.equal(setters.bg.at(-1), '#00000000', 'leave should sync bg back to transparent immediately')
  assert.equal(setters.bg.length, bgIndexBeforeLeave + 1, 'exactly one bg setter call')
  assert.equal(setters.vibrancy.length, vibrancyIndexBeforeLeave, 'vibrancy must never be touched in leave handler (validation 1)')
  assert.equal(controller.isFullscreen(), false, 'materialFullscreenState should flip false synchronously')
  assert.deepEqual(fullscreenNotifications, [false])
})

test('验证 1 — leave-full-screen liquid-glass: lastAppliedMaterial cache updated by standard sync()', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'light' }),
  })
  controller.applyInitial()
  controller.attachLifecycle()
  emit('will-enter-full-screen')
  emit('leave-full-screen')

  // sync() 已经在 leave 里同步跑过；缓存应该被更新到 windowed liquid-glass = {bg='#00000000', vibrancy='under-window'}
  const bgCallsBefore = setters.bg.length
  const vibrancyCallsBefore = setters.vibrancy.length
  controller.sync()
  assert.equal(setters.bg.length, bgCallsBefore, 'cache should prevent redundant setBackgroundColor on next sync')
  assert.equal(setters.vibrancy.length, vibrancyCallsBefore, 'cache should prevent redundant setVibrancy on next sync')
})

test('Stage 2 — leave-full-screen ready-glass: bg stays at ready-glass color (no transition)', () => {
  let currentSkin: 'liquid-glass' | 'ready-glass' = 'ready-glass'
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  let fullscreenNotifications: boolean[] = []
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: currentSkin, resolvedTheme: 'light' }),
    notifyFullscreenChanged: (isFullscreen) => fullscreenNotifications.push(isFullscreen),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  // ready-glass: bg='#FFFFFF', vibrancy='under-window'。fullscreen target 一样（状态表行 3=行 4）。
  // 即使 ready-glass 也保持 vibrancy='under-window'（被不透明 bg 覆盖；这是 Stage 2.4 修复 ready-glass↔liquid-glass race 的关键）。
  assert.equal(setters.bg.at(-1), '#FFFFFF')
  assert.equal(setters.vibrancy.at(-1), 'under-window')

  fullscreenNotifications = []
  const bgBefore = setters.bg.length
  const vibrancyBefore = setters.vibrancy.length

  emit('leave-full-screen')
  // ready-glass windowed 也是 '#FFFFFF' + 'under-window'。diff 为空，setter 不调用。
  assert.equal(setters.bg.length, bgBefore, 'ready-glass leave should not change bg (same in fullscreen and windowed)')
  assert.equal(setters.vibrancy.length, vibrancyBefore, 'ready-glass leave should not touch vibrancy')
  assert.equal(controller.isFullscreen(), false)
  assert.deepEqual(fullscreenNotifications, [false])
})

test('Stage 2 — leave-full-screen lifecycle handler bails when window destroyed', () => {
  let isDestroyed = false
  type Listener = () => void
  const listeners = new Map<string, Listener[]>()
  const setters: { bg: string[]; vibrancy: (string | null)[] } = { bg: [], vibrancy: [] }
  const fakeWindow = {
    isDestroyed: () => isDestroyed,
    setBackgroundColor: (c: string) => { setters.bg.push(c) },
    setVibrancy: (v: 'under-window' | null) => { setters.vibrancy.push(v) },
    setWindowButtonPosition: () => undefined,
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
  })
  controller.applyInitial()
  controller.attachLifecycle()
  for (const cb of listeners.get('will-enter-full-screen') ?? []) cb()
  const callsBeforeDestroy = setters.bg.length + setters.vibrancy.length

  isDestroyed = true
  for (const cb of listeners.get('leave-full-screen') ?? []) cb()
  // 因为 destroyed，handler 早 return；sync() 内也 early return
  assert.equal(setters.bg.length + setters.vibrancy.length, callsBeforeDestroy, 'destroyed window should skip all setter calls in leave-full-screen')
})

test('验证 1 — fullscreen entry → exit cycle: bg toggles, vibrancy never manipulated', () => {
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'dark' }),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  emit('enter-full-screen')
  emit('will-leave-full-screen')
  emit('leave-full-screen')

  // bg 序列：initial '#00000000' → enter '#282D33' → leave '#00000000'
  assert.deepEqual(setters.bg, ['#00000000', '#282D33', '#00000000'])
  // vibrancy 序列：applyInitial 唯一一次设 'under-window'，之后再也不该有任何 setVibrancy 调用——
  // 让 macOS 自治 NSVisualEffectView stash/restore，避免 Stage 2.6 那种 rebuild 反噬。
  assert.deepEqual(setters.vibrancy, ['under-window'])
})

test('验证 1 — edge case: theme toggle during fullscreen + exit, vibrancy still untouched', () => {
  let currentTheme: 'light' | 'dark' = 'dark'
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: currentTheme }),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  assert.equal(setters.bg.at(-1), '#282D33')

  currentTheme = 'light'
  controller.sync()
  assert.equal(setters.bg.at(-1), '#DEE1E4', 'theme toggle in fullscreen should update bg to light backing')

  emit('leave-full-screen')
  // light + windowed → bg='#00000000'
  assert.equal(setters.bg.at(-1), '#00000000', 'leave-full-screen should restore transparent bg')
  // vibrancy 全程只有 applyInitial 那一次设
  assert.deepEqual(
    setters.vibrancy,
    ['under-window'],
    'no vibrancy manipulation after applyInitial (validation 1)',
  )
  assert.equal(controller.isFullscreen(), false)
})

test('验证 1 — HTML5 fullscreen exit (iframe video): bg restored to transparent, vibrancy untouched', () => {
  // 用户报：在文档里 bilibili iframe 视频全屏 → 退出 → 整个 UI 深黑色无法恢复，只能重启。
  // 撤回 rebuild 后，HTML5 与 native 走同一条 leave 路径：flag + sync + notify。
  // 不再需要区分触发源；NSVisualEffectView 由 macOS 自治管理。
  const { fakeWindow, setters, emit } = createFakeWindowWithEvents()
  const controller = createWindowMaterialController({
    window: fakeWindow,
    platform: 'darwin',
    getTheme: () => ({ skin: 'liquid-glass', resolvedTheme: 'dark' }),
  })
  controller.applyInitial()
  controller.attachLifecycle()

  emit('will-enter-full-screen')
  emit('enter-full-screen')
  assert.equal(setters.bg.at(-1), '#282D33')

  emit('will-leave-full-screen')
  emit('leave-full-screen')

  assert.equal(setters.bg.at(-1), '#00000000', 'bg reverts to transparent via sync()')
  assert.deepEqual(setters.vibrancy, ['under-window'], 'vibrancy must remain at applyInitial value, never re-set')
  assert.equal(controller.isFullscreen(), false)
})

test('MaterialInputs type carries platform field (testing-friendly explicit input)', () => {
  const source = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')
  assert.match(source, /platform:\s*SupportedPlatform/)
  assert.match(source, /SupportedPlatform\s*=\s*'darwin'\s*\|\s*'win32'\s*\|\s*'linux'/)
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
