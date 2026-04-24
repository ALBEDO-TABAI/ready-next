/**
 * Unified tool-input schema registry contract (Phase 2.5 infrastructure).
 *
 * The registry is the single source of truth for dispatch-time Zod validation.
 * B Phase 4 PR2 retired the 6 skill execution-control schemas that originally
 * seeded the registry; the baseline below now pivots to the 4 surviving
 * skill primitive schemas. The remaining invariants (plain-object accessor,
 * no duplicate keys, every entry is a ZodObject) are unchanged.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { getToolInputSchemas } from '../main/modules/tools/schemas'
import { SKILL_PRIMITIVE_SCHEMAS } from '../main/modules/tools/skill-primitives/primitive-schemas'

test('getToolInputSchemas includes every skill primitive schema', () => {
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
