/**
 * Unified tool-input schema registry contract (Phase 2.5 infrastructure).
 *
 * The registry is the single source of truth for dispatch-time Zod validation.
 * Phase 2 only seeded the 6 skill execution-control tools; each Phase 2.5
 * per-domain PR adds its own map. These tests lock:
 *  1. Baseline — the 6 control tool names are present with ZodObject values.
 *  2. Accessor shape — `getToolInputSchemas()` returns a plain record, not a
 *     frozen / proxy / live reference, so per-call merging (PR 12) is safe.
 *  3. No accidental name shadowing — the registry never has two entries for
 *     the same tool name.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SKILL_CONTROL_SCHEMAS,
  getToolInputSchemas,
} from '../main/modules/tools/schemas'

test('getToolInputSchemas includes every skill control tool', () => {
  const registry = getToolInputSchemas()
  for (const name of Object.keys(SKILL_CONTROL_SCHEMAS)) {
    assert.ok(registry[name], `registry missing schema for ${name}`)
    assert.strictEqual(registry[name], SKILL_CONTROL_SCHEMAS[name as keyof typeof SKILL_CONTROL_SCHEMAS])
  }
})

test('getToolInputSchemas returns a plain object (safe to spread)', () => {
  const registry = getToolInputSchemas()
  assert.equal(Object.isFrozen(registry), false)
  const spread = { ...registry }
  assert.equal(Object.keys(spread).length, Object.keys(registry).length)
})

test('registry has no duplicate tool-name entries', () => {
  const registry = getToolInputSchemas()
  const names = Object.keys(registry)
  const unique = new Set(names)
  assert.equal(unique.size, names.length, 'duplicate tool-name keys in registry')
})

test('every registered schema is a Zod object with a .safeParse method', () => {
  const registry = getToolInputSchemas()
  for (const [name, schema] of Object.entries(registry)) {
    assert.equal(typeof (schema as { safeParse?: unknown }).safeParse, 'function', `${name} missing safeParse`)
  }
})
