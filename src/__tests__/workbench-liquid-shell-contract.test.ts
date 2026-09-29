import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function findCssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = source.search(new RegExp(`${escaped}(?=\\s*[,\\{])`))
  assert.notEqual(start, -1, `${selector} should exist`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `${selector} should have a declaration block`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  assert.fail(`${selector} declaration block should close`)
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
  const styles = readRendererStyles()
  const scene = readWorkspaceFile('src/renderer/components/ui/LiquidGlassScene.tsx')

  assert.match(styles, /--lg-noise-opacity:/)
  assert.match(styles, /--lg-lens-violet:/)
  assert.match(styles, /--workbench-liquid-chrome-bg:/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.browser-header-surface,[\s\S]*\.rss-preview-surface \{/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/)
  assert.match(styles, /ready-app-bg/)
  assert.match(scene, /data-scene=\{scene\}/)
  // 2026-06-10: liquid-glass-react 退役，折射由自研 LiquidLens 承担；
  // 场景文件不得再引入第三方玻璃库。
  assert.doesNotMatch(scene, /liquid-glass-react/)
})

test('theme and settings are single-track liquid glass by default', () => {
  const themeStore = readWorkspaceFile('src/renderer/stores/useTheme.ts')
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const previewMocks = readWorkspaceFile('src/renderer/preview/installSettingsPreviewMocks.ts')

  assert.match(themeStore, /return 'liquid-glass'/)
  assert.doesNotMatch(settingsPage, /value:\s*'classic'/)
  assert.match(previewMocks, /searchParams\.get\('skin'\) \|\| 'liquid-glass'/)
})

test('workbench keeps the liquid scene; liquid test exercises the composer lens', () => {
  // 2026-06-10: #/liquid-test 从「工作台场景复刻」转型为 LiquidLens 光学调参台。
  // 合同变为：实验页与聊天输入框消费同一个折射组件，参数可在实验页校准后回填。
  const liquidTest = readWorkspaceFile('src/renderer/LiquidTest.tsx')
  const chatInput = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(liquidTest, /from '\.\/components\/ui\/liquid-glass\/LiquidLens'/)
  assert.match(liquidTest, /composer:\s*\{[^}]*strength:\s*2\.05,[^}]*blur:\s*13,[^}]*frost:\s*0,[^}]*blurBeforeRefraction:\s*true/)
  assert.match(chatInput, /from '\.\.\/ui\/liquid-glass\/LiquidLens'/)
  assert.match(chatInput, /blurBeforeRefraction/)
  assert.match(chatInput, /frost=\{0\}/)
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
  // skin 输入必须校验为 'liquid-glass' | 'ready-glass' | 'solid-green-glass' | 'solid-blue-glass'，非法值 fall back 到 'liquid-glass'
  // a948f82d style(ui): polish Ready glass theme surfaces（新增 solid-green-glass）+ 26a3ce1c style(ui): add solid blue glass theme（新增 solid-blue-glass）
  assert.match(
    mainIndex,
    /skin === 'ready-glass' \|\| skin === 'solid-green-glass' \|\| skin === 'solid-blue-glass' \? skin : 'liquid-glass'/,
  )
  // 持久化到 DB 后必须调 sync (刷新材料) + broadcastThemeChanged (通知 renderer)
  assert.match(mainIndex, /THEME_SKIN_SETTING_KEY/)
})

