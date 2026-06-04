import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench shell exposes dedicated liquid glass hooks on primary chrome surfaces', () => {
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const iconButton = readWorkspaceFile('src/renderer/components/ui/IconButton.tsx')

  assert.match(topBar, /data-liquid-shell="topbar"/)
  assert.match(iconRail, /data-liquid-shell="icon-rail"/)
  assert.match(sidePanel, /data-liquid-shell="side-panel"/)
  assert.match(tabs, /data-liquid-shell="workbench-tabs"/)
  assert.match(chatPanel, /data-liquid-shell="chat-panel"/)
  assert.match(iconButton, /data-liquid-button=/)
})

test('liquid glass skin defines shell-level fresnel, noise, and atmosphere contract', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const scene = readWorkspaceFile('src/renderer/components/ui/LiquidGlassScene.tsx')

  assert.match(styles, /--lg-noise-opacity:/)
  assert.match(styles, /--lg-lens-violet:/)
  assert.match(styles, /--workbench-liquid-chrome-bg:/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.browser-header-surface,[\s\S]*\.rss-preview-surface \{/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/)
  assert.match(styles, /ready-app-bg/)
  assert.match(scene, /data-scene=\{scene\}/)
  assert.match(scene, /export type LiquidGlassTone = 'button' \| 'card' \| 'panel'/)
})

test('theme and settings are single-track liquid glass by default', () => {
  const themeStore = readWorkspaceFile('src/renderer/stores/useTheme.ts')
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const previewMocks = readWorkspaceFile('src/renderer/preview/installSettingsPreviewMocks.ts')

  assert.match(themeStore, /return 'liquid-glass'/)
  assert.doesNotMatch(settingsPage, /value:\s*'classic'/)
  assert.match(previewMocks, /searchParams\.get\('skin'\) \|\| 'liquid-glass'/)
})

test('workbench and liquid test share the same scene foundation', () => {
  const liquidTest = readWorkspaceFile('src/renderer/LiquidTest.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(liquidTest, /LiquidSceneProvider/)
  assert.match(liquidTest, /LiquidBackdropScene/)
  assert.match(workbenchMode, /LiquidSceneProvider/)
  assert.doesNotMatch(workbenchMode, /LiquidBackdropScene/)
  assert.match(topBar, /data-liquid-shell="topbar"/)
  assert.match(sidePanel, /data-liquid-shell="side-panel"/)
  assert.match(tabs, /data-liquid-shell="workbench-tabs"/)
  assert.match(chatPanel, /data-liquid-shell="chat-panel"/)
})

test('workbench refreshes the native transparent surface after async shell paint', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(workbenchMode, /TRANSPARENT_SURFACE_REFRESH_DELAYS_MS\s*=\s*\[240, 900\] as const/)
  assert.match(workbenchMode, /window\.electronAPI\?\.window\?\.refreshTransparentSurface/)
  assert.match(workbenchMode, /scheduleWorkbenchSurfaceRefresh/)
  assert.match(workbenchMode, /window\.setTimeout\(\(\) => \{[\s\S]*?void refresh\(\)/)
  assert.match(workbenchMode, /workbenchSurfaceRefreshTimersRef\.current\.forEach\(\(timer\) => window\.clearTimeout\(timer\)\)/)
  assert.match(workbenchMode, /if \(didCommitModeChange\) scheduleWorkbenchSurfaceRefresh\(\)/)
})

test('main window uses native material via window-material controller', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // 主进程通过 controller 管理材料；controller 内部按状态表调用 setVibrancy
  assert.match(mainIndex, /createWindowMaterialController/)
  assert.match(mainIndex, /windowMaterialController\?\.sync\(\)|windowMaterialController\.applyInitial\(\)/)
  assert.match(materialModule, /setVibrancy\(target\.vibrancy\)/)

  // macOS vibrancy 必须从 BrowserWindow 构造期进入，避免透明层第一帧走非 translucent 路径。
  assert.match(mainIndex, /vibrancy:\s*constructorMaterial\?\.vibrancy/)
  assert.match(mainIndex, /initialMaterial:\s*constructorMaterial/)
  assert.match(mainIndex, /visualEffectState:\s*platform === 'darwin' \? 'active' : undefined/)
})

test('验证 2 — main window backgrounds: darwin frozen transparent, non-darwin neutral', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // spec §3.3: #F6F1E7 / #192131 是 ritual 端点色，禁止当稳定窗口底
  assert.doesNotMatch(mainIndex, /'#F6F1E7'/)
  assert.doesNotMatch(mainIndex, /'#192131'/)
  assert.doesNotMatch(materialModule, /'#F6F1E7'/)
  assert.doesNotMatch(materialModule, /'#192131'/)

  // 验证 2：darwin 只用透明常量；不透明 backing 全部移到 DOM 层 .ready-app-bg
  assert.match(materialModule, /DARWIN_LIQUID_GLASS_TRANSPARENT\s*=\s*'#00000000'/)
  // DARWIN_FULLSCREEN_BACKING_* / READY_GLASS_BACKING_* 已退役（不再供 setBackgroundColor 用）
  assert.doesNotMatch(materialModule, /export const DARWIN_FULLSCREEN_BACKING_LIGHT/)
  assert.doesNotMatch(materialModule, /export const DARWIN_FULLSCREEN_BACKING_DARK/)
  assert.doesNotMatch(materialModule, /export const READY_GLASS_BACKING_LIGHT/)
  assert.doesNotMatch(materialModule, /export const READY_GLASS_BACKING_DARK/)

  // 非 macOS 平台沿用原色 (本轮不改 Win/Linux 视觉)
  assert.match(materialModule, /NON_DARWIN_BACKGROUND_LIGHT\s*=\s*'#F7F9FC'/)
  assert.match(materialModule, /NON_DARWIN_BACKGROUND_DARK\s*=\s*'#1A1B1E'/)
})

