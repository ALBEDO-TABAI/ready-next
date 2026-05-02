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

test('SkillsRuntimeManager refreshes same-version embedded copies when source content changed', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ready-embedded-managed-sync-same-version-'))
  const embeddedRoot = join(tempRoot, 'embedded-skills')
  const runtimeRoot = join(tempRoot, 'runtime')
  const sourceSkill = join(embeddedRoot, 'video-expert-analyzer')
  const managedSkill = join(runtimeRoot, 'skills', 'video-expert-analyzer')
  const version = '2026.04.23-vnext'

  try {
    mkdirSync(sourceSkill, { recursive: true })
    writeFileSync(
      join(sourceSkill, 'ready-skill.json'),
      JSON.stringify({
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: 'fresh vnext source',
        version,
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
    writeFileSync(join(sourceSkill, 'SKILL.md'), '# Fresh VNext\nstructured result support', 'utf8')
    mkdirSync(join(sourceSkill, 'scripts'), { recursive: true })
    writeFileSync(join(sourceSkill, 'scripts', 'ready_compat.py'), 'print("fresh")\n', 'utf8')

    mkdirSync(managedSkill, { recursive: true })
    writeFileSync(join(managedSkill, 'SKILL.md'), '# Old same-version skill', 'utf8')
    mkdirSync(join(managedSkill, 'scripts'), { recursive: true })
    writeFileSync(join(managedSkill, 'scripts', 'ready_compat.py'), 'print("old")\n', 'utf8')
    writeFileSync(
      join(managedSkill, 'ready-skill.json'),
      JSON.stringify({ id: 'video-expert-analyzer', version }),
      'utf8',
    )
    writeFileSync(join(managedSkill, '.ready-embedded-sync-state.json'), JSON.stringify({ version }), 'utf8')

    const manager = new SkillsRuntimeManager({
      runtimeRoot,
      embeddedSkillsRoot: embeddedRoot,
      startBackgroundTasks: false,
    })

    manager.listSkills()

    assert.equal(readFileSync(join(managedSkill, 'SKILL.md'), 'utf8'), '# Fresh VNext\nstructured result support')
    assert.equal(readFileSync(join(managedSkill, 'scripts', 'ready_compat.py'), 'utf8'), 'print("fresh")\n')
    const state = JSON.parse(readFileSync(join(managedSkill, '.ready-embedded-sync-state.json'), 'utf8'))
    assert.equal(typeof state.sourceHash, 'string')
    assert.ok(state.sourceHash.length > 10)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('runSkill surfaces install failure details instead of reporting a known skill as unknown', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ready-skill-install-failure-'))
  const embeddedRoot = join(tempRoot, 'embedded-skills')
  const runtimeRoot = join(tempRoot, 'runtime')

  try {
    mkdirSync(embeddedRoot, { recursive: true })
    const manager = new SkillsRuntimeManager({
      runtimeRoot,
      embeddedSkillsRoot: embeddedRoot,
      startBackgroundTasks: false,
    })
    const patched = manager as unknown as {
      ensureSkillInstalled: () => Promise<{
        success: false
        skillId: string
        skillPath: string
        error: string
      }>
    }
    patched.ensureSkillInstalled = async () => ({
      success: false,
      skillId: 'video-expert-analyzer',
      skillPath: join(runtimeRoot, 'skills', 'video-expert-analyzer'),
      error: 'pip failed: rapidocr-onnxruntime is not installable on this Python',
    })

    const result = await manager.runSkill({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      params: { url: 'https://example.test/video' },
    })

    assert.equal(result.success, false)
    assert.match(result.error || '', /install failed/i)
    assert.match(result.error || '', /rapidocr-onnxruntime/)
    assert.doesNotMatch(result.error || '', /^Unknown skill: video-expert-analyzer$/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
