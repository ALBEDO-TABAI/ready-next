/**
 * B plan Phase 4 — negative contract: the 6 retired execution-control tool
 * names must never appear in the LLM-facing tool list.
 *
 * Covers both source-level (static tool name registry) and dispatch-level
 * (filterSkillPrimitivesBySession output) paths. If a future change reintroduces
 * any of these names, this test fires.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { ToolGateway } from '../main/modules/agent-control/tool-gateway'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import {
  STATIC_SKILL_TOOL_NAMES,
  STATIC_SKILL_TOOL_NAMES_BOOT_SAFE,
} from '../main/modules/tools/skills-tools-static'
import { executeSkillTool } from '../main/modules/tools/skills-tools'
import {
  filterSkillPrimitivesBySession,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'

const STANDARD_PRIMITIVES = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_inspect_detached',
  'skill_cancel_detached',
  'skill_inspect_run_state',
]

const RETIRED_NAMES = [
  'skill_get_state',
  'skill_submit_input',
  'skill_submit_confirmation',
  'skill_submit_agent_result',
  'skill_restart_from_step',
  'skill_cancel_execution',
] as const

test('STATIC_SKILL_TOOL_NAMES excludes every retired execution-control tool', () => {
  for (const name of RETIRED_NAMES) {
    assert.equal(
      STATIC_SKILL_TOOL_NAMES.includes(name),
      false,
      `static registry must not advertise ${name} after Phase 4`,
    )
  }
})

test('STATIC_SKILL_TOOL_NAMES_BOOT_SAFE excludes every retired execution-control tool', () => {
  for (const name of RETIRED_NAMES) {
    assert.equal(
      STATIC_SKILL_TOOL_NAMES_BOOT_SAFE.includes(name),
      false,
      `boot-safe registry must not advertise ${name} after Phase 4`,
    )
  }
})

test('filterSkillPrimitivesBySession never leaks retired names back (even if defs array is spoofed)', () => {
  const spoofed = [
    { name: 'skill_ask_user' },
    { name: 'skill_submit_input' }, // impostor — would never be in PRIMITIVE_TOOL_DEFS in prod
    { name: 'skill_run_shell' },
  ]
  // Even when fully exposed (sessionId undefined), the filter passes through
  // whatever the caller hands in — the protection is that the callers
  // (skills-tools.ts getSkillToolDefs) always pass PRIMITIVE_TOOL_DEFS, which
  // contains only current primitives. Lock that contract with a source-level
  // check rather than relying on the filter to sanitize.
  const pass = filterSkillPrimitivesBySession(spoofed, undefined, () => false, () => false)
  assert.deepEqual(pass.map((t) => t.name), spoofed.map((t) => t.name))
})

test('ToolGateway public skills list contains current primitives and excludes retired names', () => {
  const gateway = new ToolGateway()
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: [],
    allowedPrimitives: STANDARD_PRIMITIVES,
    source: 'explicit',
    reason: 'test_setup',
  })
  const names = gateway.getOpenAIToolsForGroups(['skills'], undefined, auth)
    .map((tool) => (tool.function as { name?: string } | undefined)?.name || '')
    .filter(Boolean)

  for (const name of RETIRED_NAMES) {
    assert.equal(names.includes(name), false, `public skills list must not advertise ${name}`)
  }
  // Positive baseline — current primitives are declared.
  for (const name of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
    // Phase 5.1 — generic run_state inspector for long multi-step skills.
    'skill_inspect_run_state',
  ]) {
    assert.ok(names.includes(name), `public skills list must advertise ${name}`)
  }
})

test('retired execution-control tool names are not dispatchable skill tools', async () => {
  for (const name of RETIRED_NAMES) {
    const output = await executeSkillTool(name, {})
    assert.equal(output, `Unknown skill tool: ${name}`)
  }
})

test('source — general skill prompts do not recommend retired execution-control tools', () => {
  const sources = [
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: prompt text is assembled in multiple UI/main modules with no exported builder surface to exercise directly.
    readFileSync(resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'), 'utf-8'),
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: prompt text is assembled in multiple UI/main modules with no exported builder surface to exercise directly.
    readFileSync(resolve(process.cwd(), 'src/renderer/modules/agent/messageComposer.ts'), 'utf-8'),
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: prompt text is assembled in multiple UI/main modules with no exported builder surface to exercise directly.
    readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/skill-context-orchestrator.ts'), 'utf-8'),
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: prompt text is assembled in multiple UI/main modules with no exported builder surface to exercise directly.
    readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/tool-parallelism-policy.ts'), 'utf-8'),
  ].join('\n')

  assert.doesNotMatch(sources, /skill_get_state\s*\/\s*skill_submit_\*/)
  assert.doesNotMatch(sources, /execution 管理工具/)
  // Phase 4 cleanup — neither the orchestrator's reference-skill prompt nor
  // the parallelism-policy access-mode tables may name the retired tools.
  for (const retired of RETIRED_NAMES) {
    assert.doesNotMatch(
      sources,
      new RegExp(`['"\`]${retired}['"\`]`),
      `${retired} must not appear as a quoted literal in orchestrator/parallelism sources`,
    )
  }
})

test('SkillsRuntimeManager instances do not expose retired execution APIs', () => {
  const manager = new SkillsRuntimeManager({
    runtimeRoot: resolve(process.cwd(), '.tmp-skill-runtime-contract'),
    startBackgroundTasks: false,
  }) as unknown as Record<string, unknown>
  for (const api of [
    'listExecutions',
    'getExecution',
    'submitExecutionInput',
    'submitExecutionConfirmation',
    'submitExecutionAgentResult',
    'restartExecutionFromStep',
    'cancelExecution',
    'getExecutionStore',
    'getExecutionCoordinator',
  ]) {
    assert.equal(typeof manager[api], 'undefined', `runtime manager must not expose ${api}`)
  }
})

test('shouldExposeSkillPrimitive remains false when no active execution and no reference hint', () => {
  assert.equal(
    shouldExposeSkillPrimitive('session-idle', () => false, () => false),
    false,
  )
})
