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
  assert.match(styles, /\.glass-surface-panel::after/)
  assert.match(styles, /mix-blend-mode:\s*soft-light/)
  assert.match(styles, /ready-app-bg/)
  assert.match(scene, /data-scene=\{scene\}/)
  assert.match(scene, /export type LiquidGlassTone = 'button' \| 'card' \| 'panel'/)
})

test('workbench liquid shell uses shared liquid glass primitives on interactive chrome', () => {
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(sidePanel, /LiquidGlassPrimitive/)
  assert.match(tabs, /LiquidGlassPrimitive/)
  assert.match(chatPanel, /LiquidGlassPrimitive/)
})

test('theme and settings are single-track liquid glass by default', () => {
  const themeStore = readWorkspaceFile('src/renderer/stores/useTheme.ts')
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const previewMocks = readWorkspaceFile('src/renderer/preview/installSettingsPreviewMocks.ts')

  assert.match(themeStore, /return 'liquid-glass'/)
  assert.doesNotMatch(settingsPage, /value:\s*'classic'/)
  assert.match(previewMocks, /searchParams\.get\('skin'\) \|\| 'liquid-glass'/)
})

test('workbench and liquid test share the same liquid scene primitives', () => {
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
  assert.match(topBar, /LiquidGlassPrimitive/)
  assert.match(sidePanel, /LiquidGlassPrimitive/)
  assert.match(tabs, /LiquidGlassPrimitive/)
  assert.match(chatPanel, /LiquidGlassPrimitive/)
})

test('main window uses native material instead of renderer fake backdrops', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  assert.match(mainIndex, /setVibrancy\('under-window'\)/)
  assert.match(mainIndex, /applyNativeWindowMaterial\(mainWindow\)/)
  assert.match(mainIndex, /visualEffectState:\s*process\.platform === 'darwin' \? 'active' : undefined/)
})
