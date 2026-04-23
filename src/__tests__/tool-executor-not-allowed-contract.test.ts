import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from '../main/modules/tools/tool-not-allowed-message'

// Pure-module contract tests (tsx --test compatible; no electron imports).
// These pin the two distinct error messages the tool executor layer returns
// before dispatch, and the Set/Array normalization behavior.

test('buildUnknownToolMessage is a stable, non-empty sentence that names the tool', () => {
  const msg = buildUnknownToolMessage('skill_foo_bar_not_registered')
  assert.match(msg, /skill_foo_bar_not_registered/)
  assert.match(msg, /not registered/i)
  // Must not reuse the restricted phrasing — that ambiguity is exactly what
  // R3 is fixing.
  assert.doesNotMatch(msg, /not allowed in current context/i)
})

test('buildToolNotAllowedMessage includes the rejected tool name', () => {
  const allowed = new Set(['skill_get_state', 'skill_submit_input', 'document_open_tab'])
  const msg = buildToolNotAllowedMessage('skill_novel_writer_system_read_skill', allowed)
  assert.match(msg, /skill_novel_writer_system_read_skill/)
  assert.match(msg, /not allowed in current context/i)
})

test('buildToolNotAllowedMessage appends a same-prefix hint when there are siblings', () => {
  const allowed = new Set([
    'skill_get_state',
    'skill_submit_input',
    'skill_rss_list',
    'skill_rss_add',
    'document_open_tab',
    'document_update_widget',
    'browser_click',
  ])
  const msg = buildToolNotAllowedMessage('skill_novel_writer_system_read_skill', allowed)
  assert.match(msg, /Available skill this turn:/)
  assert.match(msg, /skill_get_state/)
  assert.match(msg, /skill_rss_list/)
  // Non-skill siblings must not leak into the skill hint to avoid noise.
  assert.doesNotMatch(msg, /Available skill this turn:[^\n]*\bdocument_open_tab\b/)
  assert.doesNotMatch(msg, /Available skill this turn:[^\n]*\bbrowser_click\b/)
})

test('buildToolNotAllowedMessage caps the hint at 12 siblings', () => {
  const allowed = new Set<string>()
  for (let i = 0; i < 20; i += 1) allowed.add(`skill_sibling_${i}`)
  const msg = buildToolNotAllowedMessage('skill_missing_tool', allowed)
  const hintLine = msg.split('\n').find((line) => line.startsWith('Available')) || ''
  const count = (hintLine.match(/skill_sibling_/g) || []).length
  assert.equal(count, 12)
})

test('buildToolNotAllowedMessage omits the hint when the same prefix has no siblings', () => {
  const allowed = new Set(['document_open_tab', 'browser_click'])
  const msg = buildToolNotAllowedMessage('skill_novel_writer_system_read_skill', allowed)
  assert.match(msg, /not allowed in current context/i)
  assert.doesNotMatch(msg, /Available skill this turn:/)
})

test('normalizeAllowedToolSet accepts Set, Array, null, and undefined identically', () => {
  assert.equal(normalizeAllowedToolSet(null), null)
  assert.equal(normalizeAllowedToolSet(undefined), null)

  const setInput = new Set(['skill_x'])
  assert.equal(normalizeAllowedToolSet(setInput), setInput)

  const arrayOutput = normalizeAllowedToolSet(['skill_x', 'skill_y'])
  assert.ok(arrayOutput instanceof Set)
  assert.equal(arrayOutput!.size, 2)
  assert.ok(arrayOutput!.has('skill_x'))
  assert.ok(arrayOutput!.has('skill_y'))
})

test('tool-not-allowed message is distinguishable from unknown-tool message', () => {
  const allowed = new Set(['skill_get_state'])
  const notAllowed = buildToolNotAllowedMessage('skill_missing', allowed)
  const unknown = buildUnknownToolMessage('skill_missing')
  assert.notEqual(notAllowed, unknown)
  // Both name the tool for debuggability.
  assert.match(notAllowed, /skill_missing/)
  assert.match(unknown, /skill_missing/)
})
