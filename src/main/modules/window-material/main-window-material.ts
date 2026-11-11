// Ready 主窗口材料状态管理。
//
// **架构（验证 2，2026-05-16）**：在 macOS 上 `setBackgroundColor` 永远是 `'#00000000'`，
// `setVibrancy` 永远是 `'under-window'`，**两者在 applyInitial 之后再也不会被 Electron API
// 触碰**。所有"opaque backing"需求（ready-glass、liquid-glass + 全屏防壁纸泄漏）改由
// DOM 层 `.ready-app-bg` 用 `--app-bg-overlay-opacity` 控制透明度承担。
//
// 为什么：macOS NSVisualEffectView 在 CALayer 长期 opaque 覆盖期间会被静默 quiesce，
// CALayer 再变透明时它不会自动恢复，Electron 没有显式 "reactivate vibrancy" API。任何
// "opaque → transparent" 切换都暴露这个 quiesce 窗口（用户报：B 站全屏退出黑、
// ready-glass→liquid-glass 黑）。把 darwin 上 CALayer 冻结在透明态，NSVisualEffectView
// 永远不被遮盖 → 永远不被 quiesce → 状态机彻底退役。
//
// fullscreen 4 个 lifecycle handler 在 darwin 上**只发 IPC 通知 renderer**，不动 bg/vibrancy。
// renderer 通过 `data-native-fullscreen` attr 让 CSS 决定 `.ready-app-bg` 是否可见。
//
// 详见 docs/superpowers/specs/2026-05-16-liquid-glass-ui-layering-and-motion-contract.md

import type { BrowserWindow } from 'electron'

// ----- 色常量 -----
//
// 验证 2 之后 darwin 只用 DARWIN_LIQUID_GLASS_TRANSPARENT 一个值——所有不透明 backing
// 都挪到 DOM 层 `.ready-app-bg`（CSS 自己持有 gradient 颜色，TS 这边不再为 BrowserWindow
// 提供 backing 色常量）。原来的 DARWIN_FULLSCREEN_BACKING_* / READY_GLASS_BACKING_* 已
// 退役——它们是给 setBackgroundColor 用的，但 setBackgroundColor 不再在这些场景下被调。

// macOS BrowserWindow 永远的 bg 值（让 vibrancy 桌面壁纸做底）
export const DARWIN_LIQUID_GLASS_TRANSPARENT = '#00000000'

// 非 macOS 平台 bg（沿用原有实现，本轮不动 Win/Linux 视觉）
export const NON_DARWIN_BACKGROUND_LIGHT = '#F7F9FC'
export const NON_DARWIN_BACKGROUND_DARK = '#1A1B1E'

// ----- 类型 -----

export type ResolvedTheme = 'light' | 'dark'
export type SupportedPlatform = 'darwin' | 'win32' | 'linux'

export interface MaterialInputs {
  /** 显式输入，让 computeMaterial 不偷读 process.platform；测试可以直接覆盖三平台分支 */
  platform: SupportedPlatform
  resolvedTheme: ResolvedTheme
  /** 内部追踪态。不能用 mainWindow.isFullScreen() —— will-enter-full-screen 触发时它仍 false */
  isFullscreen: boolean
}

export interface MaterialOutputs {
  /** hex with alpha; '#00000000' = 透明（让 vibrancy 兜底） */
  backgroundColor: string
  /** macOS 才使用；非 macOS 输出固定 null */
  vibrancy: 'under-window' | null
}

// ----- computeMaterial：纯函数 -----

/**
 * 计算给定输入下的材料目标。
 *
 * darwin: bg 永远透明，vibrancy 永远 'under-window'。“减少透明”与 fullscreen 差异**不**走 BrowserWindow，
 *         走 DOM 层 `.ready-app-bg`（见 src/renderer/styles/index.css）。
 *         这样 CALayer 永远不会 opaque 覆盖 NSVisualEffectView → 永远不会 quiesce →
 *         永远不会出现"切换后 vibrancy 静默死掉 = 黑屏"。
 *
 * win32 / linux: 按 resolvedTheme 输出对应不透明 bg；vibrancy 恒 null（mica 由
 *                applyNonDarwinPlatformExtras 单独管）。
 */
export function computeMaterial(inputs: MaterialInputs): MaterialOutputs {
  if (inputs.platform === 'darwin') {
    return {
      backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT,
      vibrancy: 'under-window',
    }
  }

  return {
    backgroundColor: inputs.resolvedTheme === 'dark' ? NON_DARWIN_BACKGROUND_DARK : NON_DARWIN_BACKGROUND_LIGHT,
    vibrancy: null,
  }
}

