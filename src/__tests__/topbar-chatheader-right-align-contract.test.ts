import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('TopBar right padding collapses to the shared 14px constant so it shares the viewport edge with ChatHeader and CollapsedChatRail', () => {
  const topbar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(topbar, /paddingRight:\s*WORKBENCH_TOPBAR_PADDING_RIGHT,/)
  assert.doesNotMatch(topbar, /--workbench-right-gutter/)
  assert.doesNotMatch(workbench, /--workbench-right-gutter/)
  assert.match(chatHeader, /padding:\s*'0 14px'/)
  assert.match(chatPanel, /paddingRight:\s*WORKBENCH_TOPBAR_PADDING_RIGHT/)
})

test('TopBar no longer participates in the panel-width transition tree, leaving only side-panel + chat-panel in the resizing + reduced-motion selectors', () => {
  const css = readWorkspaceFile('src/renderer/styles/index.css')

  assert.doesNotMatch(
    css,
    /\[data-liquid-shell='topbar'\]\s*\{[^}]*transition:\s*padding-right/,
  )
  assert.doesNotMatch(
    css,
    /body\.resizing[^{]*\[data-liquid-shell='topbar'\]/,
  )
  assert.doesNotMatch(
    css,
    /prefers-reduced-motion[\s\S]*?\[data-liquid-shell='topbar'\]/,
  )
})
