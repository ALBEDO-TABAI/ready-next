import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function workspacePath(path: string): string {
  return resolve(process.cwd(), path)
}

function readWorkspaceFile(path: string): string {
  return readFileSync(workspacePath(path), 'utf8')
}

test('dead liquid-glass ui artifacts are removed and active token sources declare their ownership', () => {
  assert.equal(existsSync(workspacePath('src/renderer/components/motion/GooeySegmentedControl.tsx')), false)
  assert.equal(existsSync(workspacePath('src/renderer/components/browser/BrowserAddressBar.tsx')), false)
  assert.equal(existsSync(workspacePath('src/renderer/components/browser/BrowserTabBar.tsx')), false)
  assert.equal(existsSync(workspacePath('src/renderer/styles/layout-constants.ts')), false)
  assert.equal(existsSync(workspacePath('src/renderer/styles/panel-styles.ts')), false)
  assert.equal(existsSync(workspacePath('src/renderer/styles/button-styles.ts')), false)
  assert.equal(existsSync(workspacePath('src/renderer/components/.DS_Store')), false)

  const chrome = readWorkspaceFile('src/renderer/modules/workbench/chrome.ts')
  const panelTokens = readWorkspaceFile('src/renderer/components/layout/panelTokens.ts')
  const cssTokens = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(chrome, /Geometry source of truth for workbench chrome/)
  assert.match(panelTokens, /FILES_PANEL_DIMENSIONS/)
  assert.match(cssTokens, /Visual token source of truth for renderer UI/)
})
