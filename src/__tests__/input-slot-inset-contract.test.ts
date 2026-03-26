import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('shared inset slot tokens drive input shells across the workbench', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const globalSearch = readWorkspaceFile('src/renderer/components/layout/GlobalSearchPanel.tsx')
  const browserSurface = readWorkspaceFile('src/renderer/components/browser/ActiveTabSurface.tsx')

  assert.match(styles, /--input-slot-bg:/)
  assert.match(styles, /--input-slot-shadow:/)
  assert.match(styles, /--input-slot-shadow-focus:/)
  assert.match(styles, /\.ready-input-shell\s*\{/)
  assert.match(styles, /\.ready-input-shell:focus-within\s*\{/)
  assert.match(styles, /\.ready-input-slot-control\s*\{/)
  assert.match(styles, /\.ready-input-slot-inner\s*\{/)
  assert.match(styles, /\.morph-segmented-track\s*\{/)
  assert.match(styles, /box-shadow:\s*var\(--input-slot-shadow\)/)

  assert.match(sidePanel, /ready-input-shell/)
  assert.match(sidePanel, /ready-input-slot-inner/)
  assert.match(globalSearch, /ready-input-shell/)
  assert.match(globalSearch, /ready-input-slot-inner/)
  assert.match(browserSurface, /ready-input-shell/)
  assert.match(browserSurface, /ready-input-slot-inner/)
})

test('inactive input slots blend into their panel surface and rely on a faint outline', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(styles, /--input-slot-bg:\s*var\(--surface-panel-bg\);/)
  assert.match(styles, /--input-slot-shadow:\s*inset 0 0 0 0\.5px/)
  assert.doesNotMatch(styles, /--input-slot-shadow:[\s\S]*inset 0 2px 8px -2px/)
})

test('chat composer uses the shared inset slot treatment instead of the old raised glass treatment', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(chatPanel, /background: 'var\(--input-slot-bg\)'/)
  assert.match(chatPanel, /border: isDragOver \? '2px solid var\(--color-blue\)' : '1px solid var\(--input-slot-border\)'/)
  assert.match(chatPanel, /boxShadow: isDragOver[\s\S]*var\(--input-slot-shadow-focus\)[\s\S]*: 'var\(--input-slot-shadow\)'/)
})