// ----- applyMaterial：把目标写到 window，只对变化字段调用 setter -----

/**
 * 把目标材料 outputs 应用到窗口。
 *
 * - 与 current 缓存比较，只对变化字段调用 setter（幂等性，避免 `setVibrancy(同值)` 这种 no-op
 *   导致下游 macOS 内部状态翻车，也避免双触发时重复重建 vibrancy）
 * - 返回实际生效的 outputs；调用者负责把返回值缓存起来传给下次的 current 参数
 * - 仅 macOS 调 setVibrancy；其他平台 vibrancy 字段被无视
 */
export function applyMaterial(
  window: BrowserWindow,
  target: MaterialOutputs,
  current: MaterialOutputs | null,
  platform: SupportedPlatform,
): MaterialOutputs {
  if (window.isDestroyed()) return target

  if (current === null || current.backgroundColor !== target.backgroundColor) {
    window.setBackgroundColor(target.backgroundColor)
  }

  if (platform === 'darwin') {
    if (current === null || current.vibrancy !== target.vibrancy) {
      window.setVibrancy(target.vibrancy)
    }
  }

  return target
}

// ----- applyNonDarwinPlatformExtras：mica 等独立路径 -----

/**
 * Win32 用 setBackgroundMaterial('mica') —— mica 跟 macOS under-window 不是同一套机制，
 * 不会出现 Bug 2 那种桌面采样泄漏。保留以保持当前 Win 视觉。
 */
export function applyNonDarwinPlatformExtras(window: BrowserWindow, platform: SupportedPlatform): void {
  if (window.isDestroyed()) return
  if (platform === 'win32' && 'setBackgroundMaterial' in window) {
    try {
      ;(window as BrowserWindow & { setBackgroundMaterial: (mat: string) => void }).setBackgroundMaterial('mica')
    } catch {
      /* ignore unsupported Windows builds */
    }
  }
}

// ----- WindowMaterialController：fullscreen flag + IPC 推送，**不**动 bg/vibrancy -----

/**
 * 验证 2 架构：
 *   - `applyInitial()` 在 createWindow 后调一次，把 bg/vibrancy 写到稳定值（macOS 上是
 *     '#00000000' + 'under-window'），之后 controller **不再触碰** Electron 的 setBackgroundColor /
 *     setVibrancy。
 *   - `sync()` 只对非 darwin 平台有意义（theme 切换时刷新 bg）。darwin 上 sync() 是
 *     no-op（computeMaterial 永远返回相同的稳定值，applyMaterial diff 不调 setter）。
 *   - fullscreen lifecycle handler 只翻内部 flag + 调 notifyFullscreenChanged。
 *     darwin CALayer 永远透明 → NSVisualEffectView 永远不被 quiesce → 没有"切换后黑屏"。
 *
 * 用法：
 *   const controller = createWindowMaterialController({ window, platform, getTheme })
 *   controller.applyInitial()    // createWindow 后调一次
 *   controller.attachLifecycle() // 挂 fullscreen lifecycle handler
 *   // theme:set / nativeTheme.updated 上游仍调 sync()，
 *   // win32/linux 会刷新 bg，darwin 是 no-op。
 */
export interface WindowMaterialControllerOptions {
  window: BrowserWindow
  platform: SupportedPlatform
  /** 已由 BrowserWindow 构造参数应用的材料；传入后 controller 不重复 set 同值。 */
  initialMaterial?: MaterialOutputs | null
  /** 实时读取，每次 sync 拉一次（非 darwin 上让 theme 切换刷新 bg） */
  getTheme: () => { resolvedTheme: ResolvedTheme }
  /** fullscreen 状态改变后通知 renderer，让 renderer 设置 data-native-fullscreen attr */
  notifyFullscreenChanged?: (isFullscreen: boolean) => void
}

export interface WindowMaterialController {
  /** 当前的 fullscreen 标记（内部追踪，不读 mainWindow.isFullScreen()） */
  isFullscreen: () => boolean
  /** 重算目标 → diff → 只 set 变化字段。darwin 上是 no-op。 */
  sync: () => void
  /** 挂 will-enter / enter / will-leave / leave-full-screen 监听 */
  attachLifecycle: () => void
  /** createWindow 之后调一次：set 初始 bg/vibrancy + 调 platform extras */
  applyInitial: () => void
}

