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

  assert.doesNotMatch(themeStyles, /--lg-surface-elevated\s*:/)
  assert.match(
    styles,
    /\.draggable-mode-tabs::before\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-overlay\)/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-overlay:\s*none;/,
  )
  assert.match(
    themeStyles,
    /html\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(222,\s*222,\s*220,\s*0\.64\);/,
  )
  assert.match(
    themeStyles,
    /html\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-border:\s*transparent;[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(24,\s*39,\s*77,\s*0\.10\)/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(45,\s*45,\s*43,\s*0\.48\);/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(0,\s*0,\s*0,\s*0\.36\)/,
  )
  assert.match(
    styles,
    /\.icon-rail-slider__track\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-overlay\)/,
  )
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\] \.icon-rail-slider\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--workbench-rail-slot-bg\) 86%, rgba\(255, 255, 255, 0\.34\)\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--lg-blur-soft\) \* 0\.18\)\) saturate\(calc\(var\(--surface-saturate\) - 18%\)\);/,
  )
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\] \.draggable-mode-tabs\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--workbench-rail-slot-bg\) 86%, rgba\(255, 255, 255, 0\.34\)\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--lg-blur-soft\) \* 0\.18\)\) saturate\(calc\(var\(--surface-saturate\) - 18%\)\);/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.icon-rail-slider,[\s\S]*?html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.draggable-mode-tabs\s*\{[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*var\(--workbench-rail-slot-bg\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--lg-blur-soft\) \* 0\.18\)\) saturate\(100%\);/,
  )
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.icon-rail-slider__thumb,[\s\S]*?rgba\(235, 235, 230, 0\.16\)/)
  assert.doesNotMatch(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.icon-rail-slider__thumb,[\s\S]*?rgba\(232, 240, 255/)
})
