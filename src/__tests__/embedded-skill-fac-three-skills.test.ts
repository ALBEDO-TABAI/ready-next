/**
 * Registration acceptance for the skill-fac-derived embedded skills:
 *   - study-notes
 *   - image-analysis-router
 *   - fastnote
 *   - surf-pro
 *   - okf-bundle
 *   - okf-library
 *   - script-expert-ready
 *
 * Asserts:
 *   - All ids are present in the `EMBEDDED_SKILLS[]` array
 *   - Each id has matching SKILL.md + ready-skill.json on disk
 *   - Each ready-skill.json declares `runtime: reference` + `execution.mode: advisory`
 *     so they are inlined via `tryInlineReferenceSkillDoc` per §6.7
 *   - Each SKILL.md is within Ready's 12000 JS-character inline cap
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  EMBEDDED_SKILLS,
  EMBEDDED_SKILL_IDS,
} from '../main/modules/skills-runtime/manifest'

const SKILLS_ROOT = join(process.cwd(), 'assets', 'embedded-skills')
const REFERENCE_SKILL_INLINE_CAP_CHARS = 12_000
const NEW_SKILL_IDS = [
  'study-notes',
  'image-analysis-router',
  'fastnote',
  'surf-pro',
  'okf-bundle',
  'okf-library',
  'script-expert-ready',
] as const

test('skill-fac skills are registered in EMBEDDED_SKILLS[]', () => {
  for (const id of NEW_SKILL_IDS) {
    assert.ok(EMBEDDED_SKILL_IDS.has(id), `EMBEDDED_SKILL_IDS missing ${id}`)
    const found = EMBEDDED_SKILLS.find((s) => s.id === id)
    assert.ok(found, `EMBEDDED_SKILLS array missing ${id}`)
    assert.equal(found?.requirementsFile, 'requirements.txt', `${id} should declare requirements.txt`)
  }
})

test('each skill has SKILL.md + ready-skill.json on disk', () => {
  for (const id of NEW_SKILL_IDS) {
    const skillMdPath = join(SKILLS_ROOT, id, 'SKILL.md')
    const readySkillJsonPath = join(SKILLS_ROOT, id, 'ready-skill.json')
    assert.ok(existsSync(skillMdPath), `${id}/SKILL.md missing`)
    assert.ok(existsSync(readySkillJsonPath), `${id}/ready-skill.json missing`)
  }
})

test('each ready-skill.json declares runtime=reference + execution.mode=advisory + read_skill action', () => {
  for (const id of NEW_SKILL_IDS) {
    const readySkillJsonPath = join(SKILLS_ROOT, id, 'ready-skill.json')
    const parsed = JSON.parse(readFileSync(readySkillJsonPath, 'utf8'))
    assert.equal(parsed.id, id, `${id}/ready-skill.json id mismatch`)
    assert.equal(parsed.runtime, 'reference', `${id} should be runtime: reference`)
    assert.equal(parsed.execution?.mode, 'advisory', `${id} should be execution.mode: advisory`)
    assert.ok(parsed.actions?.read_skill, `${id} should declare read_skill action`)
    assert.equal(parsed.actions.read_skill.runtime, 'reference')
    assert.equal(parsed.actions.read_skill.visibility, 'internal')
  }
})

test('each SKILL.md has the required name frontmatter and a non-trivial body', () => {
  for (const id of NEW_SKILL_IDS) {
    const skillMdPath = join(SKILLS_ROOT, id, 'SKILL.md')
    const raw = readFileSync(skillMdPath, 'utf8')
    assert.match(raw, /^---[\s\S]*?name:\s*\S/, `${id}/SKILL.md missing frontmatter with name`)
    assert.match(raw, /^---[\s\S]*?description:\s*\S/, `${id}/SKILL.md missing frontmatter with description`)
    assert.ok(raw.length > 1000, `${id}/SKILL.md is suspiciously small: ${raw.length} chars`)
  }
})

test('each fac skill fits within Ready 12K inline cap', () => {
  for (const id of NEW_SKILL_IDS) {
    const raw = readFileSync(join(SKILLS_ROOT, id, 'SKILL.md'), 'utf8')
    assert.ok(
      raw.length <= REFERENCE_SKILL_INLINE_CAP_CHARS,
      `${id}/SKILL.md (${raw.length} chars) exceeds 12K inline cap`,
    )
  }
})
