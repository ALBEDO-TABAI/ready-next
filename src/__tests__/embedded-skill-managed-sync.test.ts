import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'

test('SkillsRuntimeManager refreshes stale embedded managed copies before listing skills', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ready-embedded-managed-sync-'))
  const embeddedRoot = join(tempRoot, 'embedded-skills')
  const runtimeRoot = join(tempRoot, 'runtime')
  const sourceSkill = join(embeddedRoot, 'video-expert-analyzer')
  const managedSkill = join(runtimeRoot, 'skills', 'video-expert-analyzer')

  try {
    mkdirSync(sourceSkill, { recursive: true })
    writeFileSync(
      join(sourceSkill, 'ready-skill.json'),
      JSON.stringify({
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: 'fresh vnext source',
        version: '2026.04.23-vnext',
        defaultAction: 'read_skill',
        execution: { mode: 'advisory' },
        actions: [
          {
            name: 'read_skill',
            runtime: 'reference',
            entry: 'SKILL.md',
            visibility: 'internal',
            params: [],
          },
        ],
      }),
      'utf8',
    )
    writeFileSync(join(sourceSkill, 'SKILL.md'), '# Fresh VNext\norchestrate_vnext', 'utf8')

    mkdirSync(managedSkill, { recursive: true })
    writeFileSync(join(managedSkill, 'SKILL.md'), '# Old workflow skill', 'utf8')
    writeFileSync(join(managedSkill, 'skill.workflow.json'), '{"version":"old"}', 'utf8')
    writeFileSync(join(managedSkill, '.ready-embedded-sync-state.json'), '{"version":"old"}', 'utf8')

    const manager = new SkillsRuntimeManager({
      runtimeRoot,
      embeddedSkillsRoot: embeddedRoot,
      startBackgroundTasks: false,
    })

    const skills = manager.listSkills()

    assert.equal(skills.some((skill) => skill.id === 'video-expert-analyzer'), true)
    assert.equal(readFileSync(join(managedSkill, 'SKILL.md'), 'utf8'), '# Fresh VNext\norchestrate_vnext')
    assert.equal(existsSync(join(managedSkill, 'skill.workflow.json')), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
