import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import type { SkillState } from '../main/modules/skills-runtime/runtime-manager'
import {
  isCodexSafeHostSkillPrimitiveDefinition,
  isHostFolderExportPrimitive,
} from '../main/modules/tools/skill-tool-execution-authority'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  assertReadyToolSurface,
  assertReadyBoundTurnToolAuthorization,
  buildReadyBoundTurnToolAuthorization,
  buildReadyToolSurface,
  buildReadyTurnToolAuthorization,
  codexRequestToolsDigest,
  compareReadyToolSurfaceCompatibility,
  CodexToolSurfaceError,
  digestCodexRootToolSurface,
  normalizeCodexDynamicToolSchema,
  resolveReadyToolTurnSnapshot,
  selectCodexRootToolDefinitions,
  type ReadyLiveToolResolutionInput,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'

function definition(name: string): ToolDefinition {
  return {
    name,
    groupId: 'agent_interaction',
    domain: 'document',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: null,
    description: `Read with ${name}`,
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

test('deferred browser definitions stay frozen and authorized independently of loading', () => {
  const surface = buildReadyToolSurface({ surfaceId: 'deferred', toolDefinitions: [definition('browser_cdp'), definition('browser_click')] })
  assertReadyToolSurface(surface)
  assert.equal(surface.dynamicTools.find(tool => tool.name === 'browser_cdp')?.deferLoading, true)
  assert.equal(surface.responsesTools.find(tool => tool.name === 'browser_cdp')?.defer_loading, true)
  assert.equal(surface.dynamicTools.find(tool => tool.name === 'browser_click')?.deferLoading, undefined)
  assert.equal(codexRequestToolsDigest(surface), surface.toolSurfaceDigest)
  const authorization = buildReadyTurnToolAuthorization({ authorizationId: 'allowed-click',
    authorization: buildExplicitNoSkillAuthorization(), toolSurface: surface, allowedToolNames: ['browser_click'] })
  assert.deepEqual(authorization.allowedToolNames, ['browser_click'])
  const tampered = structuredClone(surface)
  delete tampered.dynamicTools[0].deferLoading
  assert.throws(() => assertReadyToolSurface(tampered), /tool_surface_digest_mismatch/)
  delete tampered.responsesTools[0].defer_loading
  tampered.toolSurfaceDigest = digestCanonicalJson(tampered.responsesTools)
  tampered.surfaceSnapshotDigest = digestCanonicalJson({ entries: tampered.entries,
    dynamicTools: tampered.dynamicTools, responsesTools: tampered.responsesTools })
  assertReadyToolSurface(tampered)
  assert.equal(compareReadyToolSurfaceCompatibility({ frozen: tampered, current: surface }).kind, 'native_tool_definition_changed')
})

test('root Codex surface digest ignores control tools and stays deterministic', () => {
  const root = [
    definition('tool_a'),
    { ...definition('use_browser'), groupId: 'skill_activation' as const, domain: 'skill_activation' as const },
    {
      ...definition('browser_download'),
      groupId: 'browser_interaction' as const,
      domain: 'browser' as const,
    },
  ]
  assert.deepEqual(selectCodexRootToolDefinitions(root).map((entry) => entry.name), ['tool_a'])
  assert.equal(
    digestCodexRootToolSurface(root),
    buildReadyToolSurface({
      surfaceId: 'codex-root-surface',
      toolDefinitions: [definition('tool_a')],
    }).toolSurfaceDigest,
  )
})

test('Ready tool surface emits exact deterministic 0/1/2 dynamic-tool fixtures', () => {
  for (const names of [[], ['tool_b'], ['tool_b', 'tool_a']]) {
    const surface = buildReadyToolSurface({
      surfaceId: `surface-${names.length}`,
      toolDefinitions: names.map(definition),
    })
    assert.deepEqual(Object.keys(surface).sort(), [
      'dynamicTools',
      'entries',
      'responsesTools',
      'surfaceId',
      'surfaceSnapshotDigest',
      'toolNames',
      'toolSurfaceDigest',
    ])
    assert.deepEqual(surface.toolNames, [...names].sort())
    assert.deepEqual(surface.dynamicTools.map((tool) => tool.name), [...names].sort())
    assert.deepEqual(surface.responsesTools.map((tool) => tool.name), [...names].sort())
    assert.equal(surface.dynamicTools.length, names.length)
    assertReadyToolSurface(surface)
  }
})

test('surface digest is order-independent and includes schema and effect profile', () => {
  const first = buildReadyToolSurface({
    surfaceId: 'surface-stable',
    toolDefinitions: [definition('tool_b'), definition('tool_a')],
  })
  const second = buildReadyToolSurface({
    surfaceId: 'surface-stable',
    toolDefinitions: [definition('tool_a'), definition('tool_b')],
  })
  assert.equal(first.toolSurfaceDigest, second.toolSurfaceDigest)
  assert.equal(first.surfaceSnapshotDigest, second.surfaceSnapshotDigest)
  assert.match(first.entries[0].schemaDigest, /^[a-f0-9]{64}$/)
  assert.match(first.entries[0].effectProfileDigest, /^[a-f0-9]{64}$/)

  const changed = definition('tool_a')
  changed.kind = 'write'
  const changedSurface = buildReadyToolSurface({
    surfaceId: 'surface-stable',
    toolDefinitions: [changed, definition('tool_b')],
  })
  assert.equal(first.toolSurfaceDigest, changedSurface.toolSurfaceDigest)
  assert.notEqual(first.surfaceSnapshotDigest, changedSurface.surfaceSnapshotDigest)

  const changedResult = definition('tool_a')
  changedResult.resultShape = 'multimodal'
  assert.notEqual(
    first.surfaceSnapshotDigest,
    buildReadyToolSurface({
      surfaceId: 'surface-stable',
      toolDefinitions: [changedResult, definition('tool_b')],
    }).surfaceSnapshotDigest,
  )
})

test('wire tool schema mirrors pinned Codex normalization without weakening Ready validation', () => {
  const original = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      items: {
        type: 'array', minItems: 1, maxItems: 8,
        items: { type: 'integer', minimum: 1 },
      },
      metadata: { type: 'object' },
    },
    required: ['title'],
    additionalProperties: false,
  }
  const normalized = normalizeCodexDynamicToolSchema(original)
  // Measured on pinned 0.160.1 (2026-10-07): minItems is kept, every other constraint keyword is dropped.
  assert.deepEqual(normalized, {
    type: 'object',
    properties: {
      title: { type: 'string' },
      items: { type: 'array', minItems: 1, items: { type: 'integer' } },
      metadata: { type: 'object', properties: {} },
    },
    required: ['title'],
    additionalProperties: false,
  })

  const strict = definition('normalized_tool')
  strict.schema = original
  const surface = buildReadyToolSurface({ surfaceId: 'normalized', toolDefinitions: [strict] })
  assert.deepEqual(surface.entries[0].inputSchema, original)
  assert.notEqual(surface.entries[0].schemaDigest, digestCanonicalJson(normalized))
  assert.deepEqual(surface.responsesTools[0].parameters, normalized)
  assert.equal(surface.toolSurfaceDigest, digestCanonicalJson(surface.responsesTools))
})

