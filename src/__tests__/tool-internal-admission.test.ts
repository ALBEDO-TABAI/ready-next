import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ToolGateway } from '../main/modules/agent-control/tool-gateway'
import {
  executeSkillActionViaToolGateway,
} from '../main/modules/agent-control/tool-registry'
import {
  isChildInternalStrictAdmissionEnabled,
} from '../main/modules/agent-control/tool-definition'
import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'

function makeSkillResult(request: SkillRunRequest): SkillRunResult {
  return {
    success: true,
    skillId: request.skillId,
    action: request.action,
    stdout: 'ok',
    stderr: '',
    outputDir: '/tmp/child-output',
    outputs: {},
    command: ['fake'],
    status: 'done',
  }
}

function makeRuntimeManager(onRun?: (request: SkillRunRequest) => void): SkillsRuntimeManager {
  return {
    runSkillFromChildRunner: async (request: SkillRunRequest) => {
      onRun?.(request)
      return makeSkillResult(request)
    },
    runSkill: async (request: SkillRunRequest) => {
      onRun?.(request)
      return makeSkillResult(request)
    },
  } as unknown as SkillsRuntimeManager
}

function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

function gatewayFunctionSource(): string {
  const source = readFileSync(
    new URL('../main/modules/agent-control/tool-registry.ts', import.meta.url),
    'utf-8',
  )
  const start = source.indexOf('export async function executeSkillActionViaToolGateway')
  const end = source.indexOf('\nfunction makeChildGatewayError', start)
  assert.ok(start >= 0 && end > start, 'expected executeSkillActionViaToolGateway source')
  return stripTsComments(source.slice(start, end))
}

function toolExecutorSource(): string {
  return stripTsComments(readFileSync(
    new URL('../main/modules/tools/tool-executor.ts', import.meta.url),
    'utf-8',
  ))
}

test('child internal action without ToolDefinition returns tool_not_registered', async () => {
  let runtimeCalls = 0
  const result = await executeSkillActionViaToolGateway({
    skillId: 'not-registered-skill',
    action: 'hidden_action',
    input: {},
    childRunId: 'child-missing-definition',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    outputDir: null,
    runStatePath: null,
    childInternal: true,
    runtimeManager: makeRuntimeManager(() => { runtimeCalls += 1 }),
  })

  assert.equal(runtimeCalls, 0)
  assert.equal(result.skillRunResult, null)
  assert.equal(result.data?.errorKind, 'host_unavailable')
  assert.equal(result.data?.reason, 'tool_not_registered')
})

test('child internal action with invalid args returns input_validation', async () => {
  let runtimeCalls = 0
  const result = await executeSkillActionViaToolGateway({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    input: {},
    childRunId: 'child-invalid-input',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    outputDir: null,
    runStatePath: null,
    childInternal: true,
    runtimeManager: makeRuntimeManager(() => { runtimeCalls += 1 }),
  })

  assert.equal(runtimeCalls, 0)
  assert.equal(result.skillRunResult, null)
  assert.equal(result.data?.errorKind, 'input_validation')
})

test('child internal action dispatches through executeToolCall', async () => {
  const source = gatewayFunctionSource()
  assert.match(source, /executeToolCall\(/)
  assert.doesNotMatch(source, /runSkillFromChildRunner/)
  assert.doesNotMatch(source, /\.runSkill\(/)

  let request: SkillRunRequest | null = null
  const result = await executeSkillActionViaToolGateway({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    input: { url: 'https://example.test/video' },
    childRunId: 'child-dispatch',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    outputDir: '/tmp/child-output',
    runStatePath: '/tmp/child-output/run_state.json',
    childInternal: true,
    runtimeManager: makeRuntimeManager((next) => { request = next }),
  })

  assert.ok(request, 'expected child runtime dispatch')
  assert.equal(request.skillId, 'video-expert-analyzer')
  assert.equal(request.action, 'video_expert_pipeline')
  assert.deepEqual(request.params?.__childRunContext, {
    childRunId: 'child-dispatch',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    outputDir: '/tmp/child-output',
    runStatePath: '/tmp/child-output/run_state.json',
  })
  assert.equal(result.skillRunResult?.success, true)
  assert.equal(result.data?.ok, true)
})

test('strict internal admission flag defaults enabled', () => {
  assert.equal(isChildInternalStrictAdmissionEnabled({}), true)
  assert.equal(isChildInternalStrictAdmissionEnabled({
    READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION: undefined,
  }), true)
})

test('executeToolCall rejects internal tools unless child internal context is allowed', () => {
  const source = toolExecutorSource()

  assert.match(source, /context\.allowInternal/)
  assert.match(source, /context\.invoker\s*===\s*'child_runner'/)
  assert.match(source, /internal_tool_not_allowed/)
})

test('public model surface does not expose internal VEA actions without hint', () => {
  const gateway = new ToolGateway()
  const names = gateway.getOpenAIToolsForGroups(['skills'], 'no-vea-hint')
    .map((tool) => (tool.function as { name?: string } | undefined)?.name || '')
    .filter(Boolean)

  assert.equal(names.includes('skill_video_expert_pipeline'), false)
  assert.equal(gateway.getToolDefinition('skill_video_expert_pipeline'), null)
  assert.equal(
    gateway.listToolDefinitions().some((tool) => tool.name === 'skill_video_expert_pipeline'),
    false,
  )
})
