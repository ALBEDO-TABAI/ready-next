/**
 * Behavior — a custom skill's display `name` can be renamed in place. The
 * rename updates the persisted managed manifest's `name` while keeping the `id`
 * (and therefore the managed folder, `skill_<id>_*` tool names, and any persisted
 * references) stable. A blank/omitted name is a no-op so the field can't be wiped.
 *
 * Motivation: pre-fix installs landed under a garbage id/name (e.g. `extract`,
 * the staging wrapper folder). Renaming lets the user fix the display name
 * without reinstalling or moving folders.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  importCustomSkillFolder,
  updateManagedCustomSkillDescription,
  getManagedCustomSkill,
} from '../main/modules/skills-runtime/custom-skill-registry'

// Install a SKILL.md-only reference skill (named `extract`, mirroring a pre-fix
// install) into a fresh managed root, then run the body with the root + id.
function withInstalledSkill(body: (customSkillsRoot: string, skillId: string) => void): void {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'custom-skill-rename-')))
  try {
    const source = join(root, 'source', 'extract')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), ['---', 'name: extract', '---', '# extract', 'advisory'].join('\n'), 'utf-8')
    const customSkillsRoot = join(root, 'managed')
    const installed = importCustomSkillFolder(source, customSkillsRoot)
    assert.equal(installed.id, 'extract', 'precondition: skill installs under id "extract"')
    body(customSkillsRoot, installed.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('renaming updates the display name while keeping id, folder, and description', () => {
  withInstalledSkill((customSkillsRoot, skillId) => {
    const renamed = updateManagedCustomSkillDescription(customSkillsRoot, skillId, '横向翻页网页 PPT 生成器', '横向翻页 PPT')

    assert.equal(renamed.name, '横向翻页 PPT', 'display name reflects the new name')
    assert.equal(renamed.id, 'extract', 'id stays stable — rename never re-keys the skill')
    assert.equal(renamed.description, '横向翻页网页 PPT 生成器', 'description is updated in the same save')
    assert.equal(renamed.managedPath, join(customSkillsRoot, 'extract'), 'managed folder is not moved')

    // The new name persists and no second folder was created.
    const reread = getManagedCustomSkill(customSkillsRoot, 'extract')
    assert.equal(reread?.name, '横向翻页 PPT', 'rename persists across a fresh read')
    assert.deepEqual(readdirSync(customSkillsRoot).sort(), ['extract'], 'exactly one managed folder, still keyed by id')
    assert.ok(existsSync(join(customSkillsRoot, 'extract')), 'the original id-keyed folder still exists')
  })
})

test('an omitted name leaves the existing name untouched (description-only update still works)', () => {
  withInstalledSkill((customSkillsRoot, skillId) => {
    const updated = updateManagedCustomSkillDescription(customSkillsRoot, skillId, '只改说明')
    assert.equal(updated.name, 'extract', 'name unchanged when no name is supplied')
    assert.equal(updated.description, '只改说明')
  })
})

test('a blank/whitespace name is treated as no-change and cannot wipe the name', () => {
  withInstalledSkill((customSkillsRoot, skillId) => {
    const updated = updateManagedCustomSkillDescription(customSkillsRoot, skillId, 'desc', '   ')
    assert.equal(updated.name, 'extract', 'whitespace-only name must not blank out the display name')
  })
})