test('wire tool schema keeps minItems only as the non-negative integer the runtime accepts', () => {
  const schema = (minItems: unknown) => ({
    type: 'object',
    properties: { values: { type: 'array', items: { type: 'string' }, minItems } },
  })
  assert.deepEqual(normalizeCodexDynamicToolSchema(schema(0)).properties, {
    values: { type: 'array', items: { type: 'string' }, minItems: 0 },
  })
  // The runtime refuses the whole tool at thread start for these; Ready refuses them when building the surface.
  for (const invalid of [1.5, -1, '1', null]) {
    assert.throws(() => normalizeCodexDynamicToolSchema(schema(invalid)), /tool_surface_schema_invalid/)
  }
})

// 2026-10-07: every surface frozen under 0.149 lacks minItems in responsesTools, while 0.160.1 sends it. The
// stored serialization and its digests stay the thread's identity; the wire is derived from its dynamic tools.
test('a surface frozen under an earlier serialization stays valid and derives the current request tools', () => {
  const tool = definition('upload_files')
  tool.schema = {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
    required: ['ids'],
    additionalProperties: false,
  }
  const current = buildReadyToolSurface({ surfaceId: 'lineage', toolDefinitions: [tool] })
  const earlierResponsesTools = current.responsesTools.map((entry) => ({
    ...entry,
    parameters: {
      ...entry.parameters,
      properties: { ids: { type: 'array', items: { type: 'string' } } },
    },
  }))
  const frozen = {
    ...current,
    responsesTools: earlierResponsesTools,
    toolSurfaceDigest: digestCanonicalJson(earlierResponsesTools),
    surfaceSnapshotDigest: digestCanonicalJson({
      entries: current.entries, dynamicTools: current.dynamicTools, responsesTools: earlierResponsesTools,
    }),
  }
  assert.doesNotThrow(() => assertReadyToolSurface(frozen))
  assert.notEqual(frozen.toolSurfaceDigest, current.toolSurfaceDigest)
  assert.equal(codexRequestToolsDigest(frozen), current.toolSurfaceDigest)
  assert.equal(codexRequestToolsDigest(current), current.toolSurfaceDigest)

  const tampered = [
    { ...frozen, toolSurfaceDigest: current.toolSurfaceDigest },
    { ...frozen, surfaceSnapshotDigest: current.surfaceSnapshotDigest },
    { ...frozen, responsesTools: [{ ...earlierResponsesTools[0], name: 'other_tool' }] },
    { ...frozen, dynamicTools: [{ ...frozen.dynamicTools[0], description: 'changed' }] },
  ]
  for (const value of tampered) {
    assert.throws(() => assertReadyToolSurface(value as typeof frozen), /tool_surface_digest_mismatch/)
  }
})

