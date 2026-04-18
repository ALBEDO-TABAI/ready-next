import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid chrome removes the old top-edge glow from shared panel surfaces', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const panelBlock = styles.match(/html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.glass-surface-panel\s*\{([\s\S]*?)\n\}/)
  const cardBlock = styles.match(/html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.glass-surface-card\s*\{([\s\S]*?)\n\}/)

  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.glass-surface-panel\s*\{/)
  assert.ok(panelBlock)
  assert.ok(cardBlock)
  assert.doesNotMatch(panelBlock[1], /radial-gradient\(/)
  assert.doesNotMatch(panelBlock[1], /linear-gradient\(180deg,\s*color-mix\(in srgb,\s*var\(--lg-specular-top\)/)
  assert.doesNotMatch(cardBlock[1], /radial-gradient\(/)
})

test('files side panel advertises its variant and stays fused with surrounding dark liquid chrome via shared shell tokens', () => {
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(sidePanel, /data-side-panel-variant=\{panelWidth > 0 \? variant : 'hidden'\}/)
  assert.match(
    styles,
    /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?background:\s*var\(--workbench-side-panel-bg\)/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-side-panel-bg:\s*transparent;/,
  )
})

test('the four-mode switch track kills the old top sheen through shared dark liquid slot tokens', () => {
  const themeStyles = readWorkspaceFile('src/renderer/styles/index.css')
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(
    styles,
    /\.draggable-mode-tabs::before\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-overlay\)/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-overlay:\s*none;/,
  )
  assert.match(
    styles,
    /\.icon-rail-slider__track\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-overlay\)/,
  )
})
