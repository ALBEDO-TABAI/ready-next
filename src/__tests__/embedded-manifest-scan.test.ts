/**
 * P2-3 — embedded skill manifest is a directory SCAN, not a hardcoded union.
 * 母合同 2026-07-06 §4 T5：SKILL.md-only 全域一等公民；EmbeddedSkillId union 退役。
 *
 * buildEmbeddedSkillManifests(rootDir) 从 assets/embedded-skills/* 扫描：
 *   - ready-skill.json 目录 → id/displayName||name/description/version
 *   - 仅 SKILL.md 目录 → id=目录名，name/description 取 frontmatter（drop-in 合同）
 *   - 坏/无 frontmatter 且无 json → 跳过并 console.warn（容忍性，不 throw）
 *   - 输出按目录名排序（确定性）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildEmbeddedSkillManifests,
  EMBEDDED_SKILLS,
  EMBEDDED_SKILL_IDS,
  getEmbeddedSkillManifest,
} from '../main/modules/skills-runtime/manifest'
import { parseSkillFrontmatter } from '../main/modules/skills-runtime/skill-frontmatter'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'p23-scan-'))
  // (a) ready-skill.json-backed skill
  mkdirSync(join(root, 'json-skill'))
  writeFileSync(join(root, 'json-skill', 'ready-skill.json'), JSON.stringify({
    id: 'json-skill', displayName: 'JSON 技能', description: '来自 ready-skill.json 的描述', version: '3.1.4',
  }))
  writeFileSync(join(root, 'json-skill', 'SKILL.md'), '---\nname: json-skill\ndescription: md desc\n---\n# body')
  // (b) SKILL.md-only skill (the drop-in case)
  mkdirSync(join(root, 'md-only-skill'))
  writeFileSync(join(root, 'md-only-skill', 'SKILL.md'), '---\nname: md-only-skill\ndescription: 仅 SKILL.md 的方法论技能\n---\n# body')
  // (c) broken: no json, no parseable frontmatter → skipped
  mkdirSync(join(root, 'broken-skill'))
  writeFileSync(join(root, 'broken-skill', 'SKILL.md'), '# no frontmatter here\njust text')
  // a stray file (not a dir) must be ignored
  writeFileSync(join(root, 'stray.txt'), 'x')
  return root
}

test('buildEmbeddedSkillManifests scans json + md-only dirs, skips broken, sorts deterministically', () => {
  const root = makeRoot()
  try {
    const manifests = buildEmbeddedSkillManifests(root)
    const ids = manifests.map((m) => m.id)
    assert.deepEqual(ids, ['json-skill', 'md-only-skill'], 'broken-skill skipped; sorted by dir name')

    const jsonSkill = manifests.find((m) => m.id === 'json-skill')!
    assert.equal(jsonSkill.name, 'JSON 技能', 'name = displayName from ready-skill.json')
    assert.equal(jsonSkill.description, '来自 ready-skill.json 的描述')
    assert.equal(jsonSkill.version, '3.1.4')
    assert.equal(jsonSkill.requirementsFile, 'requirements.txt')

    // drop-in contract: a SKILL.md-only dir is a full first-class manifest, zero source edits.
    const mdOnly = manifests.find((m) => m.id === 'md-only-skill')!
    assert.equal(mdOnly.name, 'md-only-skill')
    assert.equal(mdOnly.description, '仅 SKILL.md 的方法论技能')
    assert.equal(mdOnly.version, '0.0.0', 'no json + no metadata.version → 0.0.0 fallback')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildEmbeddedSkillManifests: missing root dir → [] (boot-safe, no throw)', () => {
  assert.deepEqual(buildEmbeddedSkillManifests(join(tmpdir(), 'p23-does-not-exist-xyz')), [])
})

test('EMBEDDED_SKILLS (production scan) still exposes the array shape + known ids', () => {
  assert.ok(Array.isArray(EMBEDDED_SKILLS) && EMBEDDED_SKILLS.length > 0)
  const ids = new Set(EMBEDDED_SKILLS.map((m) => m.id))
  for (const id of ['ready-human-touch-ppt', 'ready-human-touch-card', 'deep-research', 'video-expert-analyzer']) {
    assert.ok(ids.has(id), `EMBEDDED_SKILLS must include ${id}`)
    assert.ok(EMBEDDED_SKILL_IDS.has(id))
    assert.equal(getEmbeddedSkillManifest(id)?.id, id)
  }
  for (const m of EMBEDDED_SKILLS) {
    assert.ok(m.id && m.name && typeof m.description === 'string' && m.version && m.requirementsFile === 'requirements.txt',
      `manifest for ${m.id} must have all fields`)
  }
})

test('parseSkillFrontmatter extracts flat key:value metadata + body', () => {
  const { metadata, body } = parseSkillFrontmatter('---\nname: foo\ndescription: bar baz\n---\n# heading\ntext')
  assert.equal(metadata.name, 'foo')
  assert.equal(metadata.description, 'bar baz')
  assert.ok(body.includes('# heading'))
  // no frontmatter → empty metadata, whole text is body
  const none = parseSkillFrontmatter('# no frontmatter')
  assert.deepEqual(none.metadata, {})
  assert.ok(none.body.includes('# no frontmatter'))
})
