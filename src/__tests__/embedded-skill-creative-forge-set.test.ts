import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { buildEmbeddedSkillManifests } from '../main/modules/skills-runtime/manifest'

const SKILLS_ROOT = join(process.cwd(), 'assets', 'embedded-skills')
const CREATIVE_FORGE_SKILLS = [
  'character-costume-forge',
  'script-storyboard-forge',
  'tag-forge',
  'image-deep-read',
  'image-reverse-describe',
  'style-grammar-distill',
] as const

test('creative-forge skills ship complete reference assets and register through the embedded scan', () => {
  const manifests = buildEmbeddedSkillManifests(SKILLS_ROOT)

  for (const id of CREATIVE_FORGE_SKILLS) {
    const root = join(SKILLS_ROOT, id)
    const manifestPath = join(root, 'ready-skill.json')
    const skillPath = join(root, 'SKILL.md')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    assert.equal(existsSync(skillPath), true, `${id}/SKILL.md missing`)
    assert.equal(manifest.id, id, `${id}/ready-skill.json id mismatch`)
    assert.equal(manifest.runtime, 'reference', `${id} should be a reference skill`)
    assert.equal(manifest.execution?.mode, 'advisory', `${id} should be advisory`)
    assert.equal(manifest.actions?.read_skill?.visibility, 'internal', `${id} read_skill should stay internal`)
    assert.ok(manifests.some((entry) => entry.id === id), `${id} was not registered by the embedded scan`)
  }

  assert.equal(existsSync(join(SKILLS_ROOT, 'tag-forge', 'tag-lexicon.yaml')), true)
  assert.equal(existsSync(join(SKILLS_ROOT, 'character-costume-forge', 'reference', 'mapping-dictionary.md')), true)
  assert.equal(existsSync(join(SKILLS_ROOT, 'script-storyboard-forge', 'references', 'storyboard-grammar.md')), true)
  assert.equal(existsSync(join(SKILLS_ROOT, 'image-deep-read', 'references', 'output-contract.md')), true)
  assert.equal(existsSync(join(SKILLS_ROOT, 'image-reverse-describe', 'references', 'coordinate-system.md')), true)
  assert.equal(existsSync(join(SKILLS_ROOT, 'style-grammar-distill', 'reference', 'grammar-schema.md')), true)
})
