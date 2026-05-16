// Ready 主窗口材料状态管理。
//
// 用一张 4 行状态表把 (skin × isFullscreen) → (backgroundColor, vibrancy) 决定下来，
// 所有触发点（createWindow, theme:set, theme:setSkin, nativeTheme.updated, 4 个 fullscreen
// lifecycle 事件）统一调 syncMaterial() 走表，避免上一轮 "broadcastThemeChanged 偷偷
// 改材料 + isFullScreen() 时机错位" 的回归。
//
// 详见 docs/superpowers/specs/2026-05-16-liquid-glass-ui-layering-and-motion-contract.md
// 与 ~/.claude/plans/agent-teams-eventual-parrot.md。

import type { BrowserWindow } from 'electron'

// ----- 色常量 -----

// macOS liquid-glass 透明（让 vibrancy 桌面壁纸做底）
export const DARWIN_LIQUID_GLASS_TRANSPARENT = '#00000000'

// macOS fullscreen backing（spec §3.3 中性色，仅 fullscreen 生命周期内使用）
export const DARWIN_FULLSCREEN_BACKING_LIGHT = '#DEE1E4'
export const DARWIN_FULLSCREEN_BACKING_DARK = '#282D33'

// Ready-glass 稳定底（与 --bg-primary 同源中性色；
// 禁止使用 #F6F1E7 / #192131，那是 ritual 端点色，spec §3.3 红线）
export const READY_GLASS_BACKING_LIGHT = '#FFFFFF'
export const READY_GLASS_BACKING_DARK = '#1A1B1E'

// 非 macOS 平台首帧/稳定态 bg（沿用原有实现，本轮不顺手改 Win/Linux 视觉）
export const NON_DARWIN_BACKGROUND_LIGHT = '#F7F9FC'
export const NON_DARWIN_BACKGROUND_DARK = '#1A1B1E'

// ----- 类型 -----

export type ThemeSkin = 'liquid-glass' | 'ready-glass'
export type ResolvedTheme = 'light' | 'dark'
export type SupportedPlatform = 'darwin' | 'win32' | 'linux'

