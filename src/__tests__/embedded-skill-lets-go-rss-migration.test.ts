/** Bundled lets-go-rss manifest, reference document, and allowed shell wrapper contracts. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'lets-go-rss')


test('manifest compiles to advisory with read_skill default + 5 retained public python actions', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  assert.equal(def.executionMode, 'advisory')
  assert.equal(def.workflow, undefined)
  assert.equal(def.defaultAction, 'read_skill', 'bare `/skill lets-go-rss` should show docs (consistent with reference skills)')

  // 1 reference + 5 public python = 6 actions total
  assert.equal(def.actions.length, 6, 'read_skill + 5 retained python actions for production callers')

  const readSkill = def.actions.find((a) => a.name === 'read_skill')
  assert.ok(readSkill, 'read_skill present')
  assert.equal(readSkill!.runtime, 'reference')
  assert.equal(readSkill!.visibility, 'internal')

  for (const name of ['rss_add', 'rss_update', 'rss_status', 'rss_list', 'rss_stats']) {
    const action = def.actions.find((a) => a.name === name)
    assert.ok(action, `${name} action retained for production callers`)
    assert.equal(action!.runtime, 'python')
    assert.equal(action!.visibility, 'public', `${name} stays LLM-visible (rss-domain-adapter prefers skill_rss_*)`)
  }
})

test('SKILL.md frontmatter declares name / description / when-to-use per Claude Skill protocol', () => {
  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatterMatch, 'SKILL.md must start with YAML frontmatter')
  const frontmatter = frontmatterMatch![1]
  assert.ok(/\bname:\s*lets-go-rss/.test(frontmatter), 'name field required')
  assert.ok(/\bdescription:/.test(frontmatter), 'description field required')
  assert.ok(/\bwhen-to-use:/.test(frontmatter), 'when-to-use field required for Claude Skill protocol')
})

test('SKILL.md uses allowlisted shell wrapper form instead of direct ./scripts invocation', () => {
  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')

  assert.doesNotMatch(skillMd, /(^|\s)\.\/scripts\//)
  assert.match(skillMd, /bash scripts\/run_update_cron\.sh/)
  assert.match(skillMd, /bash scripts\/run_status_push\.sh/)
})
