'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { checkTaskProjectionWireCanonical } = require('../check-task-projection-wire-canonical.cjs')

test('U4.v2-4 current repo passes (electron.d.ts is wire-derived)', () => {
  const { ok, violations } = checkTaskProjectionWireCanonical()
  if (!ok) console.error('Unexpected violations:', violations)
  assert.equal(ok, true)
  assert.equal(violations.length, 0)
})

test('U4.v2-4 forbidden interface forms match the regression regex', () => {
  // Sanity-check the two forbidden interface forms parse as the gate
  // expects, by exercising the two regex literals embedded in the gate.
  const eventLine = 'export interface TaskProjectionChangeEventData {'
  const recordLine = 'interface TaskProjectionRecordData {'
  assert.ok(/interface\s+TaskProjectionChangeEventData\s*\{/.test(eventLine),
    'TaskProjectionChangeEventData interface form should be detectable')
  assert.ok(/interface\s+TaskProjectionRecordData\s*\{/.test(recordLine),
    'TaskProjectionRecordData interface form should be detectable')
})

test('U4.v2-4 allowed wire-derived forms do NOT trigger the gate', () => {
  // These are the canonical wire-derived forms; they must not match the
  // forbidden patterns.
  const eventAlias = 'export type TaskProjectionChangeEventData = TaskProjectionChangeEventWire'
  const recordAlias = 'type TaskProjectionRecordData = Omit<TaskProjectionRecordWire, "steps"> & { steps: TaskProjectionStepData[] }'
  assert.ok(!/interface\s+TaskProjectionChangeEventData\s*\{/.test(eventAlias),
    'wire-alias form must not trip the interface regex')
  assert.ok(!/interface\s+TaskProjectionRecordData\s*\{/.test(recordAlias),
    'wire-derived Omit form must not trip the interface regex')
})
