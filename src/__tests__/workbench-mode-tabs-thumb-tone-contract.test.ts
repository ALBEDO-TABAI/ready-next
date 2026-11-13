import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} should exist`)
  return css.slice(start, css.indexOf('\n}', start))
}

// V21: the composer, the project chip and the mode switch slot are one liquid glass with a low contact shadow. The
// slot's thumb is a clear lens lying on top of the icons, flush with the pill, told by light alone; the current mode's
// glyph follows the rail's rule: white with a soft white glow, in its filled twin. No accent on the slot.
test('the mode switch slot is the composer liquid glass with a flush clear lens over a white glyph', () => {
  const composer = readFileSync(resolve(process.cwd(), 'src/renderer/styles/liquid-composer.css'), 'utf8')
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/mode-switch.css'), 'utf8')
  const slot = css.slice(css.indexOf('.ready-chat-mode-tabs-dock {'))

  // One material: the chip's and the slot's surfaces share the composer's veil, rim, ring and projection rules.
  const shared = (part: string, declaration: string) => new RegExp(
    `\\.ready-chat-project-${part},\\s*\\.draggable-mode-tabs__${part},\\s*\\.ready-liquid-composer__${part} \\{[^}]*${declaration}`)
  assert.match(composer, shared('surface', 'background:\\s*var\\(--rn-liquid-veil\\);'))
  assert.match(composer, shared('surface', 'box-shadow:\\s*var\\(--rn-liquid-veil-edge\\), var\\(--rn-liquid-shadow\\);'))
  assert.match(composer, shared('surface::before', 'border:\\s*0\\.5px solid var\\(--rn-liquid-rim\\);'))
  assert.match(composer, shared('surface::after', 'background:\\s*var\\(--rn-liquid-ring\\);'))
  assert.match(composer, shared('projection', 'filter:\\s*blur\\(4\\.5px\\)'))

  // The thumb: clear glass with its own bright rim and sheen, nothing else painted; it lies above the icons (so the
  // lens bends them), flush with the pill and clipped to its own outline, and never grows.
  const thumb = cssBlock(css, '.draggable-mode-tabs__thumb')
  assert.doesNotMatch(thumb, /background|box-shadow|filter|scale/)
  assert.doesNotMatch(css, /thumb-glow|--rn-rail-tile|--rn-accent|--rn-liquid-glyph-glow|--dmt-lens-reach|--dmt-pad|data-travelling/)
  assert.match(thumb, /border-radius:\s*var\(--rn-r-pill\);/)
  assert.match(thumb, /top:\s*0;[\s\S]*left:\s*0;/)
  assert.match(thumb, /height:\s*100%;/)
  assert.match(thumb, /overflow:\s*hidden;/)
  // Its glass is told by light alone: the lens's own rim and sheen tokens (V26), no tint of its own.
  assert.match(cssBlock(css, '.draggable-mode-tabs__thumb::before'), /background:\s*var\(--rn-liquid-lens-sheen\);[\s\S]*box-shadow:\s*var\(--rn-liquid-lens-rim\);/)
  // The smoke the white glyph reads against lies on the track under the glyphs (z 1 < icons 2 < lens 3), not in the lens.
  assert.match(cssBlock(css, '.draggable-mode-tabs::after'), /z-index:\s*1;[\s\S]*background:\s*var\(--rn-liquid-lens-smoke\);/)

  // Icons: how lit an icon is comes from the lens alone (its proximity), never from the active class, so nothing waits
  // for the mode to commit. The button itself is in the resting ink (hint ink, ink on hover); the lens sits above.
  const icon = cssBlock(css, '.draggable-mode-tabs__icon')
  assert.match(icon, /--dmt-icon-lit-amount:\s*clamp\(0, calc\(\(var\(--dmt-icon-proximity\) - 0\.5\) \* 2\), 1\);/)
  assert.match(icon, /--dmt-icon-lit:\s*var\(--rn-rail-glyph\);/)
  assert.match(icon, /color:\s*var\(--dmt-icon-rest\);/)
  assert.doesNotMatch(icon, /color-mix|transition:[^;]*color/)
  assert.match(icon, /--dmt-icon-rest:\s*var\(--rn-ink-3\);/)
  assert.match(css, /\.draggable-mode-tabs:not\(\[data-dragging='true'\]\) \.draggable-mode-tabs__icon:hover \{\s*--dmt-icon-rest:\s*var\(--rn-ink\);/)
  assert.match(icon, /z-index:\s*2;/)
  assert.match(thumb, /z-index:\s*3;/)

  // Two twins crossfaded by that amount: the resting outline fades out as the lit glyph (white, glowing, growing in)
  // fades in. No class decides the look and no transition trails the lens.
  assert.match(cssBlock(css, '.draggable-mode-tabs__glyph.is-rest'), /opacity:\s*calc\(1 - var\(--dmt-icon-lit-amount\)\);/)
  const lit = cssBlock(css, '.draggable-mode-tabs__glyph.is-lit')
  assert.match(lit, /color:\s*var\(--dmt-icon-lit\);/)
  assert.match(lit, /filter:\s*var\(--rn-liquid-glyph-lit\);/)
  assert.match(lit, /opacity:\s*var\(--dmt-icon-lit-amount\);/)
  assert.match(lit, /transform:\s*scale\(calc\(0\.84 \+ 0\.16 \* var\(--dmt-icon-lit-amount\)\)\);/)
  assert.doesNotMatch(css, /is-active|is-split-active|data-active-glyph|is-filled|is-outline/)
  assert.doesNotMatch(cssBlock(css, '.draggable-mode-tabs__glyph'), /transition/)
  assert.doesNotMatch(lit, /transition/)
  const tokens = readFileSync(resolve(process.cwd(), 'src/renderer/design/next/tokens.css'), 'utf8')
  // The lit glyph's light is white with a hair of ink at its edge: no orange.
  const litTokens = [...tokens.matchAll(/--rn-liquid-glyph-lit:[^;]*;/g)].map(match => match[0])
  assert.equal(litTokens.length, 2)
  for (const lit of litTokens) assert.doesNotMatch(lit, /255,\s*90,\s*31|rn-accent/)
  // Under the lens: a soft dimming of the middle only, fading to nothing at the edge (never a flat tint, never absent).
  const smokeTokens = [...tokens.matchAll(/--rn-liquid-lens-smoke:[^;]*;/g)].map(match => match[0])
  assert.equal(smokeTokens.length, 2)
  for (const smoke of smokeTokens) assert.match(smoke, /radial-gradient\([^;]*,\s*rgba\(\d+, \d+, \d+, 0\) 100%\);/)

  // 减少透明 turns the lens off: the current cell takes the selected fill, its glyph in ink and without the glow.
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__icon \{\s*--dmt-icon-lit:\s*var\(--rn-ink\);/)
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__glyph\.is-lit \{\s*filter:\s*none;/)
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__thumb,\s*\[data-transparency='reduced'\] \.draggable-mode-tabs::after \{\s*display:\s*none;/)
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__icon\[aria-selected='true'\] \{\s*background:\s*var\(--rn-fill-2\);/)

  // Tokens only: no colour literal, no legacy token and no blur declared by the slot (the lenses carry the optics).
  assert.doesNotMatch(slot, /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i)
  assert.doesNotMatch(slot, /--(?:workbench|color|lg|surface|text|bg|border)-/)
  assert.doesNotMatch(slot, /backdrop-filter/)
})
