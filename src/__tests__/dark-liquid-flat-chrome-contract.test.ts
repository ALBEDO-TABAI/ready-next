import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid chrome removes the old top-edge glow from shared panel surfaces', () => {
  const styles = readRendererStyles()
  const panelBlock = styles.match(/html\[data-theme='dark'\]:root \.glass-surface-panel\s*\{([\s\S]*?)\n\}/)
  const cardBlock = styles.match(/html\[data-theme='dark'\]:root \.glass-surface-card\s*\{([\s\S]*?)\n\}/)

  assert.match(styles, /html\[data-theme='dark'\]:root \.glass-surface-panel\s*\{/)
  assert.ok(panelBlock)
  assert.ok(cardBlock)
  assert.doesNotMatch(panelBlock[1], /radial-gradient\(/)
  assert.doesNotMatch(panelBlock[1], /linear-gradient\(180deg,\s*color-mix\(in srgb,\s*var\(--lg-specular-top\)/)
  assert.doesNotMatch(cardBlock[1], /radial-gradient\(/)
})

test('files side panel advertises its variant and stays fused with surrounding dark liquid chrome via shared shell tokens', () => {
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const styles = readRendererStyles()

  assert.match(sidePanel, /data-side-panel-variant=\{panelWidth > 0 \? variant : 'hidden'\}/)
  assert.match(
    styles,
    /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?background:\s*var\(--workbench-side-panel-bg\)/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]:root\s*\{[\s\S]*?--workbench-side-panel-bg:\s*transparent;/,
  )
})

test('the four-mode switch track kills the old top sheen through shared dark liquid slot tokens', () => {
  const themeStyles = readRendererStyles()
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.doesNotMatch(themeStyles, /--lg-surface-elevated\s*:/)
  // 8ab48cd7 style(ui): checkpoint liquid glass polish — ::before 覆层从 rail-slot-overlay token 改为自带双向侧光渐变
  assert.match(
    styles,
    /\.draggable-mode-tabs::before\s*\{[\s\S]*?background:\s*linear-gradient\(90deg, rgba\(255, 255, 255, 0\.14\), transparent 18%, transparent 82%, rgba\(71, 13, 3, 0\.06\)\),\s*linear-gradient\(180deg, rgba\(255, 255, 255, 0\.10\), transparent 42%\)/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]:root\s*\{[\s\S]*?--workbench-rail-slot-overlay:\s*none;/,
  )
  // 079189aa Add browser FastCard context actions — liquid-glass 皮肤块与 fastcard overlay 窗口共用选择器组
  assert.match(
    themeStyles,
    /html:root\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(222,\s*222,\s*220,\s*0\.64\);/,
  )
  // c17b8883 Polish liquid glass workbench controls — 槽位内阴影 0.11 → 0.10
  assert.match(
    themeStyles,
    /html:root\s*\{[\s\S]*?--workbench-rail-slot-border:\s*transparent;[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(24,\s*39,\s*77,\s*0\.10\)/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]:root\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(45,\s*45,\s*43,\s*0\.48\);/,
  )
  assert.match(
    themeStyles,
    /html\[data-theme='dark'\]:root\s*\{[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(0,\s*0,\s*0,\s*0\.36\)/,
  )
  // 2026-10-30 — icon rail 改为贴边图标列：无 track、无槽底（明暗两套均无专属槽块）
  assert.doesNotMatch(styles, /\.icon-rail-slider__track/)
  assert.doesNotMatch(styles, /html:root \.icon-rail-slider\s*\{/)
  // 8ab48cd7 — 四模式槽改 Ready 橙渐变轨道（无 backdrop 模糊）
  assert.match(
    styles,
    /html:root \.draggable-mode-tabs\s*\{[\s\S]*?background:\s*linear-gradient\(180deg, color-mix\(in srgb, var\(--color-ready-orange, #ff4b2b\) 82%, white\) 0%[\s\S]*?backdrop-filter:\s*none;/,
  )
  // 8ab48cd7 — 暗色四模式槽自带深橙渐变材质，无 backdrop；icon rail 2026-10-30 起无暗色槽块
  assert.doesNotMatch(styles, /html\[data-theme='dark'\]:root \.icon-rail-slider\s*\{/)
  assert.match(
    styles,
    /html\[data-theme='dark'\]:root \.draggable-mode-tabs\s*\{[\s\S]*?linear-gradient\(180deg, color-mix\(in srgb, var\(--color-ready-orange, #ff6345\) 72%, #2a0b04\) 0%[\s\S]*?backdrop-filter:\s*none;/,
  )
  // 8ab48cd7 — 暗色四模式 thumb 改暖灰实体渐变 + 亮描边
  assert.match(styles, /html\[data-theme='dark'\]:root \.draggable-mode-tabs__thumb\s*\{\s*background:\s*linear-gradient\(180deg, rgba\(225, 225, 218, 0\.90\) 0%, rgba\(176, 178, 171, 0\.86\) 100%\)[\s\S]*?border-color:\s*rgba\(235, 235, 230, 0\.22\);/)
})
