import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readReferenceSkillDocCapped, REFERENCE_SKILL_INLINE_CAP_CHARS } from '../main/modules/skills-runtime/reference-skill-doc'

const PPT_ROOT = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')

test('readReferenceSkillDocCapped reads SKILL.md and caps at 12000 chars', () => {
  const doc = readReferenceSkillDocCapped(PPT_ROOT)
  assert.ok(doc && doc.text.length > 0, 'must read the ppt SKILL.md')
  assert.ok((doc?.text.length ?? 0) <= REFERENCE_SKILL_INLINE_CAP_CHARS)
  assert.equal(readReferenceSkillDocCapped('/no/such/path'), null)
})
