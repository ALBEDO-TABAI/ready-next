import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('LiquidLens primitive exists with DOM-only displacement contract', () => {
  const componentPath = resolve(process.cwd(), 'src/renderer/components/ui/LiquidLens.tsx')
  assert.ok(existsSync(componentPath), 'expected LiquidLens.tsx to exist')

  const source = readWorkspaceFile('src/renderer/components/ui/LiquidLens.tsx')
  assert.match(source, /variant:\s*'pill'\s*\|\s*'field'\s*\|\s*'tray'/)
  assert.match(source, /radius:\s*number/)
  assert.match(source, /intensity\?:\s*number/)
  assert.match(source, /elasticity\?:\s*number/)
  assert.match(source, /followPointer\?:\s*boolean/)
  assert.match(source, /interactive\?:\s*boolean/)
  assert.match(source, /feDisplacementMap/)
  assert.match(source, /backdropFilter|WebkitBackdropFilter/)
  assert.match(source, /BrowserView|DOM-only|DOM chrome/i)
})

test('LiquidLens uses edge-masked multi-channel displacement instead of a single static highlight', () => {
  const source = readWorkspaceFile('src/renderer/components/ui/LiquidLens.tsx')

  assert.match(source, /EDGE_MASK|edge-mask/i)
  assert.match(source, /feColorMatrix/)
  assert.match(source, /feBlend/)
  assert.match(source, /RED_DISPLACED|GREEN_DISPLACED|BLUE_DISPLACED/)
})

test('LiquidLens is wired into the three POC surfaces', () => {
  const tabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(tabs, /LiquidLens/)
  assert.match(tabs, /variant="pill"/)

  assert.match(sidePanel, /LiquidLens/)
  assert.match(sidePanel, /variant="field"/)

  assert.match(chatPanel, /LiquidLens/)
  assert.match(chatPanel, /variant="tray"/)
  assert.match(chatPanel, /variant="pill"/)
})
