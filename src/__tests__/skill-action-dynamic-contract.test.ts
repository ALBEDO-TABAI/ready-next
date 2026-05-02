/**
 * Phase 2.5 PR 12 — dynamic skill-action Zod schema wiring contract.
 *
 * Source-level regex asserts on skills-tools.ts + tool-executor.ts because the
 * runtime path pulls skills-runtime-manager which imports electron.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tool-registry'
import { getToolInputSchemas } from '../main/modules/tools/schemas'
import {
  STATIC_SKILL_ACTIONS_BY_TOOL_NAME,
  STATIC_SKILL_TOOL_NAMES,
} from '../main/modules/tools/skills-tools-static'

const RESERVED_CONTROL_TOOL_NAMES = [
  'skill_get_state',
  'skill_submit_input',
  'skill_submit_confirmation',
  'skill_submit_agent_result',
  'skill_restart_from_step',
  'skill_cancel_execution',
] as const

test('single execution schema resolver validates static skill actions and primitives', () => {
  const pipeline = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  assert.ok(pipeline, 'resolver must expose VEA pipeline input schema')
  assert.equal(pipeline.safeParse({}).success, false, 'VEA pipeline requires input')

  const readArtifact = resolveToolInputSchemaForExecution('skill_read_artifact')
  assert.ok(readArtifact, 'resolver must expose primitive input schema')
  assert.strictEqual(readArtifact, getToolInputSchemas().skill_read_artifact)
  assert.equal(readArtifact.safeParse({}).success, false, 'read artifact requires relativePath')
})

test('single execution schema resolver keeps static schemas stable across calls', () => {
  const first = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  const second = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  assert.ok(first && second)
  assert.strictEqual(first, second)
  assert.equal(resolveToolInputSchemaForExecution('skill_made_up_action'), null)
})

test('static skill action aliases never expose reserved execution-control tool names', () => {
  const advertisedNames = new Set([
    ...STATIC_SKILL_TOOL_NAMES,
    ...Object.keys(STATIC_SKILL_ACTIONS_BY_TOOL_NAME),
  ])
  for (const reserved of RESERVED_CONTROL_TOOL_NAMES) {
    assert.equal(advertisedNames.has(reserved), false, `${reserved} must not be advertised`)
  }
})