test('liquid glass sliders preserve the groove and use lens-backed convex thumbs', () => {
  const sliderStyles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')
  const appStyles = readRendererStyles()
  const iconRail = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')
  const modeTabs = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')
  const modeSwitch = readWorkspaceFile('src/renderer/components/document/DraggableModeSwitch.tsx')

  const iconRailGroove = findCssBlock(sliderStyles, "html[data-skin='liquid-glass'] .icon-rail-slider")
  const modeTabsGroove = findCssBlock(sliderStyles, "html[data-skin='liquid-glass'] .draggable-mode-tabs")
  const documentSwitchGroove = findCssBlock(appStyles, "html[data-skin='liquid-glass'] .draggable-mode-switch")
  const iconRailThumb = findCssBlock(sliderStyles, "html[data-skin='liquid-glass'] .icon-rail-slider__thumb")
  const modeTabsThumb = findCssBlock(sliderStyles, "html[data-skin='liquid-glass'] .draggable-mode-tabs__thumb")
  const documentSwitchThumb = findCssBlock(appStyles, "html[data-skin='liquid-glass'] .draggable-mode-switch__thumb")
  const darkDocumentSwitchGroove = findCssBlock(appStyles, "html[data-theme='dark'][data-skin='liquid-glass'] .draggable-mode-switch")
  const darkDocumentSwitchThumb = findCssBlock(appStyles, "html[data-theme='dark'][data-skin='liquid-glass'] .draggable-mode-switch__thumb")
  const chatModeDock = findCssBlock(appStyles, ".ready-chat-mode-tabs-dock")
  const chatComposerContextRow = findCssBlock(appStyles, ".ready-chat-composer-context-row")
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const chatModeDockGroove = findCssBlock(appStyles, "html[data-skin='liquid-glass'] .ready-chat-mode-tabs-dock .draggable-mode-tabs")
  // 74ebfa98 — the chat dock surface/projection share one :is() rule with the project selector capsule.
  const chatDockSurfaceSelector = ':is(.ready-chat-mode-tabs-dock .draggable-mode-tabs__surface, .ready-chat-project-surface)'
  const chatDockProjectionSelector = ':is(.ready-chat-mode-tabs-dock .draggable-mode-tabs__projection, .ready-chat-project-projection)'
  const chatModeDockSurface = findCssBlock(appStyles, `html[data-skin='liquid-glass'] ${chatDockSurfaceSelector}`)
  const chatModeDockProjection = findCssBlock(appStyles, `html[data-skin='liquid-glass'] ${chatDockProjectionSelector}`)
  const darkChatModeDockGroove = findCssBlock(appStyles, "html[data-theme='dark'][data-skin='liquid-glass'] .ready-chat-mode-tabs-dock .draggable-mode-tabs")
  const darkChatModeDockSurface = findCssBlock(appStyles, `html[data-theme='dark'][data-skin='liquid-glass'] ${chatDockSurfaceSelector}`)
  const darkChatModeDockProjection = findCssBlock(appStyles, `html[data-theme='dark'][data-skin='liquid-glass'] ${chatDockProjectionSelector}`)
  const appModeTabsSectionStart = appStyles.indexOf('/* Draggable Mode Tabs - 4-way switch')
  assert.notEqual(appModeTabsSectionStart, -1, 'index.css should keep the draggable mode tabs section')
  const appModeTabsSection = appStyles.slice(appModeTabsSectionStart)
  const appModeTabsThumb = findCssBlock(appModeTabsSection, "html[data-skin='liquid-glass'] .draggable-mode-tabs__thumb")
  const darkAppModeTabsGroove = findCssBlock(appModeTabsSection, "html[data-theme='dark'][data-skin='liquid-glass'] .draggable-mode-tabs")
  const darkAppModeTabsThumb = findCssBlock(appModeTabsSection, "html[data-theme='dark'][data-skin='liquid-glass'] .draggable-mode-tabs__thumb")

  // 8ab48cd7 style(ui): checkpoint liquid glass polish — icon rail 槽改为中性实底凹槽：
  // thumb 不再放大（1），边线亮描边，实体底色，双 inset 塑形，去掉 backdrop 模糊。
  assert.match(iconRailGroove, /--ready-workbench-slider-thumb-scale:\s*1;/)
  assert.match(iconRailGroove, /border-color:\s*rgba\(255, 255, 255, 0\.42\);/)
  assert.match(iconRailGroove, /background:\s*rgba\(214, 214, 211, 0\.84\);/)
  assert.match(
    iconRailGroove,
    /inset 0 1px 0 rgba\(255, 255, 255, 0\.46\),\s*inset 0 -1px 0 rgba\(42, 45, 48, 0\.045\)/,
  )
  assert.match(iconRailGroove, /backdrop-filter:\s*none;/)
  // 8ab48cd7 — 工作台四模式槽改为 Ready 橙渐变轨道（thumb 1.04，实体投影，无 backdrop 模糊）。
  assert.match(modeTabsGroove, /--ready-workbench-slider-thumb-scale:\s*1\.04;/)
  assert.match(
    modeTabsGroove,
    /border-color:\s*color-mix\(in srgb, var\(--color-ready-orange\) 42%, rgba\(92, 26, 10, 0\.32\)\);/,
  )
  assert.match(
    modeTabsGroove,
    /linear-gradient\(180deg, color-mix\(in srgb, var\(--color-ready-orange, #ff4b2b\) 82%, white\) 0%, var\(--color-ready-orange, #ff4b2b\) 54%, color-mix\(in srgb, var\(--color-ready-orange, #ff4b2b\) 88%, black\) 100%\)/,
  )
  assert.match(modeTabsGroove, /inset 0 1px 0 rgba\(255, 255, 255, 0\.22\)/)
  assert.match(modeTabsGroove, /backdrop-filter:\s*none;/)
  // 8ab48cd7 — 文档切换槽 thumb 放大退役（1.1 → 1）。
  assert.match(documentSwitchGroove, /--ready-document-switch-thumb-scale:\s*1;/)
  assert.match(documentSwitchGroove, /border-color:\s*transparent;/)
  assert.match(documentSwitchGroove, /background:\s*color-mix\(in srgb, var\(--workbench-rail-slot-bg\) 86%, rgba\(255, 255, 255, 0\.34\)\);/)
  assert.match(documentSwitchGroove, /box-shadow:\s*var\(--workbench-rail-slot-shadow\);/)
  assert.match(documentSwitchGroove, /blur\(calc\(var\(--lg-blur-soft\) \* 0\.25\)\)/)
  assert.doesNotMatch(documentSwitchGroove, /0\.045/)
  assert.match(appStyles, /html\[data-skin='liquid-glass'\] \.draggable-mode-switch::before\s*\{[\s\S]*?display:\s*none;/)
  // 74ebfa98 — the dock now sits in the composer context row beside the project selector;
  // the -12px overlap onto the composer moved from the dock to that shared row.
  assert.match(chatPanelBody, /<div className="ready-chat-composer-context-row">\s*<ProjectSelector \/>\s*\{modeSwitcher\}\s*<\/div>/)
  assert.match(chatComposerContextRow, /margin-bottom:\s*-12px;/)
  assert.doesNotMatch(chatModeDock, /margin-bottom/)
  // 聊天 dock 外壳不再叠加第二层底色与边框，材质与输入框共用。
  assert.match(chatModeDockGroove, /--ready-workbench-slider-thumb-scale:\s*1\.08;/)
  assert.match(chatModeDockGroove, /border-color:\s*transparent;/)
  assert.match(chatModeDockGroove, /background:\s*transparent;/)
  assert.match(chatModeDockGroove, /box-shadow:\s*none;/)
  assert.match(chatModeDockGroove, /backdrop-filter:\s*none;/)
  assert.match(chatModeDockSurface, /background:\s*rgba\(248,\s*250,\s*252,\s*0\.32\);/)
  assert.match(chatModeDockSurface, /inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.42\)/)
  assert.match(chatModeDockProjection, /filter:\s*blur\(4\.5px\) saturate\(1\.18\) contrast\(0\.82\) brightness\(1\.04\);/)

  for (const darkGrooveBlock of [darkDocumentSwitchGroove, darkAppModeTabsGroove]) {
    assert.match(darkGrooveBlock, /border-color:\s*transparent;/)
    assert.match(darkGrooveBlock, /background:\s*var\(--workbench-rail-slot-bg\);/)
    assert.match(darkGrooveBlock, /box-shadow:\s*var\(--workbench-rail-slot-shadow\);/)
    assert.match(darkGrooveBlock, /saturate\(100%\)/)
  }
  assert.match(darkChatModeDockGroove, /border-color:\s*transparent;/)
  assert.match(darkChatModeDockGroove, /background:\s*transparent;/)
  assert.match(darkChatModeDockGroove, /box-shadow:\s*none;/)
  assert.match(darkChatModeDockSurface, /background:\s*rgba\(26,\s*26,\s*26,\s*0\.62\);/)
  assert.match(darkChatModeDockSurface, /inset 0 1px 0 rgba\(232,\s*232,\s*232,\s*0\.14\)/)
  assert.match(darkChatModeDockProjection, /filter:\s*blur\(3\.5px\) saturate\(0\) contrast\(0\.78\) brightness\(0\.78\);/)

  for (const thumbBlock of [iconRailThumb, appModeTabsThumb]) {
    assert.match(thumbBlock, /radial-gradient\(ellipse 110% 62% at 50% -12%/)
    assert.match(thumbBlock, /inset 0 -2px 4px/)
    assert.match(thumbBlock, /inset 2px 0 4px/)
    assert.doesNotMatch(thumbBlock, /rgba\(244, 242, 237/)
    assert.doesNotMatch(thumbBlock, /rgba\(233, 229, 221/)
    assert.doesNotMatch(thumbBlock, /0 6px 20px rgba\(0, 0, 0/)
  }
  // 8ab48cd7 style(ui): checkpoint liquid glass polish — 四模式 thumb（sliders.css 侧）改为暖白实体渐变 + 细 inset 描边。
  assert.match(modeTabsThumb, /radial-gradient\(ellipse 118% 72% at 42% -8%/)
  assert.match(
    modeTabsThumb,
    /linear-gradient\(180deg, rgba\(248, 248, 244, 0\.96\) 0%, rgba\(209, 211, 205, 0\.94\) 100%\)/,
  )
  assert.match(modeTabsThumb, /inset 0 1px 0 rgba\(255, 255, 255, 0\.76\)/)
  assert.match(modeTabsThumb, /border-color:\s*rgba\(255, 255, 255, 0\.66\);/)
  assert.doesNotMatch(modeTabsThumb, /rgba\(244, 242, 237/)
  assert.doesNotMatch(modeTabsThumb, /rgba\(233, 229, 221/)
  assert.doesNotMatch(modeTabsThumb, /0 6px 20px rgba\(0, 0, 0/)
  // 8ab48cd7 — 文档模式切换 thumb 改为 Ready 橙实体（#ff5032 → #ff4b2b）。
  assert.match(documentSwitchThumb, /linear-gradient\(180deg, #ff5032 0%, #ff4b2b 100%\)/)
  assert.match(documentSwitchThumb, /inset 0 0 0 1px rgba\(255, 255, 255, 0\.14\)/)
  assert.match(documentSwitchThumb, /border-color:\s*rgba\(255, 255, 255, 0\.20\);/)
  assert.doesNotMatch(documentSwitchThumb, /rgba\(244, 242, 237/)
  assert.doesNotMatch(documentSwitchThumb, /rgba\(233, 229, 221/)
  assert.doesNotMatch(documentSwitchThumb, /0 6px 20px rgba\(0, 0, 0/)
  assert.match(darkAppModeTabsThumb, /rgba\(235, 235, 230, 0\.16\)/)
  assert.match(darkAppModeTabsThumb, /inset 0 -2px 4px rgba\(0, 0, 0, 0\.20\)/)
  assert.doesNotMatch(darkAppModeTabsThumb, /rgba\(232, 240, 255/)
  // 8ab48cd7 — 暗色文档切换 thumb 同步 Ready 橙实体（#ff5d40 → #ff5638）。
  assert.match(darkDocumentSwitchThumb, /linear-gradient\(180deg, #ff5d40 0%, #ff5638 100%\)/)
  assert.match(darkDocumentSwitchThumb, /inset 0 0 0 1px rgba\(255, 255, 255, 0\.13\)/)
  assert.doesNotMatch(darkDocumentSwitchThumb, /rgba\(232, 240, 255/)

  assert.match(iconRail, /<LiquidLens[\s\S]*className="ready-slider-thumb-lens"[\s\S]*bevel=\{4\}[\s\S]*depth=\{8\}[\s\S]*ior=\{1\.22\}[\s\S]*dome=\{0\.7\}[\s\S]*strength=\{1\.05\}[\s\S]*blur=\{0\}/)
  assert.match(modeTabs, /from '..\/ui\/liquid-glass\/LiquidBackdropProjection'/)
  assert.match(modeTabs, /<LiquidLens[\s\S]*className="draggable-mode-tabs__surface"[\s\S]*bevel=\{6\}[\s\S]*depth=\{18\.5\}[\s\S]*ior=\{1\.34\}[\s\S]*dome=\{0\.65\}[\s\S]*profile="squircle"[\s\S]*strength=\{2\}[\s\S]*blur=\{3\.5\}[\s\S]*blurBeforeRefraction[\s\S]*backdropContent=\{\(/)
  assert.match(modeTabs, /<LiquidBackdropProjection[\s\S]*className="draggable-mode-tabs__projection"[\s\S]*sourceMaskRadius=\{19\}/)
  assert.match(modeTabs, /<LiquidLens[\s\S]*className="ready-slider-thumb-lens"[\s\S]*bevel=\{6\}[\s\S]*depth=\{14\}[\s\S]*ior=\{1\.3\}[\s\S]*dome=\{1\.15\}[\s\S]*strength=\{1\.42\}[\s\S]*blur=\{0\}/)
  assert.match(modeSwitch, /<LiquidLens[\s\S]*className="ready-slider-thumb-lens"[\s\S]*ior=\{1\.22\}[\s\S]*dome=\{0\.7\}[\s\S]*blur=\{0\}/)
  assert.match(sliderStyles, /\.icon-rail-slider__thumb\s*\{[\s\S]*transform:\s*scale\(var\(--ready-workbench-slider-thumb-scale, 1\)\);/)
  assert.match(sliderStyles, /\.draggable-mode-tabs__thumb\s*\{[\s\S]*transform:\s*translateX\(calc\(var\(--dmt-thumb-pos[\s\S]*scale\(var\(--ready-workbench-slider-thumb-scale, 1\)\);/)
  // 皮肤缩放变量与预览下沉缩放（sinkScale）在同一 transform 相乘：变量仍生效。
  assert.match(modeSwitch, /scale\(calc\(var\(--ready-document-switch-thumb-scale, 1\) \* \$\{sinkScale\}\)\)/)
  assert.match(appStyles, /\.ready-slider-thumb-lens\s*\{[\s\S]*z-index:\s*1;/)
})