test('wire tool schema performs the pinned first compaction pass for large schemas', () => {
  const normalized = normalizeCodexDynamicToolSchema({
    type: 'object',
    description: 'root'.repeat(1_500),
    properties: {
      value: { type: 'string', description: 'nested description' },
    },
  })
  assert.deepEqual(normalized, {
    type: 'object',
    properties: { value: { type: 'string' } },
  })
})

test('surface rejects duplicate names, non-object schemas, and tampered snapshots', () => {
  assert.throws(
    () => buildReadyToolSurface({
      surfaceId: 'duplicate',
      toolDefinitions: [definition('same'), definition('same')],
    }),
    (error) => error instanceof CodexToolSurfaceError && error.code === 'tool_surface_name_conflict',
  )
  const invalid = definition('invalid')
  invalid.schema = { type: 'string' }
  assert.throws(
    () => buildReadyToolSurface({ surfaceId: 'invalid', toolDefinitions: [invalid] }),
    (error) => error instanceof CodexToolSurfaceError && error.code === 'tool_surface_schema_root_invalid',
  )
  const surface = buildReadyToolSurface({ surfaceId: 'tampered', toolDefinitions: [definition('read')] })
  assert.throws(
    () => assertReadyToolSurface({ ...surface, toolSurfaceDigest: 'tampered' }),
    (error) => error instanceof CodexToolSurfaceError && error.code === 'tool_surface_digest_mismatch',
  )
})

test('turn authorization is explicit, deterministic, and bound to the frozen surface', () => {
  const surface = buildReadyToolSurface({
    surfaceId: 'surface-auth',
    toolDefinitions: [definition('tool_b'), definition('tool_a')],
  })
  const authorization = buildReadyTurnToolAuthorization({
    authorizationId: 'authorization-1',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    toolSurface: surface,
  })
  assert.deepEqual(authorization.allowedToolNames, ['tool_a', 'tool_b'])
  assert.equal(authorization.skillAuthorization.mode, 'none')
  assert.match(authorization.authorizationDigest, /^[a-f0-9]{64}$/)
  const bound = buildReadyBoundTurnToolAuthorization({
    authorization,
    readySessionKey: 'alias-1',
    readyTaskId: 'task-1',
    readyRunId: 'run-1',
    scopeId: 'scope-1',
    toolSurfaceDigest: surface.toolSurfaceDigest,
    turnContractDigest: 'turn-contract-1',
    resourceAnchorDigest: 'resource-anchor-1',
    createdAt: '2026-08-07T00:00:00.000Z',
  })
  assert.match(bound.authorizationSnapshotDigest, /^[a-f0-9]{64}$/)
  assertReadyBoundTurnToolAuthorization(bound)

  const subset = buildReadyTurnToolAuthorization({
    authorizationId: 'authorization-subset',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    toolSurface: surface,
    allowedToolNames: ['tool_b'],
  })
  assert.deepEqual(subset.allowedToolNames, ['tool_b'])
  assert.throws(
    () => buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-outside',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: surface,
      allowedToolNames: ['unknown'],
    }),
    (error) => error instanceof CodexToolSurfaceError
      && error.code === 'tool_authorization_outside_surface',
  )
})