test('Stage 1 — dead code from earlier Codex attempt is gone', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  // darwinFullscreenMaterialSuppressed 是声明但未写入的死 flag，必须删除
  assert.doesNotMatch(mainIndex, /darwinFullscreenMaterialSuppressed/)
  // READY_WINDOW_BACKGROUND_LIGHT/DARK 用 ritual 端点色当稳定底是 spec 违反
  assert.doesNotMatch(mainIndex, /READY_WINDOW_BACKGROUND_LIGHT|READY_WINDOW_BACKGROUND_DARK/)
  // 旧的 applyNativeWindowMaterial 函数已被 controller 替代
  assert.doesNotMatch(mainIndex, /^function applyNativeWindowMaterial/m)
})

test('Stage 1 — nativeTheme.updated handler refreshes material AND broadcasts', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  // nativeTheme.on('updated') 必须同时做两件事：
  //   1. windowMaterialController.sync() — 让 fullscreen 中 OS 切换深浅色时 backing 跟着变
  //   2. broadcastThemeChanged() — 让 renderer 收到 theme:changed 推送，useTheme 状态同步
  // 不能简化成只调 sync，否则 system 模式下 OS 切换深浅时 renderer 静默不同步。
  const handlerMatch = mainIndex.match(/nativeTheme\.on\('updated',\s*\(\)\s*=>\s*\{[\s\S]*?\}\)/)
  assert.ok(handlerMatch, 'nativeTheme.on(\'updated\') handler should exist as an arrow function block')
  const handlerBody = handlerMatch[0]
  assert.match(handlerBody, /windowMaterialController\?\.sync\(\)/)
  assert.match(handlerBody, /broadcastThemeChanged\(\)/)
})

test('Stage 1 — theme:setSkin IPC handler exists and persists skin to DB', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  assert.match(mainIndex, /ipcMain\.handle\('theme:setSkin'/)
  // skin 输入必须校验为 'liquid-glass' | 'ready-glass'，非法值 fall back 到 'liquid-glass'
  assert.match(mainIndex, /skin === 'ready-glass' \? 'ready-glass' : 'liquid-glass'/)
  // 持久化到 DB 后必须调 sync (刷新材料) + broadcastThemeChanged (通知 renderer)
  assert.match(mainIndex, /THEME_SKIN_SETTING_KEY/)
})