export interface MaterialInputs {
  /** 显式输入，让 computeMaterial 不偷读 process.platform；测试可以直接覆盖三平台分支 */
  platform: SupportedPlatform
  skin: ThemeSkin
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

// ----- computeMaterial：纯函数，状态表 -----

// ----- 关于 darwin 上 vibrancy 永远 'under-window' 的决定 -----
//
// 起初的实现按 spec §1.2 字面规则把 ready-glass 的 vibrancy 设为 null（"ready-glass
// 不启用 macOS under-window"），把 liquid-glass + fullscreen 的 vibrancy 也设为 null
// （"全屏期间桌面采样会泄漏壁纸"）。但这两条路径都触发了同一类 macOS bug：
//
//   长时间停留在 vibrancy=null 后，再调 setVibrancy('under-window') 会被合并成 no-op，
//   vibrancy 没真活起来；用户报的两次 race 都是这个原因：
//     1. Bug 2 残余：夜间 → 全屏 → 切日间 → 退全屏 → 暖色（已在 Stage 2.3 修复）
//     2. ready-glass race：ready-glass + 夜间 → 切回 liquid-glass → 实色黑色（本次修复）
//
// 修复策略：darwin 上 vibrancy 始终 'under-window'。用 backgroundColor 的不透明性
// 在合成层级覆盖 vibrancy backdrop 来达到"看不到桌面壁纸"的效果：
//
//   - liquid-glass + windowed: bg='#00000000' 透明 → vibrancy backdrop 可见（桌面壁纸） ✓
//   - liquid-glass + fullscreen: bg=DARWIN_FULLSCREEN_BACKING_* 不透明 → 盖住 vibrancy → 看到 backing ✓
//   - ready-glass + windowed: bg=READY_GLASS_BACKING_* 不透明 → 盖住 vibrancy → 看到 backing ✓
//   - ready-glass + fullscreen: 同上 ✓
//
// 在 ready-glass 模式下 vibrancy 虽然是 'under-window' 但被不透明 bg 完全盖住，
// 视觉效果跟"真正关闭 vibrancy"完全一致——spec §1.2 真实意图是"视觉上不透出桌面"，
// 而非"API 状态 vibrancy 必须是 null"。这条工程取舍以可靠性优先于 spec 字面合规。
//
// 关键好处：darwin 上所有 skin / fullscreen 组合的 vibrancy 字段都是 'under-window'，
// applyMaterial 的 diff 在 darwin 上**永远不会变化 vibrancy 字段**，根本消除 macOS
// vibrancy 重建 race 的可能。
//
// 注意：这要求 macOS NSVisualEffectView 的合成顺序是 [vibrancy backdrop, bg, content]
// 自下而上。如果未来 macOS 版本改了合成模型，需要重新评估。

const DARWIN_STATE_TABLE: Record<`${ThemeSkin}:${'fullscreen' | 'windowed'}`, (theme: ResolvedTheme) => MaterialOutputs> = {
  'liquid-glass:windowed': () => ({
    backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT,
    vibrancy: 'under-window',
  }),
  'liquid-glass:fullscreen': (theme) => ({
    backgroundColor: theme === 'dark' ? DARWIN_FULLSCREEN_BACKING_DARK : DARWIN_FULLSCREEN_BACKING_LIGHT,
    vibrancy: 'under-window',
  }),
  'ready-glass:windowed': (theme) => ({
    backgroundColor: theme === 'dark' ? READY_GLASS_BACKING_DARK : READY_GLASS_BACKING_LIGHT,
    // 也保持 'under-window'：不透明 bg 在合成层级盖住 vibrancy，视觉等同于关闭 vibrancy，
    // 但避免了 ready-glass ↔ liquid-glass 切换时 vibrancy 重建 race。
    vibrancy: 'under-window',
  }),
  'ready-glass:fullscreen': (theme) => ({
    backgroundColor: theme === 'dark' ? READY_GLASS_BACKING_DARK : READY_GLASS_BACKING_LIGHT,
    vibrancy: 'under-window',
  }),
}

/**
 * 计算给定输入下的材料目标。
 *
 * darwin: 按 4 行状态表（skin × isFullscreen）决定
 * win32 / linux: 忽略 skin / isFullscreen，按 resolvedTheme 输出对应不透明 bg；vibrancy 恒 null
 *
 * 完全纯函数，方便测试。
 */
export function computeMaterial(inputs: MaterialInputs): MaterialOutputs {
  if (inputs.platform === 'darwin') {
    const fence = inputs.isFullscreen ? 'fullscreen' : 'windowed'
    const key = `${inputs.skin}:${fence}` as const
    return DARWIN_STATE_TABLE[key](inputs.resolvedTheme)
  }

  // 非 macOS：vibrancy 在 Win/Linux 没有等价物，本轮不引入跨平台风格统一。
  // setBackgroundMaterial('mica') 在 Win32 由 applyNonDarwinPlatformExtras 处理（不在状态表里）。
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

// ----- WindowMaterialController：状态机持有者 -----

/**
 * 包住 (mainWindow, 内部 fullscreen flag, lastAppliedMaterial 缓存) 三件套，
 * 让 main/index.ts 不用直接管理这些。
 *
 * 用法：
 *   const controller = createWindowMaterialController({ window, platform, getTheme })
 *   controller.applyInitial()  // createWindow 后调一次
 *   controller.attachLifecycle() // 挂 fullscreen 监听
 *   // 之后 theme:set / theme:setSkin / nativeTheme.updated 都调：
 *   controller.sync()
 */
export interface WindowMaterialControllerOptions {
  window: BrowserWindow
  platform: SupportedPlatform
  /** 实时读取，每次 sync 拉一次（让 theme/skin 切换时自动反映） */
  getTheme: () => { skin: ThemeSkin; resolvedTheme: ResolvedTheme }
  /** Stage 2 用：fullscreen 状态改变后通知 renderer，让 renderer 设置 data-native-fullscreen */
  notifyFullscreenChanged?: (isFullscreen: boolean) => void
}

export interface WindowMaterialController {
  /** 当前的 fullscreen 标记（内部追踪，不读 mainWindow.isFullScreen()） */
  isFullscreen: () => boolean
  /** 重新查表 → diff → 只 set 变化字段。所有触发点都该调这个。 */
  sync: () => void
  /** Stage 2 用：挂 will-enter/enter/will-leave/leave-full-screen 监听 */
  attachLifecycle: () => void
  /** createWindow 之后调一次，确保首帧之后状态对齐 */
  applyInitial: () => void
}

export function createWindowMaterialController(options: WindowMaterialControllerOptions): WindowMaterialController {
  const { window, platform, getTheme, notifyFullscreenChanged } = options

  let materialFullscreenState = false
  let lastAppliedMaterial: MaterialOutputs | null = null

  const sync = (): void => {
    if (window.isDestroyed()) return
    const { skin, resolvedTheme } = getTheme()
    const target = computeMaterial({
      platform,
      skin,
      resolvedTheme,
      isFullscreen: materialFullscreenState,
    })
    lastAppliedMaterial = applyMaterial(window, target, lastAppliedMaterial, platform)
  }

  const applyInitial = (): void => {
    applyNonDarwinPlatformExtras(window, platform)
    if (platform === 'darwin') {
      window.setWindowButtonPosition({ x: 14, y: 14 })
    }
    sync()
  }

  const attachLifecycle = (): void => {
    // 仅 macOS 有 fullscreen 生命周期事件（will-enter/leave-full-screen 是 macOS-only）。
    // 非 macOS 上挂这些监听器无害但永远不会触发，所以提前 return 避免 lint 噪音。
    if (platform !== 'darwin') return
    if (window.isDestroyed()) return

    // Electron 34 类型定义里只覆盖了 'enter-full-screen' / 'leave-full-screen'，
    // 'will-enter-full-screen' / 'will-leave-full-screen' 是 macOS 运行时支持但未进 .d.ts 的事件。
    // 用一个局部类型 cast 桥接，避免在每个 on() 上单独打 @ts-expect-error。
    const macFullscreenEmitter = window as BrowserWindow & {
      on(event: 'will-enter-full-screen' | 'will-leave-full-screen', listener: () => void): BrowserWindow
    }

    // 关键架构选择：vibrancy 在整个 liquid-glass lifecycle 中始终 'under-window'，
    // 不主动 set 到 null。fullscreen 期间用不透明 backgroundColor 在合成层级上盖住 vibrancy
    // backdrop 来防止桌面壁纸泄漏（Bug 2）。退出全屏只把 bg 改回透明，vibrancy 从头到尾
    // 没被 Electron API 碰过——让 macOS 自己管 NSVisualEffectView 的 stash / restore。
    //
    // **历史教训（验证 1，2026-05-16）**：曾在 Stage 2.6/2.7/2.8 加过一段 vibrancy 重建路径
    // (`setVibrancy(null) → setTimeout → setVibrancy('under-window')`)，目的是修用户报的
    // "退原生全屏后偶发 vibrancy 失效"的 一次性问题。但这套主动 kick 反而把 macOS 一个
    // 本来好端端的状态机推进了"等 Electron 重新激活"分支——HTML5 fullscreen（B 站 iframe
    // 视频全屏）退出时复现稳定的"整片深黑色无法恢复"bug，根因是 setVibrancy('under-window')
    // 被 NSVisualEffectView 静默忽略，留在 null 态 + 透明 bg = 黑。撤回 rebuild 后
    // 让 macOS 自治 stash/restore 是更稳的选择。
    //
    // 4 个 lifecycle handler 都极简："翻 flag + sync() + 通知"。
    // applyMaterial 的 diff 保证只对变化字段调 setter：
    //   - will-enter: bg 变化（透明→backing）调 setBackgroundColor；vibrancy 不变不调
    //   - enter:      幂等 sync
    //   - will-leave: 故意 no-op（保持 backing 不透明覆盖 vibrancy 直到 OS 动画结束）
    //   - leave:      bg 变化（backing→透明）调 setBackgroundColor；vibrancy 不变不调

    macFullscreenEmitter.on('will-enter-full-screen', () => {
      materialFullscreenState = true
      sync()
      notifyFullscreenChanged?.(true)
    })

    window.on('enter-full-screen', () => {
      sync()
    })

    macFullscreenEmitter.on('will-leave-full-screen', () => {
      // intentionally empty
      // 故意不在这里翻 flag / 调 sync——OS 离场动画期间窗口必须保持不透明 backing，
      // 否则瞬间露出透明 + vibrancy backdrop = 用户看到的"切换中"状态会很丑。
      // 等动画结束的 leave-full-screen 才翻 flag、切 bg 回透明。
    })

    window.on('leave-full-screen', () => {
      if (window.isDestroyed()) return
      materialFullscreenState = false
      sync()
      notifyFullscreenChanged?.(false)
    })
  }

  return {
    isFullscreen: () => materialFullscreenState,
    sync,
    attachLifecycle,
    applyInitial,
  }
}