test('live executor resolution preserves the frozen surface and signs only the current subset', () => {
  let definitions = [definition('tool_a'), definition('tool_b')]
  let resolutions = 0
  const source = {
    listDefaultToolDefinitionsForTurn() {
      resolutions += 1
      return definitions
    },
  }
  const first = resolveReadyToolTurnSnapshot({
    surfaceId: 'surface-live',
    authorizationId: 'authorization-live-1',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    source,
    resolutionInput: {} as ReadyLiveToolResolutionInput,
  })
  definitions = [definition('tool_b')]
  const second = resolveReadyToolTurnSnapshot({
    surfaceId: 'ignored-for-frozen',
    authorizationId: 'authorization-live-2',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    source,
    resolutionInput: {} as ReadyLiveToolResolutionInput,
    frozenToolSurface: first.readyToolSurface,
  })
  assert.equal(resolutions, 2)
  assert.equal(second.readyToolSurface, first.readyToolSurface)
  assert.deepEqual(second.readyTurnToolAuthorization.allowedToolNames, ['tool_b'])

  const drifted = definition('tool_b')
  drifted.kind = 'write'
  definitions = [drifted]
  assert.throws(
    () => resolveReadyToolTurnSnapshot({
      surfaceId: 'ignored-for-frozen',
      authorizationId: 'authorization-live-3',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      source,
      resolutionInput: {} as ReadyLiveToolResolutionInput,
      frozenToolSurface: first.readyToolSurface,
    }),
    (error) => error instanceof CodexToolSurfaceError
      && error.code === 'ready_tool_execution_contract_changed',
  )
})

test('first Codex thread registers a safe root universe but authorizes only this turn subset', () => {
  const safeSkillPrimitive = {
    ...definition('skill_read_artifact'),
    groupId: 'skills' as const,
    domain: 'skill' as const,
    codexExecutionSafe: true,
  }
  const resolved = resolveReadyToolTurnSnapshot({
    surfaceId: 'surface-root-universe',
    authorizationId: 'authorization-root-universe',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    source: {
      listDefaultToolDefinitionsForTurn: () => [definition('tool_b')],
      listCodexThreadToolDefinitions: () => [
        definition('tool_a'),
        definition('tool_b'),
        { ...definition('use_browser'), groupId: 'skill_activation', domain: 'skill_activation' },
        { ...definition('use_skill'), groupId: 'skill_activation', domain: 'skill_activation' },
        { ...definition('browser_download'), groupId: 'browser_interaction', domain: 'browser' },
        {
          ...definition('skill_start_detached'),
          groupId: 'skills',
          domain: 'skill',
          codexExecutionSafe: true,
        },
        {
          ...definition('skill_mutable_action'),
          groupId: 'skills',
          domain: 'skill',
        },
        safeSkillPrimitive,
      ],
    },
    resolutionInput: {} as ReadyLiveToolResolutionInput,
  })

  assert.deepEqual(resolved.readyToolSurface.toolNames, [
    'skill_read_artifact',
    'tool_a',
    'tool_b',
  ])
  assert.deepEqual(resolved.readyTurnToolAuthorization.allowedToolNames, ['tool_b'])
})

test('Codex turn admission rejects skill tools whose results require frame-state consumers', () => {
  const unsafe = {
    ...definition('skill_start_detached'),
    groupId: 'skills' as const,
    domain: 'skill' as const,
    codexExecutionSafe: true,
  }
  assert.throws(
    () => resolveReadyToolTurnSnapshot({
      surfaceId: 'surface-unsupported-state',
      authorizationId: 'authorization-unsupported-state',
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'fixture',
        allowedTypedActions: [],
        allowedPrimitives: ['skill_start_detached'],
        source: 'explicit',
        reason: 'test_state_patch_rejection',
      }),
      source: { listDefaultToolDefinitionsForTurn: () => [unsafe] },
      resolutionInput: {} as ReadyLiveToolResolutionInput,
    }),
    (error) => error instanceof CodexToolSurfaceError
      && error.code === 'tool_surface_result_state_unsupported',
  )
})