test('Stage 2 — controller attaches 4 fullscreen lifecycle listeners on darwin', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // 4 个 macOS fullscreen 生命周期事件，每个都要挂监听。
  // 'will-enter-full-screen' / 'will-leave-full-screen' 走 macFullscreenEmitter（Electron 34 .d.ts 没覆盖 will-* 事件，需 type cast 桥接）；
  // 'enter-full-screen' / 'leave-full-screen' 直接走 window.on。
  assert.match(materialModule, /\.on\(['"]will-enter-full-screen['"]/)
  assert.match(materialModule, /\.on\(['"]enter-full-screen['"]/)
  assert.match(materialModule, /\.on\(['"]will-leave-full-screen['"]/)
  assert.match(materialModule, /\.on\(['"]leave-full-screen['"]/)

  // 非 macOS 提前 return，避免无意义挂监听
  assert.match(materialModule, /if \(platform !== 'darwin'\) return/)
})

test('验证 2 (2026-05-16) — controller never calls setBackgroundColor/setVibrancy after applyInitial on darwin', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')
  const codeOnly = materialModule
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // attachLifecycle 内的 4 个 handler 都不能调 setBackgroundColor / setVibrancy。
  // backing 完全由 DOM 层 .ready-app-bg 通过 data-native-fullscreen attr 触发的 CSS 变量级联承担。
  const attachLifecycleMatch = codeOnly.match(/const attachLifecycle\s*=[\s\S]*?\n\s*\}\n/)
  assert.ok(attachLifecycleMatch, 'attachLifecycle should exist')
  const lifecycleBody = attachLifecycleMatch![0]
  assert.doesNotMatch(lifecycleBody, /window\.setBackgroundColor/, 'lifecycle handlers must not call setBackgroundColor (validation 2)')
  assert.doesNotMatch(lifecycleBody, /window\.setVibrancy/, 'lifecycle handlers must not call setVibrancy (validation 2)')
  // 禁止 setTimeout / setImmediate / process.nextTick 偷偷做异步 rebuild
  assert.doesNotMatch(lifecycleBody, /setTimeout/, 'lifecycle handlers must not schedule timers')
  assert.doesNotMatch(lifecycleBody, /setImmediate/, 'lifecycle handlers must not use setImmediate')
  assert.doesNotMatch(lifecycleBody, /process\.nextTick/, 'lifecycle handlers must not use process.nextTick')

  // Stage 2.8 的 source-tracking 状态 (`fullscreenSource` / `wasHtmlFullscreen`) 已永久退役
  assert.doesNotMatch(codeOnly, /fullscreenSource/, 'fullscreenSource state retired (validation 2)')
  assert.doesNotMatch(codeOnly, /wasHtmlFullscreen/, 'wasHtmlFullscreen retired (validation 2)')
  // 注：webContents.on('enter-html-full-screen') / leave-html-full-screen 在验证 3 重新登场作为
  // OOPIF 路径的 IPC 兜底源（参见单独的"webContents enter/leave-html-full-screen handlers" 测试）。
  // 它们的存在不影响"lifecycle handler 不动 bg/vibrancy"的合同——因为它们也只调
  // notifyFullscreenChanged，不调任何 setter。
})

test('验证 2 — computeMaterial darwin branch returns frozen {transparent, under-window} only', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')
  const codeOnly = materialModule
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // computeMaterial 的 darwin 分支必须只返回稳定值；不允许根据 skin / isFullscreen / resolvedTheme 切换
  const computeMatch = codeOnly.match(/export function computeMaterial[\s\S]*?\n\}/)
  assert.ok(computeMatch, 'computeMaterial should exist')
  const computeBody = computeMatch![0]

  // darwin 分支只返回 DARWIN_LIQUID_GLASS_TRANSPARENT + 'under-window'
  const darwinBranch = computeBody.match(/if\s*\(\s*inputs\.platform\s*===\s*'darwin'\s*\)[\s\S]*?\}/)
  assert.ok(darwinBranch, 'darwin branch should exist')
  assert.match(darwinBranch![0], /DARWIN_LIQUID_GLASS_TRANSPARENT/)
  assert.match(darwinBranch![0], /vibrancy:\s*'under-window'/)
  // darwin 分支禁止读 skin / isFullscreen / resolvedTheme（差异化都退役了）
  assert.doesNotMatch(darwinBranch![0], /inputs\.skin/, 'darwin compute must not branch on skin (validation 2)')
  assert.doesNotMatch(darwinBranch![0], /inputs\.isFullscreen/, 'darwin compute must not branch on isFullscreen (validation 2)')
  assert.doesNotMatch(darwinBranch![0], /inputs\.resolvedTheme/, 'darwin compute must not branch on resolvedTheme (validation 2)')
})

test('验证 2 — lifecycle handler shape: flag flip + IPC only, no sync()', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // will-enter: 翻 flag + 通知 renderer，不调 sync (sync 在 darwin 上是 no-op 但也不该多余调)
  const willEnterMatch = materialModule.match(/\.on\(['"]will-enter-full-screen['"][\s\S]*?\}\)/)
  assert.ok(willEnterMatch)
  const willEnterBody = willEnterMatch![0]
  assert.match(willEnterBody, /materialFullscreenState\s*=\s*true/)
  assert.match(willEnterBody, /notifyFullscreenChanged\?\.\(true\)/)

  // leave: 翻 flag + 通知，单一分支，无 skin/source 判断
  const leaveMatch = materialModule.match(/window\.on\(['"]leave-full-screen['"][\s\S]*?\n\s*\}\)/)
  assert.ok(leaveMatch)
  const leaveBody = leaveMatch![0]
  assert.match(leaveBody, /materialFullscreenState\s*=\s*false/)
  assert.match(leaveBody, /notifyFullscreenChanged\?\.\(false\)/)
  assert.doesNotMatch(leaveBody, /skin\s*===\s*'liquid-glass'/, 'no skin branching')
  assert.doesNotMatch(leaveBody, /skin\s*!==\s*'liquid-glass'/, 'no skin branching')
})

test('验证 3 — webContents enter/leave-html-full-screen handlers provide OOPIF fallback IPC', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // OOPIF (cross-origin iframe) 路径下 BrowserWindow.leave-full-screen 不可靠 fire——
  // webContents-level html-fullscreen 事件是 Chromium 统一出口，作为兜底。
  // 必须查 window.isFullScreen() 而不是硬编码 true/false，正确处理 CMD+CTRL+F 嵌套 iframe 的边界 case。
  const enterHtmlMatch = materialModule.match(/webContents\.on\(['"]enter-html-full-screen['"][\s\S]*?\}\)/)
  assert.ok(enterHtmlMatch, 'enter-html-full-screen webContents handler must exist (OOPIF fallback)')
  const enterHtmlBody = enterHtmlMatch![0]
  assert.match(enterHtmlBody, /window\.isFullScreen\(\)/, 'enter-html handler must query window.isFullScreen() for authoritative state')
  assert.match(enterHtmlBody, /notifyFullscreenChanged/, 'enter-html handler must push IPC')

  const leaveHtmlMatch = materialModule.match(/webContents\.on\(['"]leave-html-full-screen['"][\s\S]*?\}\)/)
  assert.ok(leaveHtmlMatch, 'leave-html-full-screen webContents handler must exist (OOPIF fallback)')
  const leaveHtmlBody = leaveHtmlMatch![0]
  assert.match(leaveHtmlBody, /window\.isFullScreen\(\)/, 'leave-html handler must query window.isFullScreen() for authoritative state')
  assert.match(leaveHtmlBody, /notifyFullscreenChanged/, 'leave-html handler must push IPC')
})

test('Stage 2 — will-leave-full-screen handler is a deliberate no-op (do not expose transparent mid-animation)', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  const willLeaveMatch = materialModule.match(/\.on\(['"]will-leave-full-screen['"],\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)/)
  assert.ok(willLeaveMatch, 'will-leave-full-screen handler should exist')
  const body = willLeaveMatch![1]
  // 不应该有任何 setVibrancy / setBackgroundColor / flag 翻转 / sync 调用
  // OS 离场动画期间窗口必须保持不透明 backing；切换到透明会让动画露丑
  assert.doesNotMatch(body, /setVibrancy/)
  assert.doesNotMatch(body, /setBackgroundColor/)
  assert.doesNotMatch(body, /materialFullscreenState\s*=/)
  assert.doesNotMatch(body, /\bsync\(\)/)
})
