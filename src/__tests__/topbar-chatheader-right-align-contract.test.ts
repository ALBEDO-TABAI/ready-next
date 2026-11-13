import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('TopBar right padding is the shared 14px constant; the assistant\'s corner button keeps one place at the right edge', () => {
  const topbar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')
  const shell = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')

  assert.match(topbar, /paddingRight:\s*WORKBENCH_TOPBAR_PADDING_RIGHT,/)
  assert.doesNotMatch(topbar, /--workbench-right-gutter/)
  assert.doesNotMatch(workbench, /--workbench-right-gutter/)
  // The header row keeps its 14px start; its right end belongs to the buttons in the shell's corner (V17).
  assert.match(chatHeader, /paddingLeft:\s*14,/)
  assert.match(chatHeader, /createPortal\(tools, toolsSlot\)/)
  // The collapse / expand button is centred in the right strip, on the head line, whatever the assistant's state.
  assert.match(shell, /\.shell-assistant-tools \.shell-assistant-corner \{[^}]*top: calc\(var\(--rn-frame-gap\) \+ \(var\(--rn-panel-head-h\) - var\(--rn-control-h-lg\)\) \/ 2\);[^}]*right: calc\(\(var\(--rn-rail-w\) - var\(--rn-control-h-lg\)\) \/ 2\);/)
  assert.match(shell, /\.shell-assistant-tools \{[^}]*position: absolute;[^}]*top: 0;[^}]*right: 0;/)
})

test('TopBar no longer participates in the panel-width transition tree, leaving only side-panel + chat-panel in the resizing + reduced-motion selectors', () => {
  const css = readRendererStyles()

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
