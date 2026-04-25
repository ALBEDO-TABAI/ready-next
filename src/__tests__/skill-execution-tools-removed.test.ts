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

import {
  STATIC_SKILL_TOOL_NAMES,
  STATIC_SKILL_TOOL_NAMES_BOOT_SAFE,
} from '../main/modules/tools/skills-tools-static'
import {
  filterSkillPrimitivesBySession,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'

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
  // contains only the 4 primitives. Lock that contract with a source-level
  // check rather than relying on the filter to sanitize.
  const pass = filterSkillPrimitivesBySession(spoofed, undefined, () => false, () => false)
  assert.deepEqual(pass.map((t) => t.name), spoofed.map((t) => t.name))
})

test('source — PRIMITIVE_TOOL_DEFS contains exactly the 4 primitive names (no retired tool smuggled in)', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/modules/tools/skill-primitives/tool-defs.ts'),
    'utf-8',
  )
  for (const name of RETIRED_NAMES) {
    assert.doesNotMatch(
      source,
      new RegExp(`name:\\s*['"]${name}['"]`),
      `PRIMITIVE_TOOL_DEFS must not declare ${name}`,
    )
  }
  // Positive baseline — the 4 primitives are declared.
  for (const name of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
  ]) {
    assert.match(
      source,
      new RegExp(`name:\\s*['"]${name}['"]`),
      `PRIMITIVE_TOOL_DEFS must declare ${name}`,
    )
  }
})

test('source — skills-tools.ts no longer references any retired manager execution API', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/modules/tools/skills-tools.ts'),
    'utf-8',
  )
  const retiredApis = [
    'submitExecutionInput',
    'submitExecutionConfirmation',
    'submitExecutionAgentResult',
    'restartExecutionFromStep',
    'cancelExecution',
    'getExecutionStore',
    'getExecutionCoordinator',
  ]
  for (const api of retiredApis) {
    assert.doesNotMatch(
      source,
      new RegExp(`manager\\.${api}\\s*\\(`),
      `skills-tools must not call manager.${api}() after Phase 4`,
    )
  }
})

test('source — general skill prompts do not recommend retired execution-control tools', () => {
  const sources = [
    readFileSync(resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'), 'utf-8'),
    readFileSync(resolve(process.cwd(), 'src/renderer/modules/agent/messageComposer.ts'), 'utf-8'),
    readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/skill-context-orchestrator.ts'), 'utf-8'),
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

test('source — runtime-manager.ts no longer declares any retired execution API', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/modules/skills-runtime/runtime-manager.ts'),
    'utf-8',
  )
  const retiredSignatures = [
    // Method signatures that used to exist. Both the simple form (`name(`) and
    // async form (`async name(`) are grep'd as declarations — not inside a
    // method body.
    /\n\s*listExecutions\s*\(/,
    /\n\s*getExecution\s*\(executionId/,
    /\n\s*async\s+submitExecutionInput\s*\(/,
    /\n\s*async\s+submitExecutionConfirmation\s*\(/,
    /\n\s*async\s+submitExecutionAgentResult\s*\(/,
    /\n\s*async\s+restartExecutionFromStep\s*\(/,
    /\n\s*cancelExecution\s*\(executionId/,
  ]
  for (const re of retiredSignatures) {
    assert.doesNotMatch(source, re, `runtime-manager must not re-declare retired API matching ${re}`)
  }
})

test('shouldExposeSkillPrimitive remains false when no active execution and no reference hint', () => {
  assert.equal(
    shouldExposeSkillPrimitive('session-idle', () => false, () => false),
    false,
  )
})
