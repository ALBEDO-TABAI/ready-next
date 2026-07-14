import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { buildEmbeddedSkillManifests } from '../main/modules/skills-runtime/manifest'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

const ROOT = join(process.cwd(), 'assets', 'embedded-skills')
const SKILL_ROOT = join(ROOT, 'anysearch')

test('AnySearch ships as a Ready-native advisory skill using the governed research tools', () => {
  const manifests = buildEmbeddedSkillManifests(ROOT)
  const skill = compileSkillDefinition({ folderPath: SKILL_ROOT, source: 'embedded' })
  const document = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')

  assert.ok(manifests.some((entry) => entry.id === 'anysearch'))
  assert.equal(skill.executionMode, 'advisory')
  assert.equal(skill.actions.find((action) => action.name === 'read_skill')?.visibility, 'internal')
  assert.match(document, /web_search_domains/)
  assert.match(document, /web_search/)
  assert.match(document, /web_fetch/)
  assert.match(document, /https:\/\/github\.com\/anysearch-ai\/anysearch-skill/)
  assert.doesNotMatch(document, /skill_run_shell|anysearch_cli\.(?:js|py|sh|ps1)/)
})
