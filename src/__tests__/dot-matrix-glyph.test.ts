import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DOT_GLYPH_NAMES,
  DOT_GLYPH_SIZE,
  dotGlyphCells,
  dotGlyphLitCount,
  dotGlyphRows,
} from '../renderer/components/ui/dot-matrix/dot-glyphs'
import { DotGlyph } from '../renderer/components/ui/dot-matrix/DotGlyph'
import { agentStatusGlyph } from '../renderer/components/ui/dot-matrix/agent-status-glyph'
import {
  taskCardVisualStateLabel,
  type TaskCardVisualState,
} from '../renderer/modules/agent/task-status-vocabulary'

test('every glyph is a well-formed 9×9 bitmap of complete cells', () => {
  for (const name of DOT_GLYPH_NAMES) {
    const rows = dotGlyphRows(name)
    assert.equal(rows.length, DOT_GLYPH_SIZE, `${name} must have 9 rows`)
    for (const row of rows) {
      assert.equal(row.length, DOT_GLYPH_SIZE, `${name} row must be 9 chars`)
      assert.match(row, /^[#.]+$/, `${name} row must only use # / .`)
    }
    const cells = dotGlyphCells(name)
    assert.equal(cells.length, DOT_GLYPH_SIZE * DOT_GLYPH_SIZE)
    assert.equal(dotGlyphLitCount(name), cells.filter(Boolean).length)
    assert.ok(dotGlyphLitCount(name) > 0, `${name} must light at least one cell`)
  }
})

test('agent status state machine maps every visual state, signal colour reserved for genuine signals', () => {
  const allStates: TaskCardVisualState[] = [
    'running',
    'background_running',
    'waiting_input',
    'waiting_handoff',
    'budget_paused',
    'done',
    'failed',
  ]
  // States that may light the alert (signal) colour — needs-input + over-budget + error.
  const signalStates = new Set<TaskCardVisualState>([
    'waiting_input',
    'waiting_handoff',
    'budget_paused',
    'failed',
  ])

  for (const state of allStates) {
    const status = agentStatusGlyph(state)
    assert.ok(DOT_GLYPH_NAMES.includes(status.glyph), `${state} -> known glyph`)
    assert.equal(status.label, taskCardVisualStateLabel(state), `${state} -> canonical label`)

    if (signalStates.has(state)) {
      assert.equal(status.tone, 'signal', `${state} is a genuine signal`)
    } else {
      // Active / normal states (running / background / done) never colourise.
      assert.equal(status.tone, 'neutral', `${state} must not use the signal colour`)
    }
  }

  // Only running states pulse.
  assert.equal(agentStatusGlyph('running').pulse, true)
  assert.equal(agentStatusGlyph('background_running').pulse, true)
  assert.equal(agentStatusGlyph('done').pulse, false)
  assert.equal(agentStatusGlyph('failed').pulse, false)
})

test('DotGlyph renders 81 grid cells, lit cells as circles, and carries tone/pulse hooks', () => {
  const signalMarkup = renderToStaticMarkup(
    createElement(DotGlyph, { name: 'error', tone: 'signal', pulse: true }),
  )
  const totalCells = signalMarkup.match(/<i\b/g)?.length ?? 0
  const litCells = signalMarkup.match(/class="on"/g)?.length ?? 0
  assert.equal(totalCells, DOT_GLYPH_SIZE * DOT_GLYPH_SIZE)
  assert.equal(litCells, dotGlyphLitCount('error'))
  assert.match(signalMarkup, /data-dot-glyph="error"/)
  assert.match(signalMarkup, /data-dot-glyph-tone="signal"/)
  assert.match(signalMarkup, /dot-glyph--pulse/)

  const neutralMarkup = renderToStaticMarkup(createElement(DotGlyph, { name: 'done' }))
  assert.match(neutralMarkup, /data-dot-glyph-tone="neutral"/)
  assert.doesNotMatch(neutralMarkup, /dot-glyph--pulse/)
})
