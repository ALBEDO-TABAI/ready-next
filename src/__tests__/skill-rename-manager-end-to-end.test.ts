/**
 * Regression — renaming a custom skill via the manager must surface the new
 * display name both in the returned SkillState AND in a fresh listSkills().
 *
 * Bug: the edit dialog reported "saved" but the skill name did not update.
 * This drives the real SkillsRuntimeManager: import a SKILL.md-only skill,
 * rename it, and assert the new name flows through
 * updateCustomSkillDescription → loadSkill → compileSkillDefinition → toSkillState.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-rename-manager-end-to-end declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-rename-manager-end-to-end transitive sqlite load')
})

function scratch(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

function makeManager(): { manager: SkillsRuntimeManager; cleanup: () => void } {
  const runtimeRoot = scratch('ready-rename-rt-')
  const embeddedRoot = scratch('ready-rename-embedded-')
  return {
    manager: new SkillsRuntimeManager({ runtimeRoot, embeddedSkillsRoot: embeddedRoot, startBackgroundTasks: false }),
    cleanup: () => {
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(embeddedRoot, { recursive: true, force: true })
    },
  }
}

test('manager rename surfaces the new name in the returned state and in listSkills', () => {
  const { manager, cleanup } = makeManager()
  const sourceRoot = scratch('ready-rename-src-')
  try {
    const source = join(sourceRoot, 'extract')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), ['---', 'name: extract', '---', '# extract', 'advisory'].join('\n'), 'utf-8')

    const installed = manager.importCustomSkill(source)
    assert.equal(installed.id, 'extract')
    assert.equal(installed.name, 'extract', 'precondition: imported name is "extract"')

    // Populate any lazy cache the way the panel does at mount (listSkills before edit).
    // If a stale cache were the bug, the post-rename listSkills below would return "extract".
    const before = manager.listSkills().find((s) => s.id === 'extract')
    assert.equal(before?.name, 'extract', 'precondition: a pre-rename listSkills shows the old name')

    const renamed = manager.updateCustomSkillDescription('extract', '横向翻页网页 PPT 生成器', '横向翻页 PPT')
    assert.equal(renamed.name, '横向翻页 PPT', 'updateCustomSkillDescription must return the new display name')
    assert.equal(renamed.id, 'extract', 'id stays stable')

    const listed = manager.listSkills().find((s) => s.id === 'extract')
    assert.equal(listed?.name, '横向翻页 PPT', 'a fresh listSkills() must reflect the rename')
  } finally {
    cleanup()
    rmSync(sourceRoot, { recursive: true, force: true })
  }
})
