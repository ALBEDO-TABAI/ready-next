import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('TopBar gets a 180ms padding-right transition matching the panel width curve, so click-toggle moves the right-side controls in sync with the chat panel', () => {
  const css = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(
    css,
    /\[data-liquid-shell='topbar'\]\s*\{[^}]*transition:\s*padding-right\s+180ms\s+cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/,
  )
})

test('body.resizing suppresses the TopBar padding-right transition so drag frames stay pixel-aligned with the panel width', () => {
  const css = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(
    css,
    /body\.resizing[^{]*\[data-liquid-shell='topbar'\][\s\S]{0,200}transition:\s*none/,
  )
})

test('prefers-reduced-motion shortens the TopBar (and panel) transition duration', () => {
  const css = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\[data-liquid-shell='topbar'\][\s\S]*?transition-duration:\s*80ms/,
  )
})
