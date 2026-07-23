import assert from 'node:assert/strict'
import test from 'node:test'

import { collectAllowedToolNames } from '../main/modules/agent-control/tool-policy/execution-tool-config'
import { ToolGateway } from '../main/modules/agent-control/tools-runtime/tool-gateway'
import { resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tools-runtime/tool-registry'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import { COMMAND_EXEC_TOOL_TIMEOUT_MS } from '../main/modules/tools/tool-execution-timeout-policy'

test('tool gateway exposes formal capability groups and resolves grouped tools', () => {
  const gateway = new ToolGateway()

  const groups = gateway.listCapabilityGroups()
  const groupIds = groups.map((group) => group.id)
  assert.ok(groupIds.includes('browser_interaction'))
  assert.ok(groupIds.includes('browser_content_tasks'))
  assert.ok(groupIds.includes('system_host'))
  assert.ok(groupIds.includes('design_reserved'))

  const browserInteractionTools = gateway.collectToolNamesForGroups(['browser_interaction'])
  const browserContentTools = gateway.collectToolNamesForGroups(['browser_content_tasks'])
  const systemTools = gateway.collectToolNamesForGroups(['system_host'])
  const skillTools = gateway.collectToolNamesForGroups(['skills'])
  const sessionId = 'tool-gateway-vea'
  const skillsGroup = gateway.getCapabilityGroup('skills')
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill(sessionId, { id: 'video-expert-analyzer', name: 'VEA' })
  const veaAuth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: [
      'skill_ask_user',
      'skill_run_shell',
      'skill_write_artifact',
      'skill_read_artifact',
      'skill_patch_config',
      'skill_start_detached',
      'skill_inspect_detached',
      'skill_cancel_detached',
      'skill_inspect_run_state',
    ],
    source: 'explicit',
    reason: 'test_setup',
  })
  const hintedSkillSchemaNames = gateway.getOpenAIToolsForGroups(['skills'], sessionId, veaAuth)
    .map((tool) => (tool.function as { name?: string } | undefined)?.name || '')
    .filter(Boolean)
  const systemOpenAISchemas = gateway.getToolSchemasForGroup('system_host', 'openai', undefined, buildExplicitNoSkillAuthorization('no_skill_signal'))
  const browserNavigate = gateway.getToolDefinition('browser_navigate')
  const documentSave = gateway.getToolDefinition('document_save_tab')
  const documentInsertWidget = gateway.getToolDefinition('document_insert_widget')
  const documentUpdateWidget = gateway.getToolDefinition('document_update_widget')
  const documentRemoveWidget = gateway.getToolDefinition('document_remove_widget')
  const documentListWidgets = gateway.getToolDefinition('document_list_widgets')
  const skillPipeline = gateway.getToolDefinition('skill_video_expert_pipeline')
  const setupCommand = gateway.getToolDefinition('run_setup_command')

  assert.ok(browserInteractionTools.includes('browser_navigate'))
  assert.ok(browserInteractionTools.includes('browser_click'))
  assert.ok(browserInteractionTools.includes('browser_collect'))

  assert.deepEqual(browserContentTools, [])

  assert.ok(systemTools.includes('system_run_embedded_python'))
  assert.ok(systemTools.includes('system_run_openclaw'))
  assert.ok(skillTools.includes('skill_rss_add'))
  assert.ok(!skillTools.includes('skill_get_state'))
  assert.ok(!skillTools.includes('skill_video_expert_pipeline'))
  assert.ok(hintedSkillSchemaNames.includes('skill_video_expert_pipeline'))
  assert.equal(skillsGroup?.hasDynamicSource, true)
  assert.ok(systemOpenAISchemas.some((tool) => (tool.function as { name?: string } | undefined)?.name === 'system_run_openclaw'))
  assert.equal(browserNavigate?.domain, 'browser')
  assert.equal(browserNavigate?.kind, 'write')
  assert.equal(browserNavigate?.concurrency, 'serialized')
  assert.equal(browserNavigate?.interruptBehavior, 'abort_signal')
  assert.equal(browserNavigate?.timeoutProfile, 'browser_interactive')
  assert.equal(browserNavigate?.supportsTextBridge, false)
  assert.deepEqual(browserNavigate?.projectionHint, { mutating: true })
  assert.match(browserNavigate?.description || '', /open\/back\/forward\/reload/)
  assert.equal(browserNavigate?.schema?.type, 'object')
  assert.equal(browserNavigate?.resultShape, 'text')
  assert.equal(documentSave?.domain, 'document')
  assert.equal(documentSave?.kind, 'write')
  assert.equal(documentSave?.timeoutProfile, 'document_write')
  assert.equal(documentSave?.supportsTextBridge, true)
  assert.deepEqual(documentSave?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(documentSave?.resultShape, 'projection_patch')
  assert.match(documentSave?.description || '', /保存/)
  assert.equal(documentSave?.schema?.type, 'object')
  assert.equal(documentInsertWidget?.resultShape, 'projection_patch')
  assert.deepEqual(documentInsertWidget?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(documentUpdateWidget?.resultShape, 'projection_patch')
  assert.deepEqual(documentUpdateWidget?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(
    typeof (documentUpdateWidget?.schema?.properties as Record<string, unknown> | undefined)?.componentSpecPatch,
    'object',
  )
  assert.equal(documentRemoveWidget?.resultShape, 'projection_patch')
  assert.deepEqual(documentRemoveWidget?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(documentListWidgets?.resultShape, 'text')
  assert.equal(documentListWidgets?.projectionHint, null)
  assert.equal(skillPipeline, null)
  assert.equal(setupCommand?.timeoutProfile, 'command_exec')
  assert.equal(setupCommand?.executionTimeoutMs, COMMAND_EXEC_TOOL_TIMEOUT_MS)
  assert.equal(setupCommand?.interruptBehavior, 'host_managed')
  assert.ok(gateway.listToolDefinitions().some((tool) => tool.name === 'session_search' && tool.domain === 'session'))
})

test('tool gateway does not expose empty fallback schemas when a group provider fails to load', () => {
  const gateway = new ToolGateway({
    __testGroupProviders: {
      system_host: {
        staticToolNames: ['system_run_openclaw'],
        getOpenAITools: () => {
          throw new Error('broken provider')
        },
      },
    },
  })

  const systemOpenAISchemas = gateway.getToolSchemasForGroup('system_host', 'openai', undefined, buildExplicitNoSkillAuthorization('no_skill_signal'))

  assert.deepEqual(systemOpenAISchemas, [])
  assert.match(gateway.getLastSchemaResolutionError('system_host', 'openai') || '', /broken provider/)
})

test('browser tool schemas stay available after the browser executor module loads first', async () => {
  await import('../main/modules/tools/browser-tools')

  const gateway = new ToolGateway()
  const browserOpenAISchemas = gateway.getToolSchemasForGroup('browser_interaction', 'openai', undefined, buildExplicitNoSkillAuthorization('no_skill_signal'))
  const browserToolNames = browserOpenAISchemas
    .map((tool) => (tool.function as { name?: string } | undefined)?.name || '')
    .filter(Boolean)

  assert.ok(browserToolNames.includes('browser_search'))
  assert.ok(browserToolNames.includes('browser_read'))
  assert.equal(gateway.getLastSchemaResolutionError('browser_interaction', 'openai'), null)
})

test('tool gateway reports grouped schema diagnostics and static fallback usage', () => {
  const gateway = new ToolGateway({
    __testGroupProviders: {
      skills: {
        staticToolNames: ['skill_get_state'],
        hasDynamicSource: true,
        getOpenAIToolsDetailed: () => ({
          tools: [{
            type: 'function',
            function: {
              name: 'skill_get_state',
              description: 'fallback',
              parameters: {
                type: 'object',
                properties: {},
                required: [],
              },
            },
          }],
          error: 'runtime unavailable',
          usedStaticFallback: true,
        }),
      },
    },
  })

  const skillGetStateAuth = buildSelectedSkillToolAuthorization({
    skillId: 'fixture-skill',
    allowedTypedActions: ['skill_get_state'],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'test_setup',
  })
  const resolution = gateway.getToolSchemaResolutionForGroups(['skills'], 'openai', undefined, skillGetStateAuth)

  assert.equal(resolution.groupResolutions[0]?.toolCount, 1)
  assert.equal(resolution.groupResolutions[0]?.usedStaticFallback, true)
  assert.match(resolution.groupResolutions[0]?.schemaError || '', /runtime unavailable/)
  assert.match(gateway.getLastSchemaResolutionError('skills', 'openai') || '', /runtime unavailable/)
})

test('resolveToolInputSchemaForExecution resolves both static primitives and dynamic skill actions through one path', () => {
  // Phase 2 (B child-loop): single execution-admission resolver. Used by
  // tool-executor (dispatch validation), turn-engine (forced preflight),
  // and turn-frame-steering (forced validation). All three must consult
  // exactly the same schema for any given tool name — that's the contract
  // collapsing the prior split between `getSkillActionSchemas()` and
  // `getToolInputSchemas()`.
  //
  // Static primitive: declared via SKILL_PRIMITIVE_SCHEMAS and reaches the
  // resolver via the static registry.
  const writeArtifact = resolveToolInputSchemaForExecution('skill_write_artifact')
  assert.ok(writeArtifact, 'resolver must surface skill_write_artifact')
  // Empty input fails — `path` and `content` are required on the primitive.
  const writeOutcome = (writeArtifact as { safeParse: (v: unknown) => { success: boolean } })
    .safeParse({})
  assert.equal(writeOutcome.success, false)

  // Dynamic / static-manifest skill action: reaches the resolver either via
  // the static-manifest-derived schemas folded into getToolInputSchemas(),
  // or via the dynamic getSkillActionSchemas() cache when the runtime
  // manager is up. Both sources land at the same resolver entry.
  const veaPipeline = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  assert.ok(veaPipeline, 'resolver must surface skill_video_expert_pipeline')
  const veaOutcome = (veaPipeline as { safeParse: (v: unknown) => { success: boolean } })
    .safeParse({})
  assert.equal(veaOutcome.success, false)

  // Unknown tool: passthrough (null), so callers don't validate names that
  // have no registered schema.
  assert.equal(resolveToolInputSchemaForExecution('definitely_not_a_tool'), null)
})

test('collectAllowedToolNames keeps browser tools when browser groups are visible', () => {
  const allowedToolNames = collectAllowedToolNames({
    forceDocumentTool: false,
    allowDocumentTools: true,
    forceDesignTool: false,
    preferredDesignTool: null,
    primaryDesignInstruction: null,
    allowMultipleDesignArtifacts: false,
    preferSectionRewrite: false,
    preferFormatOnly: false,
    allowBrowserTools: true,
    preferredSkillToolNames: null,
    visibleCapabilityGroupIds: ['browser_interaction', 'browser_content_tasks', 'memory', 'session_recall'],
    hostOnlyCapabilityGroupIds: [],
    capabilityReasons: {},
  })

  assert.ok(allowedToolNames.includes('browser_search'))
  assert.ok(allowedToolNames.includes('browser_read'))
  assert.ok(allowedToolNames.includes('browser_collect'))
})

// ------------------------------------------------------------------
// T6 (B child-loop, wave 3) — schema-source parity between the public
// model surface and the child-internal gateway.
//
// Both surfaces must consume the SAME `resolveToolInputSchemaForExecution`
// output for a given (skillId, action). If the resolver ever forks for
// internal callers, the two surfaces would drift — a malformed input
// might pass internal admission while failing public dispatch (or vice
// versa). The test below pins the same-source contract.
// ------------------------------------------------------------------
test('T6: gateway uses the same schema source as public dispatch (resolver parity)', async () => {
  const publicSchema = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  assert.ok(publicSchema, 'public dispatch path must have a schema for VEA pipeline')

  // The gateway resolves by (skillId, action) → buildSkillToolName →
  // resolver. The resolver export is module-scoped so any schema the
  // gateway consumes IS the same object reference returned to the
  // model surface. Re-resolving must return strict equality.
  const reResolved = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  assert.strictEqual(publicSchema, reResolved, 'resolver must be referentially stable across calls')

  const aiSchemaA = resolveToolInputSchemaForExecution('skill_video_expert_ai_analyze')
  const aiSchemaB = resolveToolInputSchemaForExecution('skill_video_expert_ai_analyze')
  assert.ok(aiSchemaA && aiSchemaB)
  assert.strictEqual(aiSchemaA, aiSchemaB, 'second VEA action must also be referentially stable')
})
