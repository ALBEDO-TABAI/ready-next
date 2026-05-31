/**
 * Regression — a reference skill (SKILL.md, no JSON manifest) must derive its
 * id/name from the SKILL.md YAML frontmatter `name:`/`id:`, NOT from the folder
 * basename.
 *
 * Bug: the remote-install pipeline hands `loadCustomSkillManifestFromFolder` a
 * staging directory named `extract`, `<repo>-<sha>`, or a request UUID (see
 * `locateSkillRoot` in skill-source-fetcher.ts). The reference branch did
 * `id: slugify(basename(folderPath))`, so a perfectly-named skill like
 * `video-expert-analyzer` registered under a garbage id such as
 * `a1b2c3d4-uuid` or `extract`. The frontmatter `name:` — the canonical
 * kebab-case id every embedded skill uses — was ignored.
 *
 * Fix: parse the SKILL.md frontmatter and prefer `id:` → slug(`name:`) over the
 * folder basename. These tests drive the real loader with a staging-style
 * folder name and assert the id/name come from the frontmatter.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCustomSkillManifestFromFolder } from '../main/modules/skills-runtime/custom-skill-registry'

// Build a folder with the given basename (simulating a staging dir) under a
// temp root, write SKILL.md into it, run the body, then clean up.
function withStagingSkill(
  folderBasename: string,
  skillMd: string,
  body: (folderPath: string) => void,
): void {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'custom-skill-id-')))
  try {
    const folderPath = join(root, folderBasename)
    mkdirSync(folderPath, { recursive: true })
    writeFileSync(join(folderPath, 'SKILL.md'), skillMd, 'utf-8')
    body(folderPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('reference id comes from SKILL.md frontmatter name, not the staging folder UUID', () => {
  const skillMd = [
    '---',
    'name: video-expert-analyzer',
    'description: Advanced video analysis and selection skill.',
    '---',
    '',
    '# Video Expert Analyzer',
    'body',
  ].join('\n')
  // A request-UUID-style staging basename — exactly what the install pipeline hands in.
  withStagingSkill('3f0c9b8a-7d21-4e6f-9a11-deadbeefcafe', skillMd, (folderPath) => {
    const manifest = loadCustomSkillManifestFromFolder(folderPath)
    assert.equal(manifest.id, 'video-expert-analyzer', 'id must derive from frontmatter name')
    assert.equal(manifest.name, 'video-expert-analyzer', 'display name must derive from frontmatter name')
    assert.equal(manifest.runtime, 'reference')
  })
})

test('reference id prefers an explicit frontmatter id over the slugified name', () => {
  const skillMd = [
    '---',
    'id: guizang-ppt',
    'name: Guizang PPT Skill',
    '---',
    '# heading',
    'body',
  ].join('\n')
  withStagingSkill('extract', skillMd, (folderPath) => {
    const manifest = loadCustomSkillManifestFromFolder(folderPath)
    assert.equal(manifest.id, 'guizang-ppt', 'explicit frontmatter id wins')
    assert.equal(manifest.name, 'Guizang PPT Skill', 'display name keeps the human-readable frontmatter name')
  })
})

test('a CJK-only frontmatter name falls back to the folder basename slug, not the generic default', () => {
  const skillMd = ['---', 'name: 视频专家', '---', '# heading', 'body'].join('\n')
  // No ASCII slug from the name, no explicit id → must use the (meaningful) folder slug.
  withStagingSkill('My Cool Skill', skillMd, (folderPath) => {
    const manifest = loadCustomSkillManifestFromFolder(folderPath)
    assert.equal(manifest.id, 'my-cool-skill', 'degenerate name slug must not short-circuit to custom-skill')
    assert.equal(manifest.name, '视频专家', 'display name still honors the frontmatter name')
  })
})

test('a SKILL.md with no frontmatter still falls back to the folder basename (no regression)', () => {
  withStagingSkill('legacy-folder-skill', '# just a heading\nno frontmatter here', (folderPath) => {
    const manifest = loadCustomSkillManifestFromFolder(folderPath)
    assert.equal(manifest.id, 'legacy-folder-skill', 'no-frontmatter SKILL.md keeps the prior folder-slug behavior')
    assert.equal(manifest.name, 'legacy-folder-skill')
  })
})
