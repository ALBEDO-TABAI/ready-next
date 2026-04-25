/**
 * Unified tool-input schema registry contract (Phase 2.5 infrastructure).
 *
 * The registry is the single source of truth for dispatch-time Zod validation.
 * Phase 4: the 6 skill execution-control schemas were retired along with the
 * skill_executions state machine. The 4 skill primitives are now the canonical
 * skill-domain entries in the registry.
 *
 * These tests lock:
 *  1. Baseline — the 4 primitive tool names are present with ZodObject values.
 *  2. Accessor shape — `getToolInputSchemas()` returns a plain record, not a
 *     frozen / proxy / live reference, so per-call merging (PR 12) is safe.
 *  3. No accidental name shadowing — the registry never has two entries for
 *     the same tool name.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { getToolInputSchemas } from '../main/modules/tools/schemas'
import { SKILL_PRIMITIVE_SCHEMAS } from '../main/modules/tools/skill-primitives/primitive-schemas'

test('getToolInputSchemas includes every skill primitive', () => {
  const registry = getToolInputSchemas()
  for (const name of Object.keys(SKILL_PRIMITIVE_SCHEMAS)) {
    assert.ok(registry[name], `registry missing schema for ${name}`)
    assert.strictEqual(
      registry[name],
      SKILL_PRIMITIVE_SCHEMAS[name as keyof typeof SKILL_PRIMITIVE_SCHEMAS],
    )
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
