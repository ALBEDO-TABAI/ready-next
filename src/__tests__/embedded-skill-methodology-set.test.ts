/**
 * Stage R W1.5 — 5 methodology embedded skills present.
 *
 * Asserts that the 5 advisory methodology skills are all registered in
 * EMBEDDED_SKILLS and ship the expected assets.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EMBEDDED_SKILLS } from '../main/modules/skills-runtime/manifest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EMBEDDED_ROOT = join(__dirname, '..', '..', 'assets', 'embedded-skills')

const METHODOLOGY_SKILLS = [
  'systematic-literature-review',
  'github-deep-research',
  'academic-paper-review',
  'web-design-guidelines',
  'find-skills',
] as const

test('all 5 methodology skills registered in EMBEDDED_SKILLS', () => {
  const ids = new Set(EMBEDDED_SKILLS.map((s) => s.id))
  for (const skill of METHODOLOGY_SKILLS) {
    assert.ok(ids.has(skill), `EMBEDDED_SKILLS must include ${skill}`)
  }
})

test('all 5 methodology skill asset directories exist with SKILL.md + ready-skill.json', () => {
  for (const skill of METHODOLOGY_SKILLS) {
    const dir = join(EMBEDDED_ROOT, skill)
    assert.equal(existsSync(join(dir, 'SKILL.md')), true, `${skill}/SKILL.md missing`)
    assert.equal(existsSync(join(dir, 'ready-skill.json')), true, `${skill}/ready-skill.json missing`)
  }
})
