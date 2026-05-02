/**
 * Phase 1 — Skill Child Run id acceptance tests.
 *
 * Locks the typed prefix + 8 base36 lowercase body shape from source plan
 * §5.1. The id helper is the identity boundary the parent turn uses to
 * route a close event; UUIDs and arbitrary strings must never pass.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSkillChildRunId,
  getSkillChildRunKind,
  isSkillChildRunId,
  type SkillChildRunKind,
} from '../main/modules/agent-control/skill-child-run-id'

const KINDS: SkillChildRunKind[] = ['vea', 'skill', 'detached']
const PREFIX_FOR_KIND: Record<SkillChildRunKind, string> = {
  vea: 'v',
  skill: 's',
  detached: 'd',
}
const ID_PATTERN = /^[vsd][a-z0-9]{8}$/

test('createSkillChildRunId emits /^[vsd][a-z0-9]{8}$/ for every kind', () => {
  for (const kind of KINDS) {
    const id = createSkillChildRunId(kind)
    assert.match(id, ID_PATTERN, `kind=${kind} produced invalid id: ${id}`)
    assert.equal(
      id.charAt(0),
      PREFIX_FOR_KIND[kind],
      `kind=${kind} expected prefix '${PREFIX_FOR_KIND[kind]}', got '${id.charAt(0)}'`,
    )
    assert.equal(id.length, 9, `kind=${kind} expected length 9, got ${id.length}`)
  }
})

test('createSkillChildRunId has no duplicates across 10,000 ids per kind', () => {
  const SAMPLE = 10_000
  for (const kind of KINDS) {
    const seen = new Set<string>()
    for (let i = 0; i < SAMPLE; i++) {
      const id = createSkillChildRunId(kind)
      assert.match(id, ID_PATTERN, `kind=${kind} sample=${i} invalid id: ${id}`)
      assert.equal(seen.has(id), false, `kind=${kind} duplicate id at sample=${i}: ${id}`)
      seen.add(id)
    }
    assert.equal(seen.size, SAMPLE, `kind=${kind} expected ${SAMPLE} unique ids, got ${seen.size}`)
  }
})

test('getSkillChildRunKind returns the correct kind for each prefix', () => {
  for (const kind of KINDS) {
    const id = createSkillChildRunId(kind)
    assert.equal(getSkillChildRunKind(id), kind, `expected kind=${kind} for id=${id}`)
  }
})

test('getSkillChildRunKind returns null for malformed ids', () => {
  assert.equal(getSkillChildRunKind('x12345678'), null, 'unknown prefix must return null')
  assert.equal(getSkillChildRunKind('vABCDEFGH'), null, 'uppercase body must return null')
  assert.equal(getSkillChildRunKind('v1234567'), null, 'short body must return null')
  assert.equal(getSkillChildRunKind('v123456789'), null, 'long body must return null')
  assert.equal(getSkillChildRunKind(''), null, 'empty string must return null')
})

test('isSkillChildRunId rejects UUIDs and arbitrary strings', () => {
  // Standard v4 UUID — 36 chars, hyphenated; explicitly forbidden by §5.1.
  assert.equal(
    isSkillChildRunId('123e4567-e89b-12d3-a456-426614174000'),
    false,
    'UUID v4 must NOT pass — child-run ids are not UUIDs.',
  )
  // Compact UUID (no hyphens) is also wrong shape.
  assert.equal(
    isSkillChildRunId('123e4567e89b12d3a456426614174000'),
    false,
    'compact UUID must NOT pass.',
  )
  assert.equal(isSkillChildRunId('hello'), false)
  assert.equal(isSkillChildRunId('vABCDEFGH'), false, 'uppercase body must fail isSkillChildRunId')
  assert.equal(isSkillChildRunId('z12345678'), false, 'unknown-prefix must fail isSkillChildRunId')
  assert.equal(isSkillChildRunId(''), false)
  assert.equal(isSkillChildRunId(null), false)
  assert.equal(isSkillChildRunId(undefined), false)
  assert.equal(isSkillChildRunId(42), false)
  assert.equal(isSkillChildRunId({ id: 'v12345678' }), false)
})

test('isSkillChildRunId accepts freshly minted ids for every kind', () => {
  for (const kind of KINDS) {
    const id = createSkillChildRunId(kind)
    assert.equal(isSkillChildRunId(id), true, `kind=${kind} id=${id} must be accepted`)
  }
})
