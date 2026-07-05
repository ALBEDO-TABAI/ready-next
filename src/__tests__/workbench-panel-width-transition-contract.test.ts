import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench side/chat shells interpolate width via CSS transition', () => {
  const indexCss = readRendererStyles()
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

test('workbench panel drag updates live shell width and commits store width only after drag ends', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(workbenchMode, /const liveSidebarWidthRef = useRef\(sidePanelWidths\.shared\)/)
  assert.match(workbenchMode, /const liveChatPanelWidthRef = useRef\(chatPanelWidth\)/)
  assert.match(workbenchMode, /setShellWidth\("\[data-liquid-shell='side-panel'\]", nextWidth\)/)
  assert.match(workbenchMode, /setShellWidth\("\[data-liquid-shell='chat-panel'\]", nextWidth\)/)
  assert.match(workbenchMode, /onResizeStateChange=\{handleSidebarResizeStateChange\}/)
  assert.match(workbenchMode, /onResizeStateChange=\{handleChatResizeStateChange\}/)
  assert.match(workbenchMode, /setSidePanelWidth\(sidePanelVariant as SidePanelWidthKey, nextWidth\)/)
  assert.match(workbenchMode, /useWorkspace\.setState\(\{ chatPanelWidth: nextWidth \}\)/)
  assert.doesNotMatch(workbenchMode, /setSidePanelWidth\(sidePanelVariant as 'files' \| 'search' \| 'skills' \| 'backlinks' \| 'graph', current \+ delta\)/)
  assert.doesNotMatch(workbenchMode, /chatPanelWidth:\s*Math\.max\(280,\s*Math\.min\(600,\s*state\.chatPanelWidth \+ delta\)\)/)
})

test('document split disables side chat width tweening without changing browser-only behavior', () => {
  const indexCss = readRendererStyles()
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(workbenchMode, /const documentSplitTabId = useDocTabs\(s => s\.splitTabId\)/)
  assert.match(workbenchMode, /const hasDocumentSplitPane = Boolean\(documentSplitTabId\) && \(workbenchMode === 'document' \|\| splitMode === 'document'\)/)
  assert.match(workbenchMode, /const panelWidthTransitionMode = hasDocumentSplitPane \? 'instant' : 'animated'/)
  assert.match(workbenchMode, /data-panel-width-transition=\{panelWidthTransitionMode\}/)
  assert.match(indexCss, /\[data-panel-width-transition='instant'\] \[data-liquid-shell='side-panel'\],[\s\S]*\[data-panel-width-transition='instant'\] \[data-liquid-shell='chat-panel'\]\s*\{[\s\S]*transition:\s*none;/)
  assert.match(workbenchMode, /const panelToggleSettleMs = hasDocumentSplitPane \? INSTANT_PANEL_TOGGLE_SETTLE_MS : undefined/)
})

test('workbench panel resize freezes visible document layout without changing browser resize events', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(workbenchMode, /import \{ PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail \} from '..\/modules\/browser\/resize-events'/)
  assert.match(workbenchMode, /import \{ freezeVisibleDocumentLayoutWidths \} from '..\/modules\/document\/documentLayoutFreeze'/)
  assert.match(workbenchMode, /const hasVisibleDocumentMode = workbenchMode === 'document' \|\| splitMode === 'document'/)
  assert.match(workbenchMode, /window\.addEventListener\(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener\)/)
  assert.match(workbenchMode, /freezeVisibleDocumentLayoutWidths\(\)/)
  assert.match(workbenchMode, /dispatchPanelResizeEvent:\s*true/)
})
