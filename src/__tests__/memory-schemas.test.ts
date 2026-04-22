/**
 * Shape tests for the memory domain Zod schemas (Phase 2.5 PR 2).
 *
 * Locks the contract that dispatch-time validation enforces before
 * memory-tools' executeMemoryTool ever runs. Pure — Zod + schemas only.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MemoryCreateSchema,
  MemorySearchSchema,
  MemoryUpdateSchema,
  MemoryListRecentSchema,
} from '../main/modules/tools/schemas/memory-schemas'

test('MemoryCreateSchema requires category/title/content, accepts optional tags + priority', () => {
  const ok = MemoryCreateSchema.safeParse({
    category: 'summary',
    title: 't',
    content: 'c',
    tags: ['a', 'b'],
    priority: 3,
  })
  assert.equal(ok.success, true)

  const minimal = MemoryCreateSchema.safeParse({ category: 'learning', title: 't', content: 'c' })
  assert.equal(minimal.success, true)

  const missing = MemoryCreateSchema.safeParse({ category: 'summary', title: 't' })
  assert.equal(missing.success, false)
})

test('MemoryCreateSchema rejects unknown category enum values', () => {
  const bad = MemoryCreateSchema.safeParse({ category: 'foo', title: 't', content: 'c' })
  assert.equal(bad.success, false)
})

test('MemoryCreateSchema.tags must be an array when provided', () => {
  const bad = MemoryCreateSchema.safeParse({
    category: 'summary',
    title: 't',
    content: 'c',
    tags: 'not-an-array',
  })
  assert.equal(bad.success, false)
})

test('MemorySearchSchema accepts empty input and validates enums when present', () => {
  assert.equal(MemorySearchSchema.safeParse({}).success, true)
  assert.equal(MemorySearchSchema.safeParse({ layer: 'l0' }).success, true)
  assert.equal(MemorySearchSchema.safeParse({ layer: 'l9' }).success, false)
  assert.equal(MemorySearchSchema.safeParse({ source_type: 'resident_user' }).success, true)
  assert.equal(MemorySearchSchema.safeParse({ source_type: 'bogus' }).success, false)
  assert.equal(MemorySearchSchema.safeParse({ category: 'trigger' }).success, true)
  assert.equal(MemorySearchSchema.safeParse({ category: 'foo' }).success, false)
})

test('MemoryUpdateSchema requires memory_id; other fields optional', () => {
  assert.equal(MemoryUpdateSchema.safeParse({ memory_id: 'm-1' }).success, true)
  assert.equal(MemoryUpdateSchema.safeParse({}).success, false)
  assert.equal(
    MemoryUpdateSchema.safeParse({
      memory_id: 'm-1',
      tags: ['x'],
      priority: 5,
      source_type: 'scope_memory',
    }).success,
    true,
  )
})

test('MemoryListRecentSchema accepts {} and typed optional fields', () => {
  assert.equal(MemoryListRecentSchema.safeParse({}).success, true)
  assert.equal(MemoryListRecentSchema.safeParse({ limit: 10 }).success, true)
  assert.equal(MemoryListRecentSchema.safeParse({ limit: 'ten' }).success, false)
  assert.equal(MemoryListRecentSchema.safeParse({ source_type: 'trigger_rule' }).success, true)
})

test('Unknown keys are silently stripped (default Zod behavior)', () => {
  const result = MemoryCreateSchema.safeParse({
    category: 'summary',
    title: 't',
    content: 'c',
    unexpectedField: 'dropped',
  })
  assert.equal(result.success, true)
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>).unexpectedField, undefined)
  }
})
