import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  // allow-source-grep: shared chrome CSS and component style declarations must keep the same transparent surface contract across owners.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('liquid glass chrome removes prominent shell edges so panels read as one fused surface', () => {
  const iconRail = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellRail.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const skillsPanel = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')
  const statusBar = readWorkspaceFile('src/renderer/components/layout/StatusBar.tsx')
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const activeTabSurface = readWorkspaceFile('src/renderer/components/browser/ActiveTabSurface.tsx')
  const tabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const styles = readRendererStyles()

  assert.doesNotMatch(iconRail, /border-r border-\[var\(--border-default\)\]/)
  assert.doesNotMatch(iconRail, /glass-surface-panel/)
  assert.doesNotMatch(sidePanel, /className="content-surface-panel flex-shrink-0 flex flex-col select-none overflow-hidden"/)
  assert.match(sidePanel, /className=\{`shell-sidebar workbench-panel-frame/)
  const shellStyles = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')
  assert.match(shellStyles, /\.shell-sidebar:not\(\.shell-float-drawer\)\s*\{\s*background:\s*transparent;\s*box-shadow:\s*none;/)
  assert.doesNotMatch(skillsPanel, /selected \? PANEL_COLORS\.blue : PANEL_COLORS\.border/)
  assert.doesNotMatch(skillsPanel, /importDropActive \? PANEL_COLORS\.blue : PANEL_COLORS\.dropBorder/)
  assert.match(skillsPanel, /background: selected \? 'var\(--rn-fill-2\)' : 'transparent'/)
  assert.match(skillsPanel, /border: '1px solid transparent'/)
  assert.doesNotMatch(statusBar, /glass-surface-panel/)
  assert.match(statusBar, /background:\s*'transparent'/)
  // V11: the browser's header is the head row of its one panel, with no rule under it (the framed page is the edge).
  assert.match(browserHeader, /className="rn-panel__head browser-head no-drag"/)
  assert.match(readWorkspaceFile('src/renderer/components/browser/browser-shell.css'), /\.browser-panel > \.browser-head \{\s*box-shadow: none;\s*\}/)
  assert.match(activeTabSurface, /background: mode === 'primed' \|\| mode === 'expanded' \|\| mode === 'editing'/)
  // Editing, the active tab is drawn as the shared field: the well (V2) with an ink edge.
  assert.match(activeTabSurface, /\? 'var\(--rn-well\)'/)
  assert.match(activeTabSurface, /boxShadow: mode === 'primed' \|\| mode === 'expanded' \|\| mode === 'editing'/)
  assert.match(activeTabSurface, /\? 'inset 0 1px 2px var\(--rn-well-shade\), inset 0 0 0 1px var\(--rn-ink-3\)'/)
  assert.doesNotMatch(tabRail, /background:\s*'var\(--bg-primary\)'/)
  assert.doesNotMatch(chatPanel, /className="content-surface-panel flex-shrink-0 flex flex-col overflow-hidden"/)
  // B13: the drop ring is ink (--rn-ink-3), like the project pill's; blue was the retired accent (W1 DL5).
  assert.match(chatPanelBody, /border: isDragOver \? '2px solid var\(--rn-ink-3\)' : '1px solid transparent'/)
  assert.doesNotMatch(chatPanel, /className="glass-surface-panel flex items-center justify-between"/)
  assert.doesNotMatch(chatPanel, /className="glass-surface-panel"/)
  assert.doesNotMatch(chatPanel, /className="glass-surface-card flex items-center justify-between"/)
  assert.match(chatPanel, /background: 'transparent'/)
  assert.doesNotMatch(chatPanel, /0 8px 24px rgba\(15, 23, 42, 0\.08\)/)
  assert.doesNotMatch(calendarMode, /borderRight: '1px solid rgba\(255,255,255,0\.03\)'/)
  assert.doesNotMatch(calendarMode, /boxShadow: '0 4px 14px rgba\(15, 23, 42, 0\.03\)'/)
  assert.doesNotMatch(topBar, /glass-surface-panel/)
  assert.match(topBar, /background:\s*'transparent'/)

  // B13 (W1 DL1): the frames and legacy panel surfaces have no edge, shadow or highlight of their own.
  assert.match(styles, /\.workbench-canvas-shell \{[^}]*border: 0;[^}]*box-shadow: none;/)
  assert.match(styles, /\[style\*="border-right"\],/)
  assert.match(styles, /border-right-color:\s*transparent !important;/)
  assert.match(styles, /\n\.glass-surface-panel \{[^}]*box-shadow: none;/)
  assert.match(styles, /\n\.glass-surface-card \{[^}]*box-shadow: none !important;/)
  assert.doesNotMatch(styles, /\.glass-surface-panel::before/)
  assert.match(styles, /\.resize-handle::before\s*\{/)
})
