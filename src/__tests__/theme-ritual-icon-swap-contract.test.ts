import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('theme ritual icons swap with horizontal slide, not same-position stacking', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(css, /@keyframes theme-ritual-icon-slide-out-left/)
  assert.match(css, /@keyframes theme-ritual-icon-slide-in-right/)
  assert.match(
    css,
    /@keyframes theme-ritual-icon-slide-out-left\s*\{[\s\S]*?to\s*\{[^}]*translate3d\(-36px/,
  )
  assert.match(
    css,
    /@keyframes theme-ritual-icon-slide-in-right\s*\{\s*from\s*\{[^}]*translate3d\(36px/,
  )
})

test('outgoing icon finishes before incoming icon arrives (staggered delay ≥ 180ms)', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  // to-dark: sun slides out (no delay), moon slides in with delay ≥ 180ms
  assert.match(
    css,
    /\[data-direction='to-dark'\]\[data-phase='holding'\][^{]*\[data-glyph='moon'\]\s*\{[^}]*theme-ritual-icon-slide-in-right[^}]*180ms[^}]*forwards/,
  )
  // to-light: moon slides out (no delay), sun slides in with delay ≥ 180ms
  assert.match(
    css,
    /\[data-direction='to-light'\]\[data-phase='holding'\][^{]*\[data-glyph='sun'\]\s*\{[^}]*theme-ritual-icon-slide-in-right[^}]*180ms[^}]*forwards/,
  )
})

test('theme ritual icons are hidden by default (opacity 0 baseline)', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(
    css,
    /\.ritual-theme-choreography \[data-glyph='sun'\],\s*\.ritual-theme-choreography \[data-glyph='moon'\]\s*\{[^}]*opacity:\s*0/,
  )
  // Old translateY-only approach must be gone
  assert.doesNotMatch(css, /\[data-glyph='sun'\][^}]*transform:\s*translateY\(-12px\)/)
  assert.doesNotMatch(css, /\[data-glyph='moon'\][^}]*transform:\s*translateY\(12px\)/)
})

test('leaving phase shows only the incoming icon at rest (no old-icon re-entry)', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(
    css,
    /\[data-direction='to-dark'\]\[data-phase='leaving'\][^{]*\[data-glyph='moon'\][\s\S]*?\[data-direction='to-light'\]\[data-phase='leaving'\][^{]*\[data-glyph='sun'\]/,
  )
})