test('Codex turn keeps research and folder tools when a selected skill also authorizes frame-state primitives', () => {
  const inspectRunState = {
    ...definition('skill_inspect_run_state'),
    groupId: 'skills' as const,
    domain: 'skill' as const,
    codexExecutionSafe: true,
  }
  const writeArtifact = {
    ...definition('skill_write_artifact'),
    groupId: 'skills' as const,
    domain: 'skill' as const,
    codexExecutionSafe: true,
  }
  const resolved = resolveReadyToolTurnSnapshot({
    surfaceId: 'surface-reference-skill-folder',
    authorizationId: 'authorization-reference-skill-folder',
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'surf-pro',
      allowedTypedActions: [],
      allowedPrimitives: ['skill_inspect_run_state', 'skill_write_artifact'],
      source: 'explicit',
      reason: 'typed_ref:explicit_user_mention',
    }),
    source: {
      listDefaultToolDefinitionsForTurn: () => [
        definition('web_search'),
        definition('file_write'),
        inspectRunState,
        writeArtifact,
      ],
    },
    resolutionInput: {} as ReadyLiveToolResolutionInput,
  })

  assert.deepEqual(resolved.readyToolSurface.toolNames, [
    'file_write',
    'skill_write_artifact',
    'web_search',
  ])
  assert.deepEqual(resolved.readyTurnToolAuthorization.allowedToolNames, [
    'file_write',
    'skill_write_artifact',
    'web_search',
  ])
})

test('Codex turn keeps supported browser tools while omitting browser_download state patches', () => {
  const resolved = resolveReadyToolTurnSnapshot({
    surfaceId: 'surface-browser-compatible',
    authorizationId: 'authorization-browser-compatible',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    source: {
      listDefaultToolDefinitionsForTurn: () => [
        { ...definition('browser_snapshot'), groupId: 'browser_interaction', domain: 'browser' },
        { ...definition('browser_click'), groupId: 'browser_interaction', domain: 'browser' },
        { ...definition('browser_download'), groupId: 'browser_interaction', domain: 'browser' },
      ],
    },
    resolutionInput: {} as ReadyLiveToolResolutionInput,
  })

  assert.deepEqual(resolved.readyToolSurface.toolNames, ['browser_click', 'browser_snapshot'])
  assert.deepEqual(
    resolved.readyTurnToolAuthorization.allowedToolNames,
    ['browser_click', 'browser_snapshot'],
  )
})

test('Codex turn admission rejects mutable skill execution programs', () => {
  const missing = {
    ...definition('skill_run_shell'),
    groupId: 'skills' as const,
    domain: 'skill' as const,
  }
  assert.throws(
    () => resolveReadyToolTurnSnapshot({
      surfaceId: 'surface-missing-authority',
      authorizationId: 'authorization-missing-authority',
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'fixture',
        allowedTypedActions: [],
        allowedPrimitives: ['skill_run_shell'],
        source: 'explicit',
        reason: 'test_missing_authority',
      }),
      source: { listDefaultToolDefinitionsForTurn: () => [missing] },
      resolutionInput: {} as ReadyLiveToolResolutionInput,
    }),
    (error) => error instanceof CodexToolSurfaceError
      && error.code === 'tool_surface_skill_execution_unsupported',
  )
})

test('Codex skill admission never executes mutable skill directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ready-codex-skill-authority-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const skill: SkillState = {
    id: 'fixture',
    name: 'Fixture',
    description: 'Fixture skill',
    version: '1.0.0',
    installed: true,
    installStatePath: join(root, 'install-state.json'),
    source: 'custom',
    sourcePath: root,
    managedPath: root,
    manifestValid: true,
    actions: [],
    executionMode: 'advisory',
  }

  assert.equal(isCodexSafeHostSkillPrimitiveDefinition(
    'skill_read_artifact',
    { id: 'incomplete-fixture' } as SkillState,
  ), true)
  assert.equal(isHostFolderExportPrimitive('skill_write_artifact'), true)
  assert.equal(isHostFolderExportPrimitive('skill_read_artifact'), true)
  assert.equal(isHostFolderExportPrimitive('skill_export_artifact'), true)
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition(
    'skill_write_artifact',
    { id: 'incomplete-fixture' } as SkillState,
  ), true)
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition('skill_read_artifact', skill), true)
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition('skill_run_shell', skill), false)

  mkdirSync(join(root, 'real-scripts'))
  symlinkSync(join(root, 'real-scripts'), join(root, 'scripts'))
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition('skill_read_artifact', skill), true)
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition('skill_write_artifact', skill), true)
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition('skill_export_artifact', skill), true)

  rmSync(join(root, 'scripts'))
  const typedSkill = {
    ...skill,
    actions: [{
      name: 'run',
      description: 'Mutable program',
      runtime: 'shell' as const,
      entry: 'safe.sh',
      params: [],
    }],
  }
  assert.equal(isCodexSafeHostSkillPrimitiveDefinition('skill_fixture_run', typedSkill), false)
})
