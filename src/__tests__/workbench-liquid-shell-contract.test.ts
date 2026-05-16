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

test('Stage 2.7 — leave-full-screen vibrancy rebuild uses setTimeout(>=30ms), NOT setImmediate (race-prone)', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // Stage 2.6 加入了 leave-full-screen 的 vibrancy 重建踢醒序列：
  //   window.setVibrancy(null) → 延时 → window.setVibrancy('under-window') + setBackgroundColor('#00000000')
  // 即使 Electron 层 vibrancy 状态从未改过（Stage 2.4 状态表保持 'under-window'），
  // macOS NSVisualEffectView 仍可能在 fullscreen lifecycle 期间静默丢失 vibrancy。
  // 退出全屏时必须强制一次状态切换序列来踢醒它。
  const codeOnly = materialModule
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // Stage 2.7 关键修正：用 setTimeout(50) 而非 setImmediate。
  // setImmediate 在快机器上 sub-ms 触发，macOS NSVisualEffectView 来不及处理 null 状态，
  // null → under-window 转移被合并成 no-op（用户报的"偶发 vibrancy 失败"）。
  assert.match(codeOnly, /setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{/, 'leave-full-screen rebuild must use setTimeout (Stage 2.7)')
  // 延时值必须 >= 30ms（至少 60fps 一帧 16ms + 充足 buffer）
  const setTimeoutMatch = codeOnly.match(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*,\s*(\d+)\s*\)/)
  assert.ok(setTimeoutMatch, 'setTimeout call should be parseable')
  const delay = parseInt(setTimeoutMatch![1], 10)
  assert.ok(delay >= 30, `setTimeout delay must be >= 30ms (got ${delay}ms) — need to give macOS NSVisualEffectView a full frame to process null state`)

  // setImmediate / process.nextTick 不该再用于 vibrancy 重建（race-prone）
  assert.doesNotMatch(codeOnly, /setImmediate/, 'must not use setImmediate for vibrancy rebuild (Stage 2.7 found it race-prone)')
  assert.doesNotMatch(codeOnly, /process\.nextTick/, 'must not use process.nextTick for vibrancy rebuild')

  // leave-full-screen handler 必须显式做 setVibrancy(null) 同步调用作为重建第一步
  const leaveMatch = codeOnly.match(/\.on\(['"]leave-full-screen['"][\s\S]*?\n\s*\}\)/)
  assert.ok(leaveMatch, 'leave-full-screen handler should exist')
  const leaveBody = leaveMatch![0]
  assert.match(leaveBody, /window\.setVibrancy\(null\)/, 'leave-full-screen must call setVibrancy(null) synchronously to kick rebuild')
  assert.match(leaveBody, /window\.setVibrancy\('under-window'\)/, 'leave-full-screen must call setVibrancy(under-window) after the timeout to re-activate')
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

test('Stage 2.6 — will-enter delegates to sync(); leave-full-screen branches: liquid-glass uses rebuild, ready-glass uses sync()', () => {
  const materialModule = readWorkspaceFile('src/main/modules/window-material/main-window-material.ts')

  // will-enter: 翻 flag → sync → notify (no vibrancy rebuild needed on entry)
  const willEnterMatch = materialModule.match(/\.on\(['"]will-enter-full-screen['"][\s\S]*?\}\)/)
  assert.ok(willEnterMatch)
  const willEnterBody = willEnterMatch![0]
  assert.match(willEnterBody, /materialFullscreenState\s*=\s*true/)
  assert.match(willEnterBody, /\bsync\(\)/)
  assert.match(willEnterBody, /notifyFullscreenChanged/)

  // leave: liquid-glass 走重建路径 (setVibrancy(null) → setTimeout(50) → setVibrancy + setBackgroundColor)；
  //        ready-glass 走标准 sync() 路径（不需要重建，因为 ready-glass bg 在 fullscreen / windowed 间不变）。
  const leaveMatch = materialModule.match(/\.on\(['"]leave-full-screen['"][\s\S]*?\n\s*\}\)/)
  assert.ok(leaveMatch)
  const leaveBody = leaveMatch![0]
  // 必须含 skin 分支
  assert.match(leaveBody, /skin === 'liquid-glass'/)
  // liquid-glass 分支必须有 setTimeout 重建路径（Stage 2.7 替换 setImmediate）
  assert.match(leaveBody, /setTimeout/)
  // 两个分支都必须把 materialFullscreenState 翻成 false 并通知 renderer
  assert.match(leaveBody, /materialFullscreenState\s*=\s*false/)
  assert.match(leaveBody, /notifyFullscreenChanged/)
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
