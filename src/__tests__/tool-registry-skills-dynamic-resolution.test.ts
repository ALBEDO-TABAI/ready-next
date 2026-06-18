/**
 * Regression test for the bundled-production skills-tool resolution bug.
 *
 * A previous implementation used `createRequire(import.meta.url)` + relative
 * path lazy-require to load `../tools/skills-tools` at call time. After
 * electron-vite bundled the main process into `out/main/index.js`, that
 * `createRequire` resolved against the bundle directory and silently failed
 * with:
 *
 *   Cannot find module '../tools/skills-tools'
 *   Require stack: - .../out/main/index.js
 *
 * The registry caught the error and fell back to `STATIC_SKILL_TOOL_NAMES`,
 * which lists 14 hardcoded skill tools. User-installed custom skills (e.g.
 * `skill_novel_writer_system_read_skill`) were never surfaced to the model —
 * so even after every upstream gate (preferredSkillToolNames, arbitration,
 * intent classification) was fixed, the tool literally did not exist in the
 * registry for the model to call.
 *
 * These assertions pin the source-level contract that prevents a future
 * refactor from re-introducing the relative-path lazy-require pattern.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { PROJECTION_OBSERVABILITY_METRICS } from '../main/modules/agent-control/projection-observability-metrics'
import {
  fallbackThrottle,
  SKILL_TOOL_FALLBACK_ENTRIES,
} from '../main/modules/agent-control/skills/skill-tool-fallback-throttle'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import { ToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

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

const SELECTED_AUTH = buildSelectedSkillToolAuthorization({
  skillId: 'video-expert-analyzer',
  allowedTypedActions: ['skill_video_expert_pipeline', 'skill_static_fallback_read_skill'],
  allowedPrimitives: STANDARD_PRIMITIVES,
  source: 'explicit',
  reason: 'test_setup',
})
const SEND_IM_AUTH = buildSelectedSkillToolAuthorization({
  skillId: 'send-im',
  allowedTypedActions: ['skill_send_im_file'],
  allowedPrimitives: [],
  source: 'explicit',
  reason: 'test_send_im',
})
import {
  __setSkillActionToolDefsForTests,
  buildSkillToolName,
  findSkillToolByNameForExecution,
  findSkillToolByNameForExecutionDetailed,
  findSkillToolBySkillAction,
  getSkillActionSchemas,
} from '../main/modules/tools/skills-tools'
import { resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tools-runtime/tool-registry'
import {
  getStaticSkillActionDefBySkillAction,
  getStaticSkillToolNameForAction,
} from '../main/modules/tools/skills-tools-static'

const LOOKUP_METRIC = PROJECTION_OBSERVABILITY_METRICS.skillToolDynamicLookupFailed

function captureMetrics(): { events: AgentMetricEvent[]; restore: () => void } {
  const events: AgentMetricEvent[] = []
  fallbackThrottle.resetForTests()
  __setMetricSinkForTests((event) => events.push(event))
  return {
    events,
    restore: () => {
      __setMetricSinkForTests(null)
      fallbackThrottle.resetForTests()
    },
  }
}

function lookupEvents(events: AgentMetricEvent[]): AgentMetricEvent[] {
  return events.filter((event) => event.metric === LOOKUP_METRIC)
}

function assertLookupPayload(
  event: AgentMetricEvent,
  expected: Record<string, unknown>,
): void {
  const keys = Object.keys(event)
    .filter((key) => key !== 'at' && key !== 'metric')
    .sort()
  assert.deepEqual(keys, Object.keys(expected).sort())
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(event[key], value)
  }
}

function withSkillActionDefs(resolver: () => never | [], fn: () => void): void {
  __setSkillActionToolDefsForTests(() => resolver())
  try {
    fn()
  } finally {
    __setSkillActionToolDefsForTests(null)
  }
}

function withSkillActionLookupThrowing(fn: () => void): void {
  withSkillActionDefs(() => {
    throw new Error('runtime unavailable with path /tmp/secret and stack')
  }, fn)
}

test('tool-registry imports skills-tools / system-tools at module top (not via lazyRequire)', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: electron-vite bundle safety depends on static import topology rather than runtime registry output
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/tools-runtime/tool-registry.ts'), 'utf8')

  assert.match(
    source,
    /^import \{[\s\S]*?getSkillAnthropicTools,[\s\S]*?getSkillOpenAITools,[\s\S]*?\} from '\.\.\/\.\.\/tools\/skills-tools'$/m,
    'skills-tools must be imported at module top so electron-vite inlines it into the bundle',
  )
  assert.match(
    source,
    /^import \{ getSystemAnthropicTools, getSystemOpenAITools \} from '\.\.\/\.\.\/tools\/system-tools'$/m,
    'system-tools must be imported at module top so electron-vite inlines it into the bundle',
  )
})

test('tool-registry has no lazyRequire or createRequire invocation', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: bundled production regressed specifically through createRequire/lazyRequire topology
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/tools-runtime/tool-registry.ts'), 'utf8')

  // Allow "createRequire" to appear only inside comments (we intentionally
  // leave a forensic explanation behind). Strip // and /* */ comments first.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.doesNotMatch(
    stripped,
    /lazyRequire/,
    'lazyRequire is forbidden — bundled production cannot resolve relative paths via createRequire(import.meta.url)',
  )
  assert.doesNotMatch(
    stripped,
    /createRequire\s*\(/,
    'createRequire is forbidden in tool-registry — use top-level static imports so electron-vite inlines the module',
  )
})

