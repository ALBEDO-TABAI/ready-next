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
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const chatInput = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
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
  assert.match(chatMessages, /padding:\s*shouldFloatIntroBlock \? '20px 16px clamp\(76px, 16vh, 132px\)' : 16/)
  assert.match(chatPanel, /padding:\s*'10px 0 0'/)
  assert.match(iconRail, /width:\s*WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(iconRail, /minWidth:\s*WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(topBar, /title="收起\/展开聊天面板"/)
  assert.match(chatPanel, /width:\s*shellWidth,/)
  assert.match(chatPanel, /minWidth:\s*shellWidth,/)
  assert.match(workbenchMode, /const chatShellWidth = chatPanelVisible \? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE/)
  assert.match(workbenchMode, /<ChatPanel shellWidth=\{chatShellWidth\} panelState=\{chatPanelState\} \/>/)
  assert.match(chatPanel, /<CollapsedChatRail/)
  assert.match(chatPanel, /WORKBENCH_TOPBAR_PADDING_RIGHT/)
  assert.match(chatPanel, /alignItems:\s*'flex-end'/)
  assert.match(chatPanel, /paddingRight:\s*WORKBENCH_TOPBAR_PADDING_RIGHT/)
  assert.match(chatInput, /padding:\s*'10px 16px 0'/)
  assert.doesNotMatch(topBar, /className="glass-surface-card".*切换到浅色模式/s)
  assert.doesNotMatch(topBar, /className="glass-surface-card".*收起\/展开聊天面板/s)

  assert.doesNotMatch(iconRail, /glass-surface-card w-\[34px\] h-\[34px\]/)
  assert.match(iconRail, /hover:bg-\[var\(--bg-hover\)\]/)
  assert.match(modeSlider, /readyWordmark/)
  assert.match(modeSlider, /<img[\s\S]*src=\{readyWordmark\}/)
})
