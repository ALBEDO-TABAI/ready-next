import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

describe('skill compiler smoke', () => {

  it('falls back to advisory read_skill for README-only custom skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ready-skill-readme-'))
    writeFileSync(join(dir, 'README.md'), '# Demo Skill\n\nUse this skill to review drafts.\n', 'utf-8')

    const definition = compileSkillDefinition({
      folderPath: dir,
      source: 'custom',
    })

    assert.strictEqual(definition.executionMode, 'advisory')
    assert.strictEqual(definition.actions[0]?.name, 'read_skill')
    assert.strictEqual(definition.actions[0]?.visibility, 'internal')
  })

  it('normalizes legacy public reference read_skill actions to internal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ready-skill-ref-public-'))
    writeFileSync(join(dir, 'SKILL.md'), '# Demo Skill\n\nUse this skill to review drafts.\n', 'utf-8')
    writeFileSync(join(dir, 'ready-skill.json'), JSON.stringify({
      id: 'legacy-public-read-skill',
      name: 'Legacy Public Read Skill',
      runtime: 'reference',
      defaultAction: 'read_skill',
      actions: [
        {
          name: 'read_skill',
          runtime: 'reference',
          entry: 'SKILL.md',
          visibility: 'public',
        },
      ],
    }, null, 2), 'utf-8')

    const definition = compileSkillDefinition({
      folderPath: dir,
      source: 'custom',
    })

    assert.strictEqual(definition.executionMode, 'advisory')
    assert.strictEqual(definition.actions[0]?.name, 'read_skill')
    assert.strictEqual(definition.actions[0]?.visibility, 'internal')
  })

  it('compiles custom workflow skills when workflow contract is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ready-skill-workflow-'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'echo.py'), 'print("ok")\n', 'utf-8')
    writeFileSync(join(dir, 'ready-skill.json'), JSON.stringify({
      id: 'demo-custom-workflow',
      name: 'Demo Custom Workflow',
      defaultAction: 'demo_run',
      execution: {
        mode: 'workflow',
        workflowFile: 'skill.workflow.json',
        autoAdvance: true,
      },
      actions: [
        {
          name: 'demo_run',
          description: 'Run demo workflow',
          runtime: 'python',
          entry: 'scripts/echo.py',
          visibility: 'public',
          inputMode: 'json',
          params: [{ name: 'topic', type: 'string', description: 'topic', required: false }],
        },
        {
          name: 'demo_internal',
          description: 'internal',
          runtime: 'python',
          entry: 'scripts/echo.py',
          visibility: 'internal',
          inputMode: 'json',
          params: [],
        },
      ],
    }, null, 2), 'utf-8')
    writeFileSync(join(dir, 'skill.workflow.json'), JSON.stringify({
      version: '1',
      autoAdvance: true,
      initialStep: 'run',
      steps: [
        {
          id: 'run',
          name: 'Run',
          description: 'run',
          action: {
            type: 'runtime_call',
            actionName: 'demo_internal',
            args: {},
          },
        },
      ],
    }, null, 2), 'utf-8')

    const definition = compileSkillDefinition({
      folderPath: dir,
      source: 'custom',
    })

    assert.strictEqual(definition.executionMode, 'workflow')
    assert.strictEqual(definition.workflow?.steps[0]?.id, 'run')
  })
})
