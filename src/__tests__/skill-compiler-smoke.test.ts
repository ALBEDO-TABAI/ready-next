import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

const ROOT = '/Users/user/Documents/ready-cowork/assets/embedded-skills'

describe('skill compiler smoke', () => {
  it('compiles workflow embedded skills with internal/public action visibility', () => {
    const definition = compileSkillDefinition({
      folderPath: join(ROOT, 'video-copy-analyzer'),
      source: 'embedded',
    })

    assert.strictEqual(definition.executionMode, 'workflow')
    assert.strictEqual(definition.defaultAction, 'video_copy_analyze')
    assert.ok(definition.workflow)
    assert.strictEqual(definition.workflow?.initialStep, 'prepare_input')
    assert.ok(definition.actions.some((action) => action.name === 'video_copy_analyze' && action.visibility === 'public'))
    assert.ok(definition.actions.some((action) => action.name === 'video_copy_extract_subtitle' && action.visibility === 'internal'))
  })

  it('keeps lets-go-rss as advisory/direct utility surface', () => {
    const definition = compileSkillDefinition({
      folderPath: join(ROOT, 'lets-go-rss'),
      source: 'embedded',
    })

    assert.strictEqual(definition.executionMode, 'advisory')
    assert.strictEqual(definition.defaultAction, 'rss_update')
    assert.strictEqual(definition.workflow, undefined)
    assert.ok(definition.actions.every((action) => action.visibility !== 'internal'))
  })

  it('falls back to advisory read_skill for README-only custom skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ready-skill-readme-'))
    writeFileSync(join(dir, 'README.md'), '# Demo Skill\n\nUse this skill to review drafts.\n', 'utf-8')

    const definition = compileSkillDefinition({
      folderPath: dir,
      source: 'custom',
    })

    assert.strictEqual(definition.executionMode, 'advisory')
    assert.strictEqual(definition.actions[0]?.name, 'read_skill')
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
