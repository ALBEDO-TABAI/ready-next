/**
 * Stage U PR U1.5 — `normalizeReadSkillVisibility` helper contract.
 *
 * CLAUDE.md §3: "reference/advisory skill 以内联 SKILL.md 为主, read_skill
 * 归一为 internal". The helper is the single source of truth replacing
 * two prior `normalizeReferenceReadSkillVisibility` copies plus an inline
 * branch in `custom-skill-registry.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeReadSkillVisibility } from '../main/modules/skills-runtime/read-skill-visibility'

test('runtime skill, currentVisibility=public → keeps public', () => {
  assert.equal(normalizeReadSkillVisibility('runtime', 'public'), 'public')
})

test('runtime skill, currentVisibility=internal → keeps internal', () => {
  assert.equal(normalizeReadSkillVisibility('runtime', 'internal'), 'internal')
})

test('reference skill, currentVisibility=public → forced to internal', () => {
  assert.equal(normalizeReadSkillVisibility('reference', 'public'), 'internal')
})

test('reference skill, currentVisibility=internal → stays internal', () => {
  assert.equal(normalizeReadSkillVisibility('reference', 'internal'), 'internal')
})

test('advisory skill, currentVisibility=public → forced to internal', () => {
  assert.equal(normalizeReadSkillVisibility('advisory', 'public'), 'internal')
})

test('advisory skill, currentVisibility=internal → stays internal', () => {
  assert.equal(normalizeReadSkillVisibility('advisory', 'internal'), 'internal')
})
