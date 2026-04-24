/**
 * B Phase 3 PR3 — cross-skill regression smoke for the 3 embedded skills
 * that finished the markdown + reference migration.
 *
 * Purpose: a single place that asserts the contract we want preserved
 * across all reference-mode embedded skills. If a future change drops
 * `when-to-use`, re-introduces a workflow.json, or accidentally removes
 * the read_skill defaultAction, this test fires before the per-skill
 * tests do. Per-skill tests still cover the skill-specific assertions
 * (compat actions, file paths, body keywords).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..', 'assets', 'embedded-skills')

const REFERENCE_SKILLS = [
  'video-copy-analyzer',
  'video-expert-analyzer',
  'lets-go-rss',
] as const

for (const skillId of REFERENCE_SKILLS) {
  const SKILL_DIR = join(ROOT, skillId)

  test(`[${skillId}] manifest is advisory-mode with read_skill default`, () => {
    const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
    assert.equal(def.executionMode, 'advisory', `${skillId}: executionMode must be advisory`)
    assert.equal(def.workflow, undefined, `${skillId}: no workflow object`)
    assert.equal(def.defaultAction, 'read_skill', `${skillId}: defaultAction must be read_skill`)

    const readSkill = def.actions.find((a) => a.name === 'read_skill')
    assert.ok(readSkill, `${skillId}: read_skill action must exist`)
    assert.equal(readSkill!.runtime, 'reference', `${skillId}: read_skill must be runtime:reference`)
    assert.equal(readSkill!.visibility, 'internal', `${skillId}: read_skill must be visibility:internal`)
  })

  test(`[${skillId}] no skill.workflow.json on disk`, () => {
    assert.equal(
      existsSync(join(SKILL_DIR, 'skill.workflow.json')),
      false,
      `${skillId}: skill.workflow.json must not exist`,
    )
  })

  test(`[${skillId}] SKILL.md frontmatter has when-to-use`, () => {
    const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
    const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
    assert.ok(frontmatterMatch, `${skillId}: SKILL.md must start with YAML frontmatter`)
    const frontmatter = frontmatterMatch![1]
    assert.ok(/\bname:/.test(frontmatter), `${skillId}: name field required`)
    assert.ok(/\bdescription:/.test(frontmatter), `${skillId}: description field required`)
    assert.ok(
      /\bwhen-to-use:/.test(frontmatter),
      `${skillId}: when-to-use field required for Claude Skill protocol`,
    )
  })
}
