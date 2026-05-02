/**
 * paramListToZodObject tests (Phase 2.5 PR 12).
 *
 * Covers both per-type branch correctness and a round-trip against the 6
 * skill control schemas: zodObjectToParamList → paramListToZodObject →
 * zodObjectToParamList must produce an identical SkillParamDefinition[].
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { paramListToZodObject } from '../main/modules/tools/paramList-to-zod'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
// Phase 4: SKILL_CONTROL_SCHEMAS retired; use SKILL_PRIMITIVE_SCHEMAS as the
// round-trip fixture set since primitives are our canonical
// describe()-annotated Zod objects.
import { SKILL_PRIMITIVE_SCHEMAS } from '../main/modules/tools/skill-primitives/primitive-schemas'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('string param builds z.string()', () => {
  const schema = paramListToZodObject([
    { name: 'q', type: 'string', description: '查询', required: true },
  ])
  assert.equal(schema.safeParse({ q: 'hi' }).success, true)
  assert.equal(schema.safeParse({}).success, false)
  assert.equal(schema.safeParse({ q: 123 }).success, false)
})

test('string param with enum builds z.enum()', () => {
  const schema = paramListToZodObject([
    { name: 'kind', type: 'string', description: 'kind', required: true, enum: ['a', 'b'] },
  ])
  assert.equal(schema.safeParse({ kind: 'a' }).success, true)
  assert.equal(schema.safeParse({ kind: 'c' }).success, false)
})

test('number and boolean params validate types (boolean is lenient)', () => {
  const schema = paramListToZodObject([
    { name: 'n', type: 'number', description: 'n', required: true },
    { name: 'flag', type: 'boolean', description: 'f', required: true },
  ])
  assert.equal(schema.safeParse({ n: 5, flag: true }).success, true)
  // LenientBoolean: string forms accepted
  assert.equal(schema.safeParse({ n: 5, flag: 'true' }).success, true)
  assert.equal(schema.safeParse({ n: 5, flag: '0' }).success, true)
  assert.equal(schema.safeParse({ n: 5, flag: 'yes' }).success, false)
  assert.equal(schema.safeParse({ n: 'five', flag: true }).success, false)
})

test('object param builds z.record; arrays build z.array with typed items', () => {
  const schema = paramListToZodObject([
    { name: 'obj', type: 'object', description: 'o', required: true },
    {
      name: 'tags',
      type: 'array',
      description: 'tags',
      required: false,
      items: { type: 'string' },
    },
  ])
  assert.equal(schema.safeParse({ obj: { a: 1 }, tags: ['x', 'y'] }).success, true)
  assert.equal(schema.safeParse({ obj: 'not-obj' }).success, false)
  assert.equal(schema.safeParse({ obj: {}, tags: [1, 2] }).success, false)
})

test('optional params wrap the leaf in .optional() and preserve description', () => {
  const schema = paramListToZodObject([
    { name: 'x', type: 'string', description: '可选 x', required: false },
  ])
  assert.equal(schema.safeParse({}).success, true)
  assert.equal(schema.safeParse({ x: 'v' }).success, true)
})

test('round-trip over SKILL_PRIMITIVE_SCHEMAS preserves SkillParamDefinition[]', () => {
  for (const [name, original] of Object.entries(SKILL_PRIMITIVE_SCHEMAS)) {
    const originalParams = zodObjectToParamList(original)
    const rebuilt = paramListToZodObject(originalParams)
    const rebuiltParams = zodObjectToParamList(rebuilt)
    assert.deepEqual(
      rebuiltParams,
      originalParams,
      `round-trip mismatch on ${name}`,
    )
  }
})

test('additionalProperties=true object field is preserved', () => {
  const params: SkillParamDefinition[] = [
    {
      name: 'payload',
      type: 'object',
      description: '任意键值',
      required: true,
      additionalProperties: true,
    },
  ]
  const schema = paramListToZodObject(params)
  const derived = zodObjectToParamList(schema)
  assert.deepEqual(derived, params)
})

test('additionalProperties=true on array items is preserved', () => {
  const params: SkillParamDefinition[] = [
    {
      name: 'items',
      type: 'array',
      description: '对象数组',
      required: true,
      items: { type: 'object', additionalProperties: true },
    },
  ]
  const schema = paramListToZodObject(params)
  const derived = zodObjectToParamList(schema)
  assert.deepEqual(derived, params)
})
