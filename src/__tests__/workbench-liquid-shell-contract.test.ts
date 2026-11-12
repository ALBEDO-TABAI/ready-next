import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  // allow-source-grep: native material initialization and cross-file CSS hooks are static integration contracts, without opening Electron.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench shell exposes dedicated liquid glass hooks on primary chrome surfaces', () => {
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const iconRail = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellRail.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(topBar, /data-liquid-shell="topbar"/)
  assert.match(iconRail, /data-liquid-shell="icon-rail"/)
  assert.match(sidePanel, /data-liquid-shell="side-panel"/)
  assert.match(tabs, /data-liquid-shell="workbench-tabs"/)
  assert.match(chatPanel, /data-liquid-shell="chat-panel"/)
})

test('liquid glass skin defines shell-level fresnel, noise, and atmosphere contract', () => {
  const styles = readRendererStyles()

  assert.match(styles, /--lg-noise-opacity:/)
  assert.match(styles, /--lg-lens-violet:/)
  assert.match(styles, /--workbench-liquid-chrome-bg:/)
  assert.match(styles, /html:root \.browser-header-surface,\s*html:root \.workbench-tabs-surface \{/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/)
  assert.match(styles, /ready-app-bg/)
})

test('workbench has no backdrop scene; liquid test exercises the composer lens', () => {
  // 2026-06-10: #/liquid-test 从「工作台场景复刻」转型为 LiquidLens 光学调参台。
  // 合同变为：实验页与聊天输入框消费同一个折射组件，参数可在实验页校准后回填。
  const liquidTest = readWorkspaceFile('src/renderer/LiquidTest.tsx')
  const chatInput = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(liquidTest, /from '\.\/components\/ui\/liquid-glass\/LiquidLens'/)
  assert.match(liquidTest, /composer:\s*\{[^}]*strength:\s*2\.05,[^}]*blur:\s*13,[^}]*frost:\s*0,[^}]*blurBeforeRefraction:\s*true/)
  assert.match(chatInput, /from '\.\.\/ui\/liquid-glass\/LiquidLens'/)
  assert.match(chatInput, /blurBeforeRefraction/)
  assert.match(chatInput, /frost=\{0\}/)
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
