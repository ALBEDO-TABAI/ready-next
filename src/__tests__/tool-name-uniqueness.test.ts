/**
 * Stage R W2.3 — tool name uniqueness boot invariant.
 *
 * Asserts that `ToolNameCollisionError` carries the offending
 * collision tuples (`name / existingGroup / incomingGroup`) so a boot-time
 * failure surfaces actionable diagnostics rather than a generic Error.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolNameCollisionError } from '../main/modules/agent-control/tool-registry-errors'

test('ToolNameCollisionError carries collision tuples', () => {
  const collisions = [
    { name: 'web_search', existingGroup: 'general_research', incomingGroup: 'browser_content_tasks' },
  ]
  const err = new ToolNameCollisionError(collisions)
  assert.equal(err.name, 'ToolNameCollisionError')
  assert.equal(err.collisions.length, 1)
  assert.equal(err.collisions[0]!.name, 'web_search')
  assert.match(err.message, /web_search/)
})

test('ToolNameCollisionError formats multiple collisions', () => {
  const err = new ToolNameCollisionError([
    { name: 'a', existingGroup: 'g1', incomingGroup: 'g2' },
    { name: 'b', existingGroup: 'g3', incomingGroup: 'g4' },
  ])
  assert.match(err.message, /a/)
  assert.match(err.message, /b/)
})
