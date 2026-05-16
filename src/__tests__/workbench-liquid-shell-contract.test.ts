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

test('main window uses native material via window-material controller', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // 主进程通过 controller 管理材料；controller 内部按状态表调用 setVibrancy
  assert.match(mainIndex, /createWindowMaterialController/)
  assert.match(mainIndex, /windowMaterialController\?\.sync\(\)|windowMaterialController\.applyInitial\(\)/)
  assert.match(materialModule, /setVibrancy\(target\.vibrancy\)/)

  // visualEffectState 'active' 仍由 BrowserWindow 构造保留（macOS vibrancy 配套）
  assert.match(mainIndex, /visualEffectState:\s*platform === 'darwin' \? 'active' : undefined/)
})

test('Stage 1 — main window backgrounds use neutral colors, not ritual endpoints', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // spec §3.3: #F6F1E7 / #192131 是 ritual 端点色，禁止当稳定窗口底
  assert.doesNotMatch(mainIndex, /'#F6F1E7'/)
  assert.doesNotMatch(mainIndex, /'#192131'/)
  assert.doesNotMatch(materialModule, /'#F6F1E7'/)
  assert.doesNotMatch(materialModule, /'#192131'/)

  // 状态表使用的色常量
  assert.match(materialModule, /DARWIN_FULLSCREEN_BACKING_LIGHT\s*=\s*'#DEE1E4'/)
  assert.match(materialModule, /DARWIN_FULLSCREEN_BACKING_DARK\s*=\s*'#282D33'/)
  assert.match(materialModule, /READY_GLASS_BACKING_LIGHT\s*=\s*'#FFFFFF'/)
  assert.match(materialModule, /READY_GLASS_BACKING_DARK\s*=\s*'#1A1B1E'/)

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

test('验证 1 (2026-05-16) — leave-full-screen must NOT manipulate vibrancy at all', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // 验证 1 决定：撤回 Stage 2.6/2.7/2.8 的 vibrancy 重建路径。
  // 让 macOS 自己管 NSVisualEffectView stash/restore；Electron 不主动 setVibrancy(null)。
  // 历史上加重建是为了修一次性"偶发 vibrancy 失效"，但 rebuild 本身在 HTML5 fullscreen
  // 退出场景（B 站 iframe）触发了更严重的"整片深黑色无法恢复"。撤回后让 OS 自治更稳。
  const codeOnly = materialModule
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  const leaveMatch = codeOnly.match(/\.on\(['"]leave-full-screen['"][\s\S]*?\n\s*\}\)/)
  assert.ok(leaveMatch, 'leave-full-screen handler should exist')
  const leaveBody = leaveMatch![0]

  // 关键合同：leave-full-screen handler 内禁止任何 setVibrancy 调用（无论传 null 还是
  // 'under-window'）。任何 vibrancy 重建尝试都属于 Stage 2.6 回潮。
  assert.doesNotMatch(leaveBody, /setVibrancy/, 'leave-full-screen must not call setVibrancy (validation 1: let macOS auto-restore)')
  // 同时禁止 setTimeout 延时——撤回 rebuild 后，leave 必须同步走 flag + sync + notify。
  assert.doesNotMatch(leaveBody, /setTimeout/, 'leave-full-screen must not schedule any timer (rebuild path retired)')
  // 也不能用 setImmediate / process.nextTick 偷偷重建。
  assert.doesNotMatch(leaveBody, /setImmediate/, 'leave-full-screen must not use setImmediate')
  assert.doesNotMatch(leaveBody, /process\.nextTick/, 'leave-full-screen must not use process.nextTick')

  // 模块整体也不该有 fullscreenSource / wasHtmlFullscreen / enter-html-full-screen 监听等
  // Stage 2.8 source-tracking 残留——撤回 rebuild 后这套区分已无意义。
  assert.doesNotMatch(codeOnly, /fullscreenSource/, 'fullscreenSource state should be removed (validation 1)')
  assert.doesNotMatch(codeOnly, /wasHtmlFullscreen/, 'wasHtmlFullscreen local should be removed (validation 1)')
  assert.doesNotMatch(
    codeOnly,
    /enter-html-full-screen/,
    'no html-fullscreen event subscription needed once rebuild is gone (validation 1)',
  )
})

test('Stage 2 — liquid-glass fullscreen state table entry uses under-window vibrancy (NOT null)', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // 提取 DARWIN_STATE_TABLE 块
  const tableMatch = materialModule.match(/const DARWIN_STATE_TABLE[\s\S]*?\}\n\}/)
  assert.ok(tableMatch, 'DARWIN_STATE_TABLE should exist')
  const tableBody = tableMatch![0]

  // 提取 'liquid-glass:fullscreen' 行
  const lqFullscreenMatch = tableBody.match(/'liquid-glass:fullscreen':[\s\S]*?\}\)/)
  assert.ok(lqFullscreenMatch, 'liquid-glass:fullscreen entry should exist')
  const lqFullscreenBody = lqFullscreenMatch![0]
  assert.match(
    lqFullscreenBody,
    /vibrancy:\s*'under-window'/,
    'liquid-glass:fullscreen must use vibrancy=under-window (opaque bg covers it; avoids rebuild race)',
  )
  assert.doesNotMatch(
    lqFullscreenBody,
    /vibrancy:\s*null/,
    'liquid-glass:fullscreen must NOT use vibrancy=null (causes leave-fullscreen rebuild race)',
  )
})

test('验证 1 — leave-full-screen handler shape: flag flip + sync + notify, single branch, no skin/source check', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // will-enter: 翻 flag → sync → notify (no vibrancy rebuild needed on entry)
  const willEnterMatch = materialModule.match(/\.on\(['"]will-enter-full-screen['"][\s\S]*?\}\)/)
  assert.ok(willEnterMatch)
  const willEnterBody = willEnterMatch![0]
  assert.match(willEnterBody, /materialFullscreenState\s*=\s*true/)
  assert.match(willEnterBody, /\bsync\(\)/)
  assert.match(willEnterBody, /notifyFullscreenChanged/)

  // leave: 单一分支，三件事：materialFullscreenState=false、sync()、notifyFullscreenChanged(false)。
  // 不再按 skin / source 分流——验证 1 的结论是任何分流都属于 over-engineering。
  const leaveMatch = materialModule.match(/\.on\(['"]leave-full-screen['"][\s\S]*?\n\s*\}\)/)
  assert.ok(leaveMatch)
  const leaveBody = leaveMatch![0]
  assert.match(leaveBody, /materialFullscreenState\s*=\s*false/)
  assert.match(leaveBody, /\bsync\(\)/)
  assert.match(leaveBody, /notifyFullscreenChanged\?\.\(false\)/)
  // 禁止 skin 分支判断（撤回 Stage 2.6 分流）
  assert.doesNotMatch(leaveBody, /skin\s*===\s*'liquid-glass'/, 'no skin branching (validation 1)')
  assert.doesNotMatch(leaveBody, /skin\s*!==\s*'liquid-glass'/, 'no skin branching (validation 1)')
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
