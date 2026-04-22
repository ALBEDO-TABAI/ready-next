/**
 * Phase 4 — TOOL_ERROR_METRICS registry shape test.
 *
 * Locks:
 *   - 6 documented entries exist
 *   - values are snake_case strings (match log-query grep conventions)
 *   - values are all distinct (no accidental reuse)
 *   - values match the historical metric strings so existing log queries
 *     continue working
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tool-error-metrics'

test('registry exposes the 6 documented keys', () => {
  const keys = Object.keys(TOOL_ERROR_METRICS).sort()
  assert.deepEqual(keys, [
    'inputValidation',
    'resolutionViolation',
    'skillExecutionMissing',
    'surfaced',
    'ttlSwept',
    'unknownSurfaced',
  ])
})

test('each value is a snake_case string', () => {
  for (const value of Object.values(TOOL_ERROR_METRICS)) {
    assert.equal(typeof value, 'string')
    assert.match(value, /^[a-z][a-z0-9_]*$/)
  }
})

test('values are all distinct', () => {
  const values = Object.values(TOOL_ERROR_METRICS)
  assert.equal(new Set(values).size, values.length)
})

test('historical metric strings are preserved (log-compat contract)', () => {
  // Renaming these breaks log aggregation queries. If you change a value on
  // purpose, document the rename in CHANGELOG.md and bump this assertion.
  assert.equal(TOOL_ERROR_METRICS.surfaced, 'tool_error_surfaced')
  assert.equal(TOOL_ERROR_METRICS.unknownSurfaced, 'tool_error_unknown_surfaced')
  assert.equal(TOOL_ERROR_METRICS.inputValidation, 'tool_input_validation_failed')
  assert.equal(TOOL_ERROR_METRICS.resolutionViolation, 'tool_resolution_violation_post_arbitration')
  assert.equal(TOOL_ERROR_METRICS.skillExecutionMissing, 'skill_execution_missing')
  assert.equal(TOOL_ERROR_METRICS.ttlSwept, 'skill_executions_ttl_swept')
})
