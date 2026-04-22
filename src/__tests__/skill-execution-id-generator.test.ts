/**
 * Phase 4 — skill execution id generator shape + uniqueness.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSkillExecutionId } from '../main/modules/skills-runtime/execution-state-store'

test('generated id matches `e-{8hex}` format', () => {
  for (let i = 0; i < 1000; i += 1) {
    const id = generateSkillExecutionId()
    assert.match(id, /^e-[0-9a-f]{8}$/)
  }
})

test('1000 generated ids are all distinct (collision sanity check)', () => {
  const set = new Set<string>()
  for (let i = 0; i < 1000; i += 1) {
    set.add(generateSkillExecutionId())
  }
  assert.equal(set.size, 1000)
})
