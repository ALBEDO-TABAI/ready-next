import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench side/chat shells interpolate width via CSS transition', () => {
  const indexCss = readWorkspaceFile('src/renderer/styles/index.css')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  // CSS: transition rule present for both shell data attributes.
  const transitionBlockMatch = indexCss.match(
    /\[data-liquid-shell='side-panel'\][\s\S]{0,120}\[data-liquid-shell='chat-panel'\]\s*\{[\s\S]*?transition:[\s\S]*?width\s+180ms[\s\S]*?min-width\s+180ms[\s\S]*?\}/,
  )
  assert.ok(transitionBlockMatch, 'CSS transition rule for side/chat shells must declare width + min-width 180ms')

  // CSS: resizing override + reduced motion override.
  assert.match(indexCss, /body\.resizing \[data-liquid-shell='side-panel'\][\s\S]*?transition:\s*none/)
  assert.match(
    indexCss,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\[data-liquid-shell='side-panel'\][\s\S]*?transition-duration:\s*80ms/,
  )

  // WorkbenchMode: widths are derived from visibility flags directly (no deferred shell timer).
  assert.match(workbenchMode, /const sidebarShellWidth = sidebarVisible \? sidePanelWidths\.shared : 0/)
  assert.match(workbenchMode, /const chatShellWidth = chatPanelVisible \? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE/)
  assert.doesNotMatch(workbenchMode, /shouldRenderSidebarShell/)
  assert.doesNotMatch(workbenchMode, /sidebarShellTimerRef/)
  assert.doesNotMatch(workbenchMode, /chatPanelStateTimerRef/)

  // Panels: data-liquid-shell is present so CSS transition targets them.
  assert.match(sidePanel, /data-liquid-shell="side-panel"/)
  assert.match(chatPanel, /data-liquid-shell="chat-panel"/)
})
