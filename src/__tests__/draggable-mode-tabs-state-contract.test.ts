import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveWorkbenchModeTabLayout } from '../renderer/modules/workbench/mode-tabs-layout'

// The mode switch slot (V20) maps the workbench state to a display order and a thumb: one cell for a single mode, two
// adjacent cells for a split, the split mode moved next to the primary one.
test('resolveWorkbenchModeTabLayout maps single and split states to the display order and the thumb', () => {
  assert.deepEqual(resolveWorkbenchModeTabLayout('rss', null), {
    displayModes: ['browser', 'document', 'rss', 'calendar'],
    visualIndexByMode: { browser: 0, document: 1, rss: 2, calendar: 3 },
    activeIndex: 2, splitIndex: null, thumbStart: 2, thumbSpan: 1,
  })
  // A split mode equal to the primary one is no split.
  assert.equal(resolveWorkbenchModeTabLayout('rss', 'rss').splitIndex, null)
  assert.equal(resolveWorkbenchModeTabLayout('rss', 'rss').thumbSpan, 1)

  // Neighbours keep their order and the thumb spans both.
  const adjacent = resolveWorkbenchModeTabLayout('document', 'rss')
  assert.deepEqual(adjacent.displayModes, ['browser', 'document', 'rss', 'calendar'])
  assert.deepEqual([adjacent.activeIndex, adjacent.splitIndex, adjacent.thumbStart, adjacent.thumbSpan], [1, 2, 1, 2])

  // A split mode to the right moves in right after the primary one.
  const right = resolveWorkbenchModeTabLayout('browser', 'calendar')
  assert.deepEqual(right.displayModes, ['browser', 'calendar', 'document', 'rss'])
  assert.deepEqual(right.visualIndexByMode, { browser: 0, calendar: 1, document: 2, rss: 3 })
  assert.deepEqual([right.activeIndex, right.splitIndex, right.thumbStart, right.thumbSpan], [0, 1, 0, 2])

  // A split mode to the left moves in right before it.
  const left = resolveWorkbenchModeTabLayout('rss', 'browser')
  assert.deepEqual(left.displayModes, ['document', 'browser', 'rss', 'calendar'])
  assert.deepEqual([left.activeIndex, left.splitIndex, left.thumbStart, left.thumbSpan], [2, 1, 1, 2])
})

test('the slot CSS places the thumb and the icons from the variables DraggableModeTabs writes', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/mode-switch.css'), 'utf8')
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `${selector} should exist`)
    return css.slice(start, css.indexOf('\n}', start))
  }

  // A 40px pill holding four 44px cells edge to edge. The lens is flush with it: its full height and one cell wide (both
  // cells of a split), so at either end it is concentric with the pill; it moves by whole cells and never grows past them.
  const slot = block('.draggable-mode-tabs')
  assert.match(slot, /--dmt-cell:\s*44px;/)
  assert.match(slot, /width:\s*calc\(4 \* var\(--dmt-cell\)\);/)
  assert.match(slot, /height:\s*var\(--rn-control-h-xl\);/)
  assert.match(slot, /border-radius:\s*var\(--rn-r-pill\);/)
  assert.doesNotMatch(slot, /padding/)
  assert.doesNotMatch(css, /--dmt-pad|--dmt-lens-reach|scale:\s*1\.0|data-travelling/)
  const thumb = block('.draggable-mode-tabs__thumb')
  assert.match(thumb, /top:\s*0;/)
  assert.match(thumb, /left:\s*0;/)
  assert.match(thumb, /width:\s*calc\(var\(--dmt-cell\) \* var\(--dmt-thumb-span, 1\)\);/)
  assert.match(thumb, /height:\s*100%;/)
  assert.match(thumb, /border-radius:\s*var\(--rn-r-pill\);/)
  assert.match(thumb, /transform:\s*translateX\(calc\(var\(--dmt-thumb-pos, 0\) \* var\(--dmt-cell\)\)\);/)
  // The span moves with the place in script (the behaviour test checks the far end), not by a CSS transition of its own.
  assert.doesNotMatch(thumb, /transition/)
  // The lens's light is clipped to its outline, so no outer shadow shows past the pill.
  assert.match(thumb, /overflow:\s*hidden;/)
  assert.match(thumb, /pointer-events:\s*none;/)

  // Nothing between the lens and the composer clips its overflow: not the slot, its dock or the context row.
  const composer = readFileSync(resolve(process.cwd(), 'src/renderer/styles/liquid-composer.css'), 'utf8')
  const row = composer.slice(composer.indexOf('.ready-chat-composer-context-row {'))
  for (const rule of [slot, block('.ready-chat-mode-tabs-dock'), row.slice(0, row.indexOf('\n}'))]) {
    assert.doesNotMatch(rule, /overflow/)
  }

  // Icons follow their display index (the split reorder) and light up by their distance to the thumb.
  const icon = block('.draggable-mode-tabs__icon')
  assert.match(icon, /transform:\s*translateX\(calc\(var\(--dmt-icon-shift, 0\) \* 100%\)\);/)
  assert.match(icon, /--dmt-icon-proximity:\s*max\(0, calc\(1 - var\(--dmt-icon-range-distance\) \* 0\.8\)\);/)
  assert.match(icon, /var\(--dmt-icon-index, 0\)/)
})