test('tool-registry falls back to static skills definitions and schemas when dynamic resolution fails', () => {
  const registry = new ToolRegistry({
    __testGroupProviders: {
      skills: {
        staticToolNames: ['skill_static_fallback_read_skill'],
        getToolDefinitions: () => {
          throw new Error('dynamic definitions unavailable')
        },
      },
    },
  })

  const definitions = registry.getToolDefinitionsResolutionForGroup('skills', undefined, SELECTED_AUTH)
  assert.equal(definitions.usedStaticFallback, true)
  assert.equal(definitions.error, 'dynamic definitions unavailable')
  assert.deepEqual(definitions.definitions.map((tool) => tool.name), ['skill_static_fallback_read_skill'])

  const schemas = registry.getToolSchemasResolutionForGroup('skills', 'openai', undefined, SELECTED_AUTH)
  assert.equal(schemas.usedStaticFallback, true)
  assert.deepEqual(schemas.tools.map((tool) => (tool.function as { name: string }).name), [
    'skill_static_fallback_read_skill',
  ])
})

test('tool-registry exposes send-im direct send tool for selected Send IM turns', () => {
  const registry = new ToolRegistry()

  const definitions = registry.getToolDefinitionsResolutionForGroup('skills', undefined, SEND_IM_AUTH)
  assert.ok(definitions.definitions.some((tool) => tool.name === 'skill_send_im_file'))

  const schemas = registry.getToolSchemasResolutionForGroup('skills', 'openai', undefined, SEND_IM_AUTH)
  assert.ok(schemas.tools.some((tool) => (tool.function as { name?: string }).name === 'skill_send_im_file'))

  const executionDef = registry.getToolDefinitionForExecution('skill_send_im_file')
  assert.equal(executionDef?.name, 'skill_send_im_file')
})

test('explicit Send IM mention makes the final model-visible send tool available', () => {
  const registry = new ToolRegistry()
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'send-im',
        name: 'Send IM',
        description: 'send local files to remote IM',
        defaultAction: 'send_file',
        actions: [{ name: 'send_file', visibility: 'public' }],
      } as any,
    ],
    resolveSkillToolByAction: (skillId, action) => findSkillToolBySkillAction(skillId, action) as any,
  })
  const userText = '@[Send IM]把这四张图发到我微信'
  const explicitSkills = orchestrator.findExplicitlyRequestedSkills(userText)
  const preferred = orchestrator.buildPreferredSkillToolNames(userText, 'scope-send-im')
  const typedActions = preferred.filter((name) => !STANDARD_PRIMITIVES.includes(name))
  const auth = buildSelectedSkillToolAuthorization({
    skillId: explicitSkills[0]?.id || '',
    allowedTypedActions: typedActions,
    allowedPrimitives: preferred.filter((name) => STANDARD_PRIMITIVES.includes(name)),
    source: 'explicit',
    reason: 'explicit_send_im_mention',
  })

  assert.deepEqual(explicitSkills.map((skill) => skill.id), ['send-im'])
  assert.ok(typedActions.includes('skill_send_im_file'))
  const definitions = registry.getToolDefinitionsResolutionForGroup('skills', undefined, auth)
  const schemas = registry.getToolSchemasResolutionForGroup('skills', 'openai', undefined, auth)
  assert.ok(definitions.definitions.some((tool) => tool.name === 'skill_send_im_file'))
  assert.ok(schemas.tools.some((tool) => (tool.function as { name?: string }).name === 'skill_send_im_file'))
})

