import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} should exist`)
  return css.slice(start, css.indexOf('\n}', start))
}

// V21: the composer, the project chip and the mode switch slot are one liquid glass with a low contact shadow. V32: the
// slot has no thumb and nothing under an icon; the current mode's glyph follows the rail's rule: white with a soft
// glow, in its filled twin. No accent on the slot.
test('the mode switch slot is the composer liquid glass with a lit white glyph and no thumb', () => {
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

  // No thumb, lens, smoke or drag state, and no layer of the slot's own under the icons.
  assert.doesNotMatch(css, /thumb|lens|smoke|data-dragging|--dmt-thumb|--rn-rail-tile|--rn-accent|\.draggable-mode-tabs::(?:before|after)/)
  const tokens = readFileSync(resolve(process.cwd(), 'src/renderer/design/next/tokens.css'), 'utf8')
  assert.doesNotMatch(tokens, /--rn-liquid-lens-/)

  // Icons rest in the hint ink (ink on hover). The lit twin is the rail's white glyph with the slot's glow; the
  // selected tab alone shows it, and the twins crossfade softly on the motion tokens.
  const icon = cssBlock(css, '.draggable-mode-tabs__icon')
  assert.match(icon, /--dmt-icon-lit:\s*var\(--rn-rail-glyph\);/)
  assert.match(icon, /color:\s*var\(--rn-ink-3\);/)
  assert.doesNotMatch(icon, /background:(?!\s*transparent)/)
  assert.match(css, /\.draggable-mode-tabs__icon:hover \{\s*color:\s*var\(--rn-ink\);/)
  assert.match(cssBlock(css, '.draggable-mode-tabs__glyph'), /transition:\s*opacity var\(--rn-d-2\) var\(--rn-ease-std\), transform var\(--rn-d-2\) var\(--rn-ease-std\);/)
  const lit = cssBlock(css, '.draggable-mode-tabs__glyph.is-lit')
  assert.match(lit, /color:\s*var\(--dmt-icon-lit\);/)
  assert.match(lit, /filter:\s*var\(--rn-liquid-glyph-lit\);/)
  assert.match(lit, /opacity:\s*0;/)
  assert.match(cssBlock(css, ".draggable-mode-tabs__icon[aria-selected='true'] .draggable-mode-tabs__glyph.is-rest"), /opacity:\s*0;/)
  assert.match(cssBlock(css, ".draggable-mode-tabs__icon[aria-selected='true'] .draggable-mode-tabs__glyph.is-lit"), /opacity:\s*1;/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.draggable-mode-tabs__icon,\s*\.draggable-mode-tabs__glyph \{\s*transition:\s*none;/)
  // The lit glyph's light is white with ink at its edge: no orange.
  const litTokens = [...tokens.matchAll(/--rn-liquid-glyph-lit:[^;]*;/g)].map(match => match[0])
  assert.equal(litTokens.length, 2)
  for (const lit of litTokens) assert.doesNotMatch(lit, /255,\s*90,\s*31|rn-accent/)

  // 减少透明: the glass is opaque, so the current cell takes the selected fill, its glyph in ink and without the glow.
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__icon \{\s*--dmt-icon-lit:\s*var\(--rn-ink\);/)
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__glyph\.is-lit \{\s*filter:\s*none;/)
  assert.match(css, /\[data-transparency='reduced'\] \.draggable-mode-tabs__icon\[aria-selected='true'\] \{\s*background:\s*var\(--rn-fill-2\);/)

  // Tokens only: no colour literal, no legacy token and no blur declared by the slot (the lenses carry the optics).
  assert.doesNotMatch(slot, /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i)
  assert.doesNotMatch(slot, /--(?:workbench|color|lg|surface|text|bg|border)-/)
  assert.doesNotMatch(slot, /backdrop-filter/)
})
