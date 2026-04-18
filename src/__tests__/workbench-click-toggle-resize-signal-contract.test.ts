import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('useTogglePanelWithResize dispatches resizing:true before toggle and resizing:false via transitionend + safety timer', () => {
  const source = readWorkspaceFile('src/renderer/modules/workbench/useTogglePanelWithResize.ts')

  assert.match(source, /PANEL_RESIZE_STATE_EVENT/)
  assert.match(source, /dispatchPanelResize\(true\)/)
  assert.match(source, /dispatchPanelResize\(false\)/)
  assert.match(source, /transitionend/)
  assert.match(source, /propertyName !== 'width'/)
  assert.match(source, /setTimeout\(\s*\(\)\s*=>\s*\{/)
})

test('useTogglePanelWithResize short-circuits stale tokens when the user retriggers the toggle mid-flight', () => {
  const source = readWorkspaceFile('src/renderer/modules/workbench/useTogglePanelWithResize.ts')

  assert.match(source, /tokenRef\.current/)
  assert.match(source, /if \(resolvingToken !== tokenRef\.current\) return/)
})

test('WorkbenchMode wires the wrapped handlers so every UI-triggered panel toggle flows through the resize-signal hook', () => {
  const source = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(source, /useTogglePanelWithResize/)
  assert.match(
    source,
    /handleToggleChatPanelWithResize\s*=\s*useTogglePanelWithResize\(\s*"\[data-liquid-shell='chat-panel'\]"/,
  )
  assert.match(
    source,
    /handleToggleSidebarWithResize\s*=\s*useTogglePanelWithResize\(\s*"\[data-liquid-shell='side-panel'\]"/,
  )
  assert.match(source, /onToggleChatPanel=\{handleToggleChatPanelWithResize\}/)
  assert.match(source, /<ChatPanel[^>]*onTogglePanel=\{handleToggleChatPanelWithResize\}/)
  assert.match(source, /handleToggleSidebarWithResize\(\)/)
  assert.match(source, /handleToggleChatPanelWithResize\(\)/)
})

test('ChatPanel prefers the wrapped onTogglePanel prop over the raw useWorkspace toggle so header/collapsed rail keep the resize signal', () => {
  const source = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(source, /onTogglePanel\?:\s*\(\)\s*=>\s*void/)
  assert.match(source, /toggleChatPanel:\s*toggleChatPanelStore/)
  assert.match(source, /const toggleChatPanel = onTogglePanel \?\? toggleChatPanelStore/)
})
