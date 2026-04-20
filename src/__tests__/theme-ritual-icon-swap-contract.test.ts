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
  assert.match(css, /@keyframes theme-ritual-icon-breathe/)
  assert.match(
    css,
    /@keyframes theme-ritual-icon-slide-out-left\s*\{[\s\S]*?to\s*\{[^}]*translate3d\(-36px/,
  )
  assert.match(
    css,
    /@keyframes theme-ritual-icon-slide-in-right\s*\{\s*from\s*\{[^}]*translate3d\(36px/,
  )
})

test('entering shows only the current icon, holding keeps it breathing, and leaving performs the swap', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-dark'\]\[data-phase='entering'\][^\n]*\[data-glyph='sun'\],\s*\n\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-light'\]\[data-phase='entering'\][^\n]*\[data-glyph='moon'\]\s*\{[\s\S]*?opacity:\s*1/,
  )
  assert.match(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-dark'\]\[data-phase='holding'\][^\n]*\[data-glyph='sun'\],\s*\n\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-light'\]\[data-phase='holding'\][^\n]*\[data-glyph='moon'\]\s*\{[\s\S]*?theme-ritual-icon-breathe[\s\S]*?900ms[\s\S]*?alternate/,
  )
  assert.doesNotMatch(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-dark'\]\[data-phase='holding'\][^\n]*\[data-glyph='moon'\]/,
  )
  assert.doesNotMatch(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-light'\]\[data-phase='holding'\][^\n]*\[data-glyph='sun'\]/,
  )
  assert.match(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-dark'\]\[data-phase='leaving'\][^{]*\[data-glyph='sun'\]\s*\{[^}]*theme-ritual-icon-slide-out-left/,
  )
  assert.match(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-light'\]\[data-phase='leaving'\][^{]*\[data-glyph='moon'\]\s*\{[^}]*theme-ritual-icon-slide-out-left/,
  )
  assert.match(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-dark'\]\[data-phase='leaving'\][^\n]*\[data-glyph='moon'\],\s*\n\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-light'\]\[data-phase='leaving'\][^\n]*\[data-glyph='sun'\]\s*\{[\s\S]*?theme-ritual-icon-slide-in-right/,
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

test('holding keeps the incoming icon hidden until leaving starts', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.doesNotMatch(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-dark'\]\[data-phase='holding'\][^\n]*\[data-glyph='moon'\]\s*\{/,
  )
  assert.doesNotMatch(
    css,
    /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\[data-direction='to-light'\]\[data-phase='holding'\][^\n]*\[data-glyph='sun'\]\s*\{/,
  )
})