test('send-im skill action uses one tool name across dynamic and static registries', () => {
  assert.equal(buildSkillToolName('send-im', 'send_file'), 'skill_send_im_file')
  assert.equal(getStaticSkillToolNameForAction('send-im', 'send_file'), 'skill_send_im_file')
  assert.equal(findSkillToolBySkillAction('send-im', 'send_file')?.name, 'skill_send_im_file')
  assert.equal(findSkillToolByNameForExecution('skill_send_im_file')?.name, 'skill_send_im_file')
  assert.equal(findSkillToolByNameForExecution('skill_send_im_send_file'), null)
})

test('skill action tool names have a single static source of truth', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed drift guard: D4 explicitly retired the duplicate local static-name table.
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/tools/skills-tools.ts'), 'utf8')

  assert.doesNotMatch(source, /const\s+STATIC_TOOL_NAMES\s*:/)
  assert.match(source, /getStaticSkillToolNameForAction\(skillId,\s*actionName\)/)
})

test('skill action lookup does not fall back to the first action for unknown action names', () => {
  assert.equal(findSkillToolBySkillAction('send-im', 'not_real_action'), null)
  assert.equal(getStaticSkillActionDefBySkillAction('send-im', 'not_real_action'), null)
})

test('child-loop skill dispatch carries explicit execution form in projection patch', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private dispatch helper: child-loop execution form must be explicit for finalizer criteria selection.
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/tools/skills-tools.ts'), 'utf8')
  const childLoopBlock = source.match(/async function dispatchChildLoopSkillAction[\s\S]*?return createToolExecutionOutput\(text,[\s\S]*?\n\}/)?.[0] || ''

  assert.match(childLoopBlock, /projectionPatch:\s*\{[\s\S]*module:\s*'skill'[\s\S]*skillExecutionForm:\s*'child_loop'/)
})

// =============================================================================
// Stage 4 W4 — Fallback observability contract
// =============================================================================
// W4 observes dynamic skill lookup failures without leaking error messages,
// paths, stacks, group ids, formats, or forged skill names into metrics.

test('Stage 4 W4: skill_tool_dynamic_lookup_failed is projection observability, not a tool-error metric', () => {
  assert.equal(LOOKUP_METRIC, 'skill_tool_dynamic_lookup_failed')
  assert.deepEqual(SKILL_TOOL_FALLBACK_ENTRIES, [
    'find_by_name',
    'find_by_skill_action',
    'execution',
    'schema_list',
    'definition_list',
    'input_schema',
    'group_definitions',
    'group_schemas',
    'action_schemas_map',
  ])
  assert.equal(
    Object.values(TOOL_ERROR_METRICS).includes('skill_tool_dynamic_lookup_failed' as never),
    false,
  )
})

test('Stage 4 W4: find_by_name emits manager_throw with only the safe payload fields', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      const result = findSkillToolByNameForExecutionDetailed('skill_video_expert_pipeline')
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.def.name, 'skill_video_expert_pipeline')
      }
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 1)
    assertLookupPayload(lookup[0], {
      entry: 'find_by_name',
      reason: 'manager_throw',
      toolName: 'skill_video_expert_pipeline',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: find_by_name uses static manifest defs without manifest_miss metrics', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionDefs(() => [], () => {
      const bootSafe = findSkillToolByNameForExecutionDetailed('skill_video_expert_pipeline')
      assert.equal(bootSafe.ok, true)
      if (bootSafe.ok) {
        assert.equal(bootSafe.def.name, 'skill_video_expert_pipeline')
      }

      const forged = findSkillToolByNameForExecutionDetailed('skill_fake_action')
      assert.deepEqual(forged, { ok: false, reason: 'manifest_miss' })
    })

    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 0)
  } finally {
    restore()
  }
})

test('Stage 4 W4: legacy findSkillToolByNameForExecution keeps def|null contract', () => {
  const primitive = findSkillToolByNameForExecution('skill_ask_user')
  assert.equal(primitive?.name, 'skill_ask_user')
  assert.equal(findSkillToolByNameForExecution('skill_fake_action'), null)
})

