/**
 * P2-4 + P2-5 — custom-skill import metadata (spec tolerance + security policy + L2 warning).
 * 母合同 §4 T5/T6 + P2 §4/§5.
 *
 *   P2-4: unknown frontmatter fields are ignored-not-rejected; imported `allowed-tools` is
 *         ALWAYS ignored by policy (downloaded skills carry no tool authorization) and recorded
 *         in `ignoredFields`.
 *   P2-5: a SKILL.md over the L2 inline cap (12000 chars) yields a non-blocking author warning.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectCustomSkillImportMetadata } from '../main/modules/skills-runtime/custom-skill-registry'
import { parseSkillFrontmatter } from '../main/modules/skills-runtime/skill-frontmatter'
import { REFERENCE_SKILL_INLINE_CAP_CHARS } from '../main/modules/skills-runtime/reference-skill-doc'

function tmpSkill(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'p24-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content)
  }
  return root
}

test('P2-4: allowed-tools in SKILL.md frontmatter → ignoredFields, import not rejected', () => {
  const root = tmpSkill({
    'SKILL.md': [
      '---',
      'name: my-skill',
      'description: a reference skill',
      'allowed-tools: Read, Bash(git:*), Write',
      'license: MIT',
      'some-unknown-field: whatever',
      '---',
      '# body',
    ].join('\n'),
  })
  try {
    const meta = collectCustomSkillImportMetadata(root)
    assert.deepEqual(meta.ignoredFields, ['allowed-tools'], 'allowed-tools must be recorded as ignored')
    assert.deepEqual(meta.warnings, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2-4: allowedTools (camelCase) in ready-skill.json → ignoredFields (variant-normalized)', () => {
  const root = tmpSkill({
    'ready-skill.json': JSON.stringify({ id: 'x', name: 'x', description: 'd', allowedTools: ['Read', 'Write'] }),
  })
  try {
    assert.deepEqual(collectCustomSkillImportMetadata(root).ignoredFields, ['allowed-tools'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2-5: oversized SKILL.md → warning; clean small skill → no metadata', () => {
  const big = tmpSkill({
    'SKILL.md': `---\nname: big\ndescription: d\n---\n${'x'.repeat(REFERENCE_SKILL_INLINE_CAP_CHARS + 10)}`,
  })
  try {
    const meta = collectCustomSkillImportMetadata(big)
    assert.equal(meta.warnings.length, 1)
    assert.match(meta.warnings[0], /12000/)
    assert.deepEqual(meta.ignoredFields, [])
  } finally {
    rmSync(big, { recursive: true, force: true })
  }

  const clean = tmpSkill({ 'SKILL.md': '---\nname: c\ndescription: d\n---\n# short' })
  try {
    assert.deepEqual(collectCustomSkillImportMetadata(clean), { ignoredFields: [], warnings: [] })
  } finally {
    rmSync(clean, { recursive: true, force: true })
  }
})

test('P2-4: parseSkillFrontmatter keeps unknown + spec fields (tolerance, no rejection)', () => {
  const { metadata } = parseSkillFrontmatter([
    '---', 'name: n', 'description: d', 'license: Apache-2.0', 'compatibility: ">=1.0"',
    'brand-new-field: kept', '---', 'body',
  ].join('\n'))
  assert.equal(metadata.name, 'n')
  assert.equal(metadata.license, 'Apache-2.0')
  assert.equal(metadata['brand-new-field'], 'kept')
})
