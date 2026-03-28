import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import {
  buildAgentTaskBlocker,
  buildInputBlocker,
  collectSourceMaterials,
  resolveMissingInputs,
} from '../main/modules/skills-runtime/next-action-resolver'

const ROOT = '/Users/user/Documents/ready-cowork/assets/embedded-skills'

describe('skill resolver smoke', () => {
  it('blocks workflow steps when required inputs are missing', () => {
    const definition = compileSkillDefinition({
      folderPath: join(ROOT, 'video-copy-analyzer'),
      source: 'embedded',
    })
    const step = definition.workflow?.steps.find((item) => item.id === 'prepare_input')
    assert.ok(step)

    const missing = resolveMissingInputs({
      id: 'exec-1',
      skillId: definition.id,
      entryAction: definition.defaultAction || 'video_copy_analyze',
      source: definition.source,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentStepId: 'prepare_input',
      compiledSkill: definition,
      blocker: null,
      lastFrame: null,
      errors: [],
      stepOutputs: {},
      confirmations: {},
      inputs: {},
    }, step!)

    assert.deepStrictEqual(missing, ['input'])
    const blocker = buildInputBlocker({
      id: 'exec-1',
      skillId: definition.id,
      entryAction: definition.defaultAction || 'video_copy_analyze',
      source: definition.source,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentStepId: 'prepare_input',
      compiledSkill: definition,
      blocker: null,
      lastFrame: null,
      errors: [],
      stepOutputs: {},
      confirmations: {},
      inputs: {},
    }, step!, ['input'])

    assert.strictEqual(blocker.blocker.type, 'need_input')
  })

  it('injects readable source materials for agent_task blockers', () => {
    const definition = compileSkillDefinition({
      folderPath: join(ROOT, 'video-copy-analyzer'),
      source: 'embedded',
    })
    const step = definition.workflow?.steps.find((item) => item.id === 'write_analysis_report')
    assert.ok(step)

    const dir = mkdtempSync(join(tmpdir(), 'ready-skill-source-'))
    const transcriptPath = join(dir, 'corrected_transcript.md')
    writeFileSync(transcriptPath, '# Corrected\n\nHello world transcript\n', 'utf-8')

    const state = {
      id: 'exec-2',
      skillId: definition.id,
      entryAction: definition.defaultAction || 'video_copy_analyze',
      source: definition.source,
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentStepId: 'write_analysis_report',
      compiledSkill: definition,
      blocker: null,
      lastFrame: null,
      errors: [],
      stepOutputs: {
        correct_transcript: {
          correctedTranscriptPath: transcriptPath,
        },
      },
      confirmations: {},
      inputs: {
        input: 'demo.mp4',
      },
    }

    const materials = collectSourceMaterials(state)
    assert.strictEqual(materials.length, 1)
    assert.match(materials[0]?.content || '', /Hello world transcript/)

    const blocker = buildAgentTaskBlocker(state, step!)
    assert.strictEqual(blocker.blocker.type, 'need_agent_result')
    assert.match(blocker.blocker.agentTask?.prompt || '', /Source Materials:/)
    assert.match(blocker.blocker.agentTask?.prompt || '', /Hello world transcript/)
  })
})
