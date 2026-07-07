/**
 * P3-1 — neutral-directory skill discovery (~/.agents/skills), suggest-import model.
 * 母合同 §4 T6 + P3 §1: read-only scan, never auto-imports; surfaces candidates for the user
 * to import by consent. Only direct subdirs with a valid SKILL.md (frontmatter name+description)
 * count; symlinks are de-duped by realpath; alreadyImported reflects the current skill set.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listExternalSkillCandidates } from '../main/modules/skills-runtime/external-skill-discovery'

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'p31-home-'))
  const skillsDir = join(home, '.agents', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  // valid candidate
  mkdirSync(join(skillsDir, 'my-clipper'))
  writeFileSync(join(skillsDir, 'my-clipper', 'SKILL.md'), skillMd('my-clipper', '网页剪藏方法论'))
  // no SKILL.md → ignored
  mkdirSync(join(skillsDir, 'not-a-skill'))
  writeFileSync(join(skillsDir, 'not-a-skill', 'readme.txt'), 'nope')
  // already imported (id collides with an existing skill)
  mkdirSync(join(skillsDir, 'dupe'))
  writeFileSync(join(skillsDir, 'dupe', 'SKILL.md'), skillMd('deep-research', '和内置技能同 id'))
  // symlink pointing at the valid candidate → must de-dupe by realpath
  try {
    symlinkSync(join(skillsDir, 'my-clipper'), join(skillsDir, 'my-clipper-link'), 'dir')
  } catch {
    // some CI filesystems disallow symlinks; the dedup assertion tolerates its absence
  }
  return home
}

test('listExternalSkillCandidates: valid SKILL.md dirs only, realpath-deduped, alreadyImported flagged', () => {
  const home = makeHome()
  try {
    const candidates = listExternalSkillCandidates({
      homeDir: home,
      existingSkillIds: new Set(['deep-research']),
    })
    const byName = new Map(candidates.map((c) => [c.name, c]))
    assert.ok(byName.has('my-clipper'), 'valid SKILL.md dir must be a candidate')
    assert.equal(byName.get('my-clipper')?.description, '网页剪藏方法论')
    assert.equal(byName.get('my-clipper')?.source, 'user_agents_dir')
    assert.equal(byName.get('my-clipper')?.alreadyImported, false)
    assert.ok(!candidates.some((c) => c.name === 'not-a-skill'), 'dir without SKILL.md is skipped')
    assert.equal(byName.get('deep-research')?.alreadyImported, true, 'id colliding with an existing skill → alreadyImported')
    // realpath dedup: my-clipper and its symlink resolve to the same target → one entry
    assert.equal(candidates.filter((c) => c.name === 'my-clipper').length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('listExternalSkillCandidates: missing ~/.agents/skills → [] (no noise, read-only)', () => {
  const home = mkdtempSync(join(tmpdir(), 'p31-empty-'))
  try {
    assert.deepEqual(listExternalSkillCandidates({ homeDir: home, existingSkillIds: new Set() }), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
