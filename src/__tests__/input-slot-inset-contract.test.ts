import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('shared inset slot tokens drive input shells across the workbench', () => {
  const styles = readRendererStyles()
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')
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

  assert.match(filesPanel, /ready-input-shell/)
  assert.match(filesPanel, /ready-input-slot-inner/)
  assert.match(globalSearch, /ready-input-shell/)
  assert.match(globalSearch, /ready-input-slot-inner/)
  assert.match(browserSurface, /ready-input-slot-inner/)
})

test('inactive input slots blend into their panel surface and rely on a faint outline', () => {
  const styles = readRendererStyles()

  assert.match(styles, /--input-slot-bg:\s*var\(--surface-panel-bg\);/)
  assert.match(styles, /--input-slot-shadow:\s*inset 0 0 0 0\.5px/)
  assert.doesNotMatch(styles, /--input-slot-shadow:[\s\S]*inset 0 2px 8px -2px/)
})

test('chat composer delegates its material to the liquid lens instead of the inset slot treatment', () => {
  // 2026-06-10: 输入框升级为真折射液态玻璃（LiquidLens）。外壳只保留拖拽态
  // 描边；背景/模糊/纱层不再走 input-slot 变量，由镜片层统一承担。
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const chatInput = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')

  assert.match(chatPanelBody, /background: 'transparent'/)
  assert.match(chatPanelBody, /border: isDragOver \? '2px solid var\(--color-blue\)' : '1px solid transparent'/)
  assert.match(chatPanelBody, /boxShadow: 'none'/)
  assert.match(chatInput, /<LiquidLens/)
  assert.match(chatInput, /className="ready-liquid-composer__surface"/)
  assert.match(chatInput, /bevel=\{22\}/)
  assert.match(chatInput, /ior=\{1\.34\}/)
  assert.match(chatInput, /dome=\{2\}/)
  assert.match(chatInput, /strength=\{3\.2\}/)
  assert.match(chatInput, /blur=\{3\.5\}/)
  assert.match(chatInput, /frost=\{0\}/)
  assert.match(chatInput, /blurBeforeRefraction/)
  assert.match(chatInput, /contrast=\{0\.84\}/)
  assert.match(chatInput, /aberration=\{0\}/)
  assert.match(chatInput, /opacity: sendUnavailable \? 0\.38 : 1/)
  assert.doesNotMatch(chatInput, /opacity:\s*sendDisabled\s*\?/)
})

test('dark liquid composer dims only the material while preserving semantic controls', () => {
  const styles = readRendererStyles()
  const darkComposerBlock = styles.match(/html\[data-theme='dark'\]:root \.ready-liquid-composer \{([\s\S]*?)\n\}/)
  assert.ok(darkComposerBlock, 'dark liquid composer block should exist')

  assert.match(
    styles,
    /html\[data-theme='dark'\]:root \.ready-liquid-composer \{[\s\S]*--text-body:\s*rgba\(232, 232, 232, 0\.86\);[\s\S]*--text-placeholder:\s*rgba\(176, 176, 176, 0\.62\);/,
  )
  // The dark material comes from the dark --rn-liquid-* tokens (W1 DL4a); the surface only uses them.
  assert.match(
    readWorkspaceFile('src/renderer/styles/liquid-composer.css'),
    /\.ready-liquid-composer__surface \{[\s\S]*?background:\s*linear-gradient\(180deg, var\(--rn-liquid-a\), var\(--rn-liquid-b\)\);/,
  )
  assert.match(
    readWorkspaceFile('src/renderer/design/next/tokens.css'),
    /\[data-theme='dark'\] \{[\s\S]*?--rn-liquid-a:\s*rgb\(255 255 255 \/ \.13\);/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]:root \.ready-liquid-composer__projection \{[\s\S]*saturate\(0\)[\s\S]*brightness\(0\.78\)/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]:root \.ready-liquid-composer \[data-ready-agent-send='true'\] \{[\s\S]*?background:\s*rgba\(255, 255, 255, 0\.96\) !important;/,
  )
  assert.match(
    styles,
    /\.ready-liquid-composer \[data-ready-agent-send='true'\]:disabled \{[\s\S]*?opacity:\s*1;/,
  )
  assert.doesNotMatch(darkComposerBlock[1], /--color-blue:/)
  assert.doesNotMatch(darkComposerBlock[1], /--color-green:/)
  assert.doesNotMatch(darkComposerBlock[1], /--color-red:/)
  assert.doesNotMatch(styles, /ready-liquid-composer[\s\S]*#9ab8ff/)
  assert.doesNotMatch(styles, /ready-liquid-composer[\s\S]*220, 232, 255/)
})
