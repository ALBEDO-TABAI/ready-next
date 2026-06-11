import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('topbar and rail icon controls use direct-on-surface styling without extra capsules', () => {
  const chrome = readWorkspaceFile('src/renderer/modules/workbench/chrome.ts')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const statusBar = readWorkspaceFile('src/renderer/components/layout/StatusBar.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  // Stage V V1.3 — `CollapsedChatRail` extracted from ChatPanel.tsx to
  // `chat-panel/layout/MotionLayer.tsx` (along with the rail's
  // `WORKBENCH_TOPBAR_PADDING_RIGHT` + `alignItems: 'flex-end'` edge
  // alignment). ChatPanel still owns the shell width contract and the
  // `<CollapsedChatRail ... />` usage site.
  const motionLayer = readWorkspaceFile('src/renderer/components/agent/chat-panel/layout/MotionLayer.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const modeSlider = readWorkspaceFile('src/renderer/components/layout/ModeSlider.tsx')

  assert.match(chrome, /WORKBENCH_EDGE_RAIL_SIZE = 44/)
  assert.match(chrome, /WORKBENCH_TOPBAR_HEIGHT = WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(chrome, /WORKBENCH_STATUSBAR_HEIGHT = WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(chrome, /WORKBENCH_EDGE_ICON_INSET = 14\.5/)
  assert.match(chrome, /WORKBENCH_TOPBAR_PADDING_LEFT = 60/)
  assert.match(chrome, /WORKBENCH_TOPBAR_PADDING_RIGHT = 14/)

  assert.match(topBar, /ModeSlider/)
  assert.match(topBar, /WORKBENCH_TOPBAR_HEIGHT/)
  assert.match(statusBar, /WORKBENCH_STATUSBAR_HEIGHT/)
  assert.match(statusBar, /WORKBENCH_EDGE_ICON_INSET/)
  assert.match(statusBar, /paddingLeft:\s*WORKBENCH_EDGE_ICON_INSET/)
  assert.match(statusBar, /paddingRight:\s*WORKBENCH_EDGE_ICON_INSET/)
  assert.match(statusBar, /data-liquid-shell="statusbar"/)
  assert.match(statusBar, /borderTop: '1px solid transparent'/)
  assert.match(statusBar, /Ready v0\.1\.0/)
  assert.match(statusBar, /toLocaleTimeString/)
  assert.match(statusBar, /justify-between/)
  assert.doesNotMatch(statusBar, /Kimi API 已连接|浏览器预览模式|main/)
  assert.match(iconRail, /width:\s*WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(iconRail, /minWidth:\s*WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(iconRail, /py-\[10px\]/)
  assert.match(topBar, /title="收起\/展开聊天面板"/)
  assert.match(chatPanel, /width:\s*shellWidth,/)
  assert.match(chatPanel, /minWidth:\s*shellWidth,/)
  assert.match(workbenchMode, /const chatShellWidth = chatPanelVisible \? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(workbenchMode, /<ChatPanel[\s\S]*shellWidth=\{chatShellWidth\}[\s\S]*panelState=\{chatPanelState\}/)
  assert.match(workbenchMode, /<StatusBar \/>/)
  assert.doesNotMatch(topBar, /DraggableModeTabs/)
  assert.match(chatPanel, /ready-chat-mode-tabs-dock/)
  assert.match(chatPanel, /<CollapsedChatRail/)
  assert.match(motionLayer, /WORKBENCH_TOPBAR_PADDING_RIGHT/)
  assert.match(motionLayer, /alignItems:\s*'flex-end'/)
  assert.match(motionLayer, /paddingRight:\s*WORKBENCH_TOPBAR_PADDING_RIGHT/)
  assert.doesNotMatch(topBar, /className="glass-surface-card".*切换到浅色模式/s)
  assert.doesNotMatch(topBar, /className="glass-surface-card".*收起\/展开聊天面板/s)

  assert.doesNotMatch(iconRail, /glass-surface-card w-\[34px\] h-\[34px\]/)
  assert.match(iconRail, /hover:bg-\[var\(--bg-hover\)\]/)
  assert.match(modeSlider, /readyWordmark/)
  assert.match(modeSlider, /<img[\s\S]*src=\{readyWordmark\}/)
})