export function createWindowMaterialController(options: WindowMaterialControllerOptions): WindowMaterialController {
  const { window, platform, initialMaterial = null, getTheme, notifyFullscreenChanged } = options

  let materialFullscreenState = false
  let lastAppliedMaterial: MaterialOutputs | null = initialMaterial

  const sync = (): void => {
    if (window.isDestroyed()) return
    const { resolvedTheme } = getTheme()
    const target = computeMaterial({
      platform,
      resolvedTheme,
      isFullscreen: materialFullscreenState,
    })
    lastAppliedMaterial = applyMaterial(window, target, lastAppliedMaterial, platform)
  }

  const applyInitial = (): void => {
    applyNonDarwinPlatformExtras(window, platform)
    if (platform === 'darwin') {
      // Centred in the 52px top band, the first button over the rail's centre line (W2 §2).
      window.setWindowButtonPosition({ x: 20, y: 20 })
    }
    sync()
  }

  const attachLifecycle = (): void => {
    // 仅 macOS 有 fullscreen 生命周期事件（will-enter/leave-full-screen 是 macOS-only）。
    if (platform !== 'darwin') return
    if (window.isDestroyed()) return

    // Electron 34 .d.ts 没覆盖 'will-enter-full-screen' / 'will-leave-full-screen'，
    // 局部 type cast 桥接。
    const macFullscreenEmitter = window as BrowserWindow & {
      on(event: 'will-enter-full-screen' | 'will-leave-full-screen', listener: () => void): BrowserWindow
    }

    // **验证 2 架构**：4 个 BrowserWindow handler 只翻内部 flag + 调 notifyFullscreenChanged 推 IPC。
    // 不调 sync()，因为 darwin 上 computeMaterial 永远返回相同稳定值——调了也是 no-op
    // （applyMaterial diff 看 bg/vibrancy 没变）。renderer 收到 IPC 后写
    // `data-native-fullscreen` attr，让 CSS 决定 `.ready-app-bg` 是否承担 fullscreen backing
    // —— DOM 层处理一切 backing 变化，BrowserWindow 的 CALayer 永远透明。
    macFullscreenEmitter.on('will-enter-full-screen', () => {
      materialFullscreenState = true
      notifyFullscreenChanged?.(true)
    })

    window.on('enter-full-screen', () => {
      // 幂等 IPC 不需要重发；OS 状态已经在 will-enter 同步过，这里只是动画结束信号。
    })

    macFullscreenEmitter.on('will-leave-full-screen', () => {
      // intentionally empty
      // 等动画结束的 leave-full-screen 才翻 flag + 推 IPC（renderer 端 backing 在动画期间保持可见）。
    })

    window.on('leave-full-screen', () => {
      if (window.isDestroyed()) return
      materialFullscreenState = false
      notifyFullscreenChanged?.(false)
    })

    // **验证 3 加固**：BrowserWindow.leave-full-screen 在 OOPIF（cross-origin iframe）路径下不可靠 fire。
    // webContents-level 的 enter/leave-html-full-screen 是 Chromium 内部 fullscreen 状态机的统一出口，
    // 对 OOPIF 路径更可靠。这两个 handler 作为兜底，确保即使 BrowserWindow 事件不触发，
    // renderer 也能收到 fullscreen 状态 IPC。
    //
    // 关键：传给 notifyFullscreenChanged 的是 `window.isFullScreen()` 真实查询值，而不是硬编码 true/false。
    // 这样能正确处理"CMD+CTRL+F 嵌套 iframe 全屏"边界 case：用户已在 native fullscreen 内点 iframe 视频全屏，
    // 然后退 iframe 全屏，window.isFullScreen() 仍 true → 不能错误地把 native fullscreen flag 也清掉。
    window.webContents.on('enter-html-full-screen', () => {
      if (window.isDestroyed()) return
      const stillFullscreen = window.isFullScreen()
      materialFullscreenState = stillFullscreen
      notifyFullscreenChanged?.(stillFullscreen)
    })

    window.webContents.on('leave-html-full-screen', () => {
      if (window.isDestroyed()) return
      const stillFullscreen = window.isFullScreen()
      materialFullscreenState = stillFullscreen
      notifyFullscreenChanged?.(stillFullscreen)
    })
  }

  return {
    isFullscreen: () => materialFullscreenState,
    sync,
    attachLifecycle,
    applyInitial,
  }
}
