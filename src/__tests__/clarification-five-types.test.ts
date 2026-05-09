/**
 * Stage S W6.1 — Clarification 5-type union behavior test.
 *
 * Asserts the frozen union has exactly 5 expected members and that the
 * derived `ClarificationType` accepts each as a value.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLARIFICATION_TYPES,
  type ClarificationType,
} from '../main/modules/agent-control/clarification-types'

test('CLARIFICATION_TYPES has exactly 5 members', () => {
  assert.equal(CLARIFICATION_TYPES.length, 5)
})

test('CLARIFICATION_TYPES contains the expected closed set', () => {
  const sorted = [...CLARIFICATION_TYPES].sort()
  assert.deepEqual(sorted, [
    'ambiguous_requirement',
    'approach_choice',
    'missing_info',
    'risk_confirmation',
    'suggestion',
  ])
})

test('every CLARIFICATION_TYPES member is assignable to ClarificationType', () => {
  for (const t of CLARIFICATION_TYPES) {
    const v: ClarificationType = t
    assert.equal(typeof v, 'string')
  }
})