test('Stage 4 W4: find_by_skill_action emits at the real catch with skillId/action payload', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      const tool = findSkillToolBySkillAction('video-expert-analyzer', 'video_expert_pipeline')
      assert.equal(tool?.name, 'skill_video_expert_pipeline')
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 1)
    assertLookupPayload(lookup[0], {
      entry: 'find_by_skill_action',
      reason: 'manager_throw',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: send-im explicit skill action falls back to static manifest tool defs', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      const byAction = findSkillToolBySkillAction('send-im', 'send_file')
      assert.equal(byAction?.name, 'skill_send_im_file')
      assert.equal(byAction?.skillId, 'send-im')
      assert.equal(byAction?.action, 'send_file')
      assert.ok(byAction?.params.some((param) => param.name === 'filePath'))

      const byName = findSkillToolByNameForExecutionDetailed('skill_send_im_file')
      assert.equal(byName.ok, true)
      if (byName.ok) {
        assert.equal(byName.def.skillId, 'send-im')
        assert.equal(byName.def.action, 'send_file')
      }
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 2)
    assertLookupPayload(lookup[0], {
      entry: 'find_by_skill_action',
      reason: 'manager_throw',
      skillId: 'send-im',
      action: 'send_file',
    })
    assertLookupPayload(lookup[1], {
      entry: 'find_by_name',
      reason: 'manager_throw',
      toolName: 'skill_send_im_file',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: getSkillActionSchemas catch emits action_schemas_map', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      assert.deepEqual(getSkillActionSchemas(), {})
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 1)
    assertLookupPayload(lookup[0], {
      entry: 'action_schemas_map',
      reason: 'manager_throw',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: tool-registry emits definition_list and schema_list from dynamic skills list fallbacks', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      const registry = new ToolRegistry()
      assert.equal(registry.getToolDefinitionsResolutionForGroup('skills', undefined, SELECTED_AUTH).usedStaticFallback, true)
      assert.equal(registry.getToolSchemasResolutionForGroup('skills', 'openai', undefined, SELECTED_AUTH).usedStaticFallback, true)
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 2)
    assertLookupPayload(lookup[0], {
      entry: 'definition_list',
      reason: 'manager_throw',
    })
    assertLookupPayload(lookup[1], {
      entry: 'schema_list',
      reason: 'manager_throw',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: resolveSkillToolDefinitionForExecution emits execution once, not find_by_name plus execution', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      const registry = new ToolRegistry()
      const def = registry.getToolDefinitionForExecution('skill_video_expert_pipeline')
      assert.equal(def?.name, 'skill_video_expert_pipeline')
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 1)
    assertLookupPayload(lookup[0], {
      entry: 'execution',
      reason: 'manager_throw',
      toolName: 'skill_video_expert_pipeline',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: resolveToolInputSchemaForExecution emits input_schema on dynamic schema lookup failure', () => {
  const { events, restore } = captureMetrics()
  try {
    withSkillActionLookupThrowing(() => {
      assert.equal(resolveToolInputSchemaForExecution('skill_custom_dynamic'), null)
    })
    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 1)
    assertLookupPayload(lookup[0], {
      entry: 'input_schema',
      reason: 'manager_throw',
      toolName: 'skill_custom_dynamic',
    })
  } finally {
    restore()
  }
})

test('Stage 4 W4: tool-registry emits group_definitions and group_schemas from outer provider catches', () => {
  const { events, restore } = captureMetrics()
  try {
    const registry = new ToolRegistry({
      __testGroupProviders: {
        skills: {
          staticToolNames: ['skill_static_fallback_read_skill'],
          getToolDefinitions: () => {
            throw new Error('definition provider unavailable')
          },
          getOpenAITools: () => {
            throw new Error('schema provider unavailable')
          },
        },
      },
    })
    const definitions = registry.getToolDefinitionsResolutionForGroup('skills', undefined, SELECTED_AUTH)
    assert.equal(definitions.usedStaticFallback, true)
    const schemas = registry.getToolSchemasResolutionForGroup('skills', 'openai', undefined, SELECTED_AUTH)
    assert.deepEqual(schemas.tools, [])

    const lookup = lookupEvents(events)
    assert.equal(lookup.length, 2)
    assertLookupPayload(lookup[0], {
      entry: 'group_definitions',
      reason: 'manager_throw',
    })
    assertLookupPayload(lookup[1], {
      entry: 'group_schemas',
      reason: 'manager_throw',
    })
  } finally {
    restore()
  }
})
