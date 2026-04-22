/**
 * Shape tests for the system domain Zod schemas (Phase 2.5 PR 11).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SystemRunEmbeddedPythonSchema,
  SystemRunOpenclawSchema,
} from '../main/modules/tools/schemas/system-schemas'

test('SystemRunEmbeddedPythonSchema accepts empty or partial argument sets', () => {
  assert.equal(SystemRunEmbeddedPythonSchema.safeParse({}).success, true)
  assert.equal(SystemRunEmbeddedPythonSchema.safeParse({ code: 'print(1)' }).success, true)
  assert.equal(
    SystemRunEmbeddedPythonSchema.safeParse({ scriptPath: '/x.py', args: ['--flag'] }).success,
    true,
  )
})

test('SystemRunEmbeddedPythonSchema rejects non-array args + non-number timeout', () => {
  assert.equal(SystemRunEmbeddedPythonSchema.safeParse({ args: 'not-array' }).success, false)
  assert.equal(SystemRunEmbeddedPythonSchema.safeParse({ timeoutMs: '100' }).success, false)
  assert.equal(SystemRunEmbeddedPythonSchema.safeParse({ args: [1, 2] }).success, false)
})

test('SystemRunOpenclawSchema requires command', () => {
  assert.equal(SystemRunOpenclawSchema.safeParse({ command: 'openclaw pairing approve' }).success, true)
  assert.equal(SystemRunOpenclawSchema.safeParse({}).success, false)
  assert.equal(SystemRunOpenclawSchema.safeParse({ command: 123 }).success, false)
})
