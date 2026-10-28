import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { AgentSdkToolExecutor } from '../runtime-core/agent-sdk-tool-executor'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { isToolStatePatchEmittingToolName } from '../contracts/skill-frame-patch-tool-names'
import type { CodexDynamicToolSpec } from './codex-native-runtime'
import { canonicalJson, digestCanonicalJson } from './codex-model-gateway-contract'

export type ReadyToolSurfaceEntry = Readonly<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schemaDigest: string
  effectProfileDigest: string
  effectProfile: Readonly<{
    groupId: ToolDefinition['groupId']
    domain: ToolDefinition['domain']
    kind: ToolDefinition['kind']
    concurrency: ToolDefinition['concurrency']
    interruptBehavior: ToolDefinition['interruptBehavior']
    timeoutProfile: ToolDefinition['timeoutProfile']
    executionTimeoutMs: number | null
    supportsTextBridge: boolean
    projectionHint: ToolDefinition['projectionHint']
    requiresExplicitAllowlist: boolean
    resultShape: ToolDefinition['resultShape']
  }>
}>

export type ReadyResponsesFunctionTool = Readonly<{
  type: 'function'
  name: string
  description: string
  strict: false
  parameters: Record<string, unknown>
}>

export type ReadyToolSurface = Readonly<{
  surfaceId: string
  toolSurfaceDigest: string
  surfaceSnapshotDigest: string
  toolNames: string[]
  entries: ReadyToolSurfaceEntry[]
  dynamicTools: CodexDynamicToolSpec[]
  responsesTools: ReadyResponsesFunctionTool[]
}>

export type SerializedSkillToolAuthorization =
  | Readonly<{
      mode: 'none'
      reason: Extract<SkillToolAuthorization, { mode: 'none' }>['reason']
      candidateSkillPrimitives?: Readonly<{
        skillId: string
        primitives: readonly string[]
      }>
    }>
  | Readonly<{
      mode: 'selected'
      skillId: string
      allowedTypedActions: string[]
      allowedPrimitives: string[]
      source: Extract<SkillToolAuthorization, { mode: 'selected' }>['source']
      reason: string
    }>

export type ReadyTurnToolAuthorization = Readonly<{
  authorizationId: string
  authorizationDigest: string
  allowedToolNames: string[]
  skillAuthorization: SerializedSkillToolAuthorization
}>

export type ReadyBoundTurnToolAuthorization = Readonly<{
  authorizationId: string
  authorizationDigest: string
  authorizationSnapshotDigest: string
  readySessionKey: string
  readyTaskId: string
  readyRunId: string
  scopeId: string
  toolSurfaceDigest: string
  turnContractDigest: string
  resourceAnchorDigest: string
  createdAt: string
  allowedToolNames: string[]
  skillAuthorization: SerializedSkillToolAuthorization
}>

export type ReadyLiveToolResolutionInput = Parameters<
  AgentSdkToolExecutor['listDefaultToolDefinitionsForTurn']
>[0]

export type ReadyLiveToolDefinitionSource = Readonly<{
  listDefaultToolDefinitionsForTurn(input: ReadyLiveToolResolutionInput): ToolDefinition[]
  listCodexThreadToolDefinitions?(): ToolDefinition[]
}>

export type ReadyToolTurnSnapshot = Readonly<{
  readyToolSurface: ReadyToolSurface
  readyTurnToolAuthorization: ReadyTurnToolAuthorization
}>

export type ReadyToolSurfaceCompatibility = Readonly<{
  kind:
    | 'compatible'
    | 'native_tool_surface_extension_required'
    | 'native_tool_definition_changed'
    | 'ready_tool_execution_contract_changed'
  addedToCurrentSubset: readonly string[]
  modelContractChangedToolNames: readonly string[]
  readyContractChangedToolNames: readonly string[]
  frozenOnlyToolNames: readonly string[]
  evidenceDigest: string
}>

export type ReadyToolSurfaceEntryCompatibility =
  | 'compatible'
  | 'native_tool_definition_changed'
  | 'ready_tool_execution_contract_changed'

export class CodexToolSurfaceError extends Error {
  constructor(
    readonly code: string,
    readonly compatibility: ReadyToolSurfaceCompatibility | null = null,
  ) {
    super(code)
    this.name = 'CodexToolSurfaceError'
  }
}

const CODEX_ROOT_EXCLUDED_CONTROL_TOOLS = new Set(['use_browser', 'use_skill', 'browser_download'])

export function selectCodexRootToolDefinitions(
  definitions: readonly ToolDefinition[],
): ToolDefinition[] {
  return definitions.filter((definition) => (
    !CODEX_ROOT_EXCLUDED_CONTROL_TOOLS.has(definition.name)
    && !isToolStatePatchEmittingToolName(definition.name)
    && (definition.domain !== 'skill' || definition.codexExecutionSafe === true)
  ))
}

export function digestCodexRootToolSurface(
  definitions: readonly ToolDefinition[],
): string {
  return buildReadyToolSurface({
    surfaceId: 'codex-root-surface',
    toolDefinitions: selectCodexRootToolDefinitions(definitions),
  }).toolSurfaceDigest
}

function nonEmpty(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new CodexToolSurfaceError(code)
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function canonicalObject(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CodexToolSurfaceError(code)
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>
}

const CODEX_SCHEMA_KEYS = new Set([
  '$ref',
  'type',
  'description',
  'encrypted',
  'enum',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  '$defs',
  'definitions',
  // Kept by the pinned 0.160.1 on any node; 0.149 dropped it.
  'minItems',
])
const CODEX_SCHEMA_TYPES = new Set([
  'string', 'number', 'boolean', 'integer', 'object', 'array', 'null',
])
const CODEX_SCHEMA_COMPACTION_BYTES = 5_000

function normalizeSchemaType(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return CODEX_SCHEMA_TYPES.has(value) ? value : undefined
  if (!Array.isArray(value)) return undefined
  const types = value.filter((item): item is string => (
    typeof item === 'string' && CODEX_SCHEMA_TYPES.has(item)
  ))
  return types.length > 0 ? [...new Set(types)] : undefined
}

function inferredSchemaType(value: Record<string, unknown>): string | string[] | undefined {
  const explicit = normalizeSchemaType(value.type)
  if (explicit) return explicit
  if ('$ref' in value || 'anyOf' in value || 'oneOf' in value || 'allOf' in value) return undefined
  if ('properties' in value || 'required' in value || 'additionalProperties' in value) return 'object'
  if ('items' in value || 'prefixItems' in value) return 'array'
  if ('enum' in value || 'format' in value) return 'string'
  if (
    'minimum' in value || 'maximum' in value || 'exclusiveMinimum' in value
    || 'exclusiveMaximum' in value || 'multipleOf' in value
  ) return 'number'
  return undefined
}

function schemaIncludesType(value: string | string[] | undefined, type: string): boolean {
  return value === type || (Array.isArray(value) && value.includes(type))
}

function normalizeCodexSchemaNode(value: unknown): unknown {
  if (typeof value === 'boolean') return { type: 'string' }
  if (Array.isArray(value)) return value.map(normalizeCodexSchemaNode)
  if (!isRecord(value)) return value

  const source = { ...value }
  if ('const' in source) {
    source.enum = [source.const]
    delete source.const
  }
  const schemaType = inferredSchemaType(source)
  if (!schemaType) {
    if ('$ref' in source || 'anyOf' in source || 'oneOf' in source || 'allOf' in source) {
      // Composition and reference-only nodes are valid without an explicit type.
    } else {
      return {}
    }
  } else {
    source.type = schemaType
  }
  if (schemaIncludesType(schemaType, 'object') && !isRecord(source.properties)) source.properties = {}
  if (schemaIncludesType(schemaType, 'array') && source.items === undefined) {
    source.items = { type: 'string' }
  }

  const output: Record<string, unknown> = {}
  for (const key of CODEX_SCHEMA_KEYS) {
    if (!(key in source)) continue
    const child = source[key]
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      if (!isRecord(child)) continue
      output[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, normalizeCodexSchemaNode(schema)]),
      )
    } else if (key === 'items') {
      output[key] = normalizeCodexSchemaNode(child)
    } else if (key === 'additionalProperties') {
      output[key] = typeof child === 'boolean' ? child : normalizeCodexSchemaNode(child)
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (Array.isArray(child)) output[key] = child.map(normalizeCodexSchemaNode)
    } else if (key === 'minItems') {
      // The runtime refuses the whole tool at thread start for any other value.
      if (!Number.isSafeInteger(child) || (child as number) < 0) {
        throw new CodexToolSurfaceError('tool_surface_schema_invalid')
      }
      output[key] = child
    } else {
      output[key] = child
    }
  }
  return output
}

function stripCodexSchemaDescriptions(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripCodexSchemaDescriptions)
    return
  }
  if (!isRecord(value)) return
  delete value.description
  Object.values(value).forEach(stripCodexSchemaDescriptions)
}

export function normalizeCodexDynamicToolSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeCodexSchemaNode(inputSchema)
  if (!isRecord(normalized)) throw new CodexToolSurfaceError('tool_surface_schema_normalization_invalid')
  if (Buffer.byteLength(JSON.stringify(normalized)) > CODEX_SCHEMA_COMPACTION_BYTES) {
    stripCodexSchemaDescriptions(normalized)
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > CODEX_SCHEMA_COMPACTION_BYTES) {
    throw new CodexToolSurfaceError('tool_surface_schema_compaction_unsupported')
  }
  return canonicalObject(normalized, 'tool_surface_schema_normalization_invalid')
}

function uniqueSorted(values: Iterable<string>, code: string): string[] {
  const normalized = [...values].map((value) => nonEmpty(value, code)).sort()
  if (new Set(normalized).size !== normalized.length) throw new CodexToolSurfaceError(code)
  return normalized
}

function serializeAuthorization(authorization: SkillToolAuthorization): SerializedSkillToolAuthorization {
  if (authorization.mode === 'none') {
    return authorization.candidateSkillPrimitives
      ? {
          mode: 'none',
          reason: authorization.reason,
          candidateSkillPrimitives: {
            skillId: authorization.candidateSkillPrimitives.skillId,
            primitives: [...authorization.candidateSkillPrimitives.primitives].sort(),
          },
        }
      : { mode: 'none', reason: authorization.reason }
  }
  return {
    mode: 'selected',
    skillId: nonEmpty(authorization.skillId, 'tool_authorization_skill_id_invalid'),
    allowedTypedActions: uniqueSorted(
      authorization.allowedTypedActions,
      'tool_authorization_typed_actions_invalid',
    ),
    allowedPrimitives: uniqueSorted(
      authorization.allowedPrimitives,
      'tool_authorization_primitives_invalid',
    ),
    source: authorization.source,
    reason: nonEmpty(authorization.reason, 'tool_authorization_reason_invalid'),
  }
}

/** The request `tools` the pinned runtime sends for a thread's dynamic tools. */
function codexRequestTools(dynamicTools: readonly CodexDynamicToolSpec[]): ReadyResponsesFunctionTool[] {
  return dynamicTools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: false,
    parameters: normalizeCodexDynamicToolSchema(tool.inputSchema),
  }))
}

/**
 * What the pinned runtime sends for a frozen surface. A surface frozen under an earlier runtime keeps its
 * `responsesTools` and `toolSurfaceDigest` as lineage; a later runtime may serialize the same dynamic tools
 * differently (0.160.1 keeps `minItems`, 0.149 dropped it), so the wire is always derived from `dynamicTools`.
 */
export function codexRequestToolsDigest(surface: Pick<ReadyToolSurface, 'dynamicTools'>): string {
  return digestCanonicalJson(codexRequestTools(surface.dynamicTools))
}

export function buildReadyToolSurface(input: {
  surfaceId: string
  toolDefinitions: readonly ToolDefinition[]
}): ReadyToolSurface {
  const surfaceId = nonEmpty(input.surfaceId, 'tool_surface_id_invalid')
  const definitions = [...input.toolDefinitions]
    .filter((definition) => definition.executionVisibility === 'model')
    .sort((left, right) => left.name.localeCompare(right.name))
  const names = uniqueSorted(definitions.map((definition) => definition.name), 'tool_surface_name_conflict')
  const entries = definitions.map<ReadyToolSurfaceEntry>((definition) => {
    const name = nonEmpty(definition.name, 'tool_surface_name_invalid')
    if (name !== definition.name) throw new CodexToolSurfaceError('tool_surface_name_invalid')
    const description = nonEmpty(definition.description, 'tool_surface_description_invalid')
    const inputSchema = canonicalObject(
      definition.schema || { type: 'object', properties: {}, additionalProperties: false },
      'tool_surface_schema_invalid',
    )
    if (inputSchema.type !== 'object') throw new CodexToolSurfaceError('tool_surface_schema_root_invalid')
    const effectProfile = {
      groupId: definition.groupId,
      domain: definition.domain,
      kind: definition.kind,
      concurrency: definition.concurrency,
      interruptBehavior: definition.interruptBehavior,
      timeoutProfile: definition.timeoutProfile,
      executionTimeoutMs: definition.executionTimeoutMs ?? null,
      supportsTextBridge: definition.supportsTextBridge,
      projectionHint: definition.projectionHint
        ? (canonicalObject(
            definition.projectionHint,
            'tool_surface_projection_hint_invalid',
          ) as ToolDefinition['projectionHint'])
        : null,
      requiresExplicitAllowlist: definition.requiresExplicitAllowlist === true,
      resultShape: definition.resultShape,
    }
    return {
      name,
      description,
      inputSchema,
      schemaDigest: digestCanonicalJson(inputSchema),
      effectProfileDigest: digestCanonicalJson(effectProfile),
      effectProfile,
    }
  })
  const dynamicTools = entries.map<CodexDynamicToolSpec>((entry) => ({
    type: 'function',
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
  }))
  const responsesTools = codexRequestTools(dynamicTools)
  const snapshot = { entries, dynamicTools, responsesTools }
  return deepFreeze({
    surfaceId,
    toolSurfaceDigest: digestCanonicalJson(responsesTools),
    surfaceSnapshotDigest: digestCanonicalJson(snapshot),
    toolNames: names,
    entries,
    dynamicTools,
    responsesTools,
  })
}

export function buildReadyTurnToolAuthorization(input: {
  authorizationId: string
  authorization: SkillToolAuthorization
  toolSurface: ReadyToolSurface
  allowedToolNames?: readonly string[]
}): ReadyTurnToolAuthorization {
  const authorizationId = nonEmpty(input.authorizationId, 'tool_authorization_id_invalid')
  assertReadyToolSurface(input.toolSurface)
  const skillAuthorization = serializeAuthorization(input.authorization)
  const allowedToolNames = uniqueSorted(
    input.allowedToolNames ?? input.toolSurface.toolNames,
    'tool_authorization_allowed_names_invalid',
  )
  if (allowedToolNames.some((name) => !input.toolSurface.toolNames.includes(name))) {
    throw new CodexToolSurfaceError('tool_authorization_outside_surface')
  }
  const unsigned = { authorizationId, allowedToolNames, skillAuthorization }
  return deepFreeze({
    ...unsigned,
    authorizationDigest: digestCanonicalJson(unsigned),
  })
}

export function assertReadyToolSurface(value: ReadyToolSurface): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'surfaceId',
      'toolSurfaceDigest',
      'surfaceSnapshotDigest',
      'toolNames',
      'entries',
      'dynamicTools',
      'responsesTools',
    ])
    || !Array.isArray(value.entries)
    || !Array.isArray(value.toolNames)
    || !Array.isArray(value.dynamicTools)
    || !Array.isArray(value.responsesTools)
  ) throw new CodexToolSurfaceError('tool_surface_shape_invalid')
  const rebuilt = buildReadyToolSurface({
    surfaceId: value.surfaceId,
    toolDefinitions: value.entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      schema: entry.inputSchema as ToolDefinition['schema'],
      groupId: entry.effectProfile.groupId,
      domain: entry.effectProfile.domain,
      kind: entry.effectProfile.kind,
      concurrency: entry.effectProfile.concurrency,
      interruptBehavior: entry.effectProfile.interruptBehavior,
      timeoutProfile: entry.effectProfile.timeoutProfile,
      executionTimeoutMs: entry.effectProfile.executionTimeoutMs ?? undefined,
      supportsTextBridge: entry.effectProfile.supportsTextBridge,
      projectionHint: entry.effectProfile.projectionHint,
      executionVisibility: 'model',
      requiresExplicitAllowlist: entry.effectProfile.requiresExplicitAllowlist,
      resultShape: entry.effectProfile.resultShape,
    })),
  })
  // The runtime-independent surface must rebuild exactly. `responsesTools` is the creating runtime's serialization
  // of these dynamic tools and the two digests are its lineage identity: they must pair with the tools and match
  // what was stored, but a later runtime's serialization (codexRequestToolsDigest) may differ.
  if (
    canonicalJson(rebuilt.entries) !== canonicalJson(value.entries)
    || canonicalJson(rebuilt.dynamicTools) !== canonicalJson(value.dynamicTools)
    || canonicalJson(rebuilt.toolNames) !== canonicalJson(value.toolNames)
    || value.responsesTools.length !== value.dynamicTools.length
    || value.responsesTools.some((tool, index) => (
      !isRecord(tool)
      || !hasExactKeys(tool, ['type', 'name', 'description', 'strict', 'parameters'])
      || tool.type !== 'function'
      || tool.strict !== false
      || tool.name !== value.dynamicTools[index].name
      || tool.description !== value.dynamicTools[index].description
      || !isRecord(tool.parameters)
    ))
    || digestCanonicalJson(value.responsesTools) !== value.toolSurfaceDigest
    || digestCanonicalJson({
      entries: value.entries,
      dynamicTools: value.dynamicTools,
      responsesTools: value.responsesTools,
    }) !== value.surfaceSnapshotDigest
  ) throw new CodexToolSurfaceError('tool_surface_digest_mismatch')
}

export function compareReadyToolSurfaceCompatibility(input: {
  frozen: ReadyToolSurface
  current: ReadyToolSurface
}): ReadyToolSurfaceCompatibility {
  assertReadyToolSurface(input.frozen)
  assertReadyToolSurface(input.current)
  const frozenByName = new Map(input.frozen.entries.map((entry) => [entry.name, entry]))
  const currentByName = new Map(input.current.entries.map((entry) => [entry.name, entry]))
  const addedToCurrentSubset: string[] = []
  const modelContractChangedToolNames: string[] = []
  const readyContractChangedToolNames: string[] = []
  for (const currentEntry of input.current.entries) {
    const frozenEntry = frozenByName.get(currentEntry.name)
    if (!frozenEntry) {
      addedToCurrentSubset.push(currentEntry.name)
      continue
    }
    const entryCompatibility = compareReadyToolSurfaceEntry(frozenEntry, currentEntry)
    if (entryCompatibility === 'native_tool_definition_changed') {
      modelContractChangedToolNames.push(currentEntry.name)
      continue
    }
    if (entryCompatibility === 'ready_tool_execution_contract_changed') {
      readyContractChangedToolNames.push(currentEntry.name)
    }
  }
  const frozenOnlyToolNames = input.frozen.toolNames.filter((name) => !currentByName.has(name))
  const kind: ReadyToolSurfaceCompatibility['kind'] = addedToCurrentSubset.length > 0
    ? 'native_tool_surface_extension_required'
    : modelContractChangedToolNames.length > 0
      ? 'native_tool_definition_changed'
      : readyContractChangedToolNames.length > 0
        ? 'ready_tool_execution_contract_changed'
        : 'compatible'
  const unsigned = {
    contract: 'ready_tool_surface_compatibility_v1',
    kind,
    addedToCurrentSubset: addedToCurrentSubset.sort(),
    modelContractChangedToolNames: modelContractChangedToolNames.sort(),
    readyContractChangedToolNames: readyContractChangedToolNames.sort(),
    frozenOnlyToolNames: frozenOnlyToolNames.sort(),
  }
  return { ...unsigned, evidenceDigest: digestCanonicalJson(unsigned) }
}

export function compareReadyToolSurfaceEntry(
  frozenEntry: ReadyToolSurfaceEntry,
  currentEntry: ReadyToolSurfaceEntry,
): ReadyToolSurfaceEntryCompatibility {
  if (frozenEntry.name !== currentEntry.name
    || frozenEntry.description !== currentEntry.description
    || frozenEntry.schemaDigest !== currentEntry.schemaDigest
    || canonicalJson(frozenEntry.inputSchema) !== canonicalJson(currentEntry.inputSchema)) {
    return 'native_tool_definition_changed'
  }
  if (frozenEntry.effectProfileDigest !== currentEntry.effectProfileDigest
    || canonicalJson(frozenEntry.effectProfile) !== canonicalJson(currentEntry.effectProfile)) {
    return 'ready_tool_execution_contract_changed'
  }
  return 'compatible'
}

export function resolveReadyToolTurnSnapshot(input: {
  surfaceId: string
  authorizationId: string
  authorization: SkillToolAuthorization
  source: ReadyLiveToolDefinitionSource
  resolutionInput: ReadyLiveToolResolutionInput
  frozenToolSurface?: ReadyToolSurface
}): ReadyToolTurnSnapshot {
  const listed = input.source.listDefaultToolDefinitionsForTurn(input.resolutionInput)
  const toolDefinitions = listed.filter((definition) => (
    !CODEX_ROOT_EXCLUDED_CONTROL_TOOLS.has(definition.name)
    && !isToolStatePatchEmittingToolName(definition.name)
    && (definition.domain !== 'skill' || definition.codexExecutionSafe === true)
  ))
  if (toolDefinitions.length === 0) {
    if (listed.some((definition) => isToolStatePatchEmittingToolName(definition.name))) {
      throw new CodexToolSurfaceError('tool_surface_result_state_unsupported')
    }
    if (listed.some((definition) => (
      definition.domain === 'skill' && definition.codexExecutionSafe !== true
    ))) {
      throw new CodexToolSurfaceError('tool_surface_skill_execution_unsupported')
    }
  }
  const resolved = buildReadyToolSurface({
    surfaceId: input.frozenToolSurface?.surfaceId || input.surfaceId,
    toolDefinitions,
  })
  const frozen = input.frozenToolSurface || buildReadyToolSurface({
    surfaceId: input.surfaceId,
    toolDefinitions: selectCodexRootToolDefinitions(
      input.source.listCodexThreadToolDefinitions?.() || toolDefinitions,
    ),
  })
  assertReadyToolSurface(frozen)
  const compatibility = compareReadyToolSurfaceCompatibility({ frozen, current: resolved })
  if (compatibility.kind !== 'compatible') {
    throw new CodexToolSurfaceError(compatibility.kind, compatibility)
  }
  return deepFreeze({
    readyToolSurface: frozen,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: input.authorizationId,
      authorization: input.authorization,
      toolSurface: frozen,
      allowedToolNames: resolved.toolNames,
    }),
  })
}

export function assertReadyTurnToolAuthorization(value: ReadyTurnToolAuthorization): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'authorizationId',
      'authorizationDigest',
      'allowedToolNames',
      'skillAuthorization',
    ])
    || !Array.isArray(value.allowedToolNames)
    || !isRecord(value.skillAuthorization)
  ) throw new CodexToolSurfaceError('tool_authorization_shape_invalid')
  const skillAuthorization = value.skillAuthorization
  if (skillAuthorization.mode === 'none') {
    const noneKeys = skillAuthorization.candidateSkillPrimitives
      ? ['mode', 'reason', 'candidateSkillPrimitives']
      : ['mode', 'reason']
    if (
      !hasExactKeys(skillAuthorization, noneKeys)
      || ![
        'no_skill_signal',
        'turn_not_skill_resume',
        'config_repair_no_recoverable_task',
      ].includes(String(skillAuthorization.reason))
      || (
        skillAuthorization.candidateSkillPrimitives
        && (
          !isRecord(skillAuthorization.candidateSkillPrimitives)
          || typeof skillAuthorization.candidateSkillPrimitives.skillId !== 'string'
          || !skillAuthorization.candidateSkillPrimitives.skillId.trim()
          || !Array.isArray(skillAuthorization.candidateSkillPrimitives.primitives)
        )
      )
    ) throw new CodexToolSurfaceError('tool_authorization_skill_shape_invalid')
  } else if (skillAuthorization.mode === 'selected') {
    if (
      !hasExactKeys(skillAuthorization, [
        'mode',
        'skillId',
        'allowedTypedActions',
        'allowedPrimitives',
        'source',
        'reason',
      ])
      || typeof skillAuthorization.skillId !== 'string'
      || !skillAuthorization.skillId.trim()
      || !Array.isArray(skillAuthorization.allowedTypedActions)
      || !Array.isArray(skillAuthorization.allowedPrimitives)
      || !['explicit', 'trusted_resume', 'active_task'].includes(String(skillAuthorization.source))
      || typeof skillAuthorization.reason !== 'string'
      || !skillAuthorization.reason.trim()
    ) throw new CodexToolSurfaceError('tool_authorization_skill_shape_invalid')
    if (
      canonicalJson(skillAuthorization.allowedTypedActions) !== canonicalJson(uniqueSorted(
        skillAuthorization.allowedTypedActions,
        'tool_authorization_typed_actions_invalid',
      ))
      || canonicalJson(skillAuthorization.allowedPrimitives) !== canonicalJson(uniqueSorted(
        skillAuthorization.allowedPrimitives,
        'tool_authorization_primitives_invalid',
      ))
    ) throw new CodexToolSurfaceError('tool_authorization_skill_order_invalid')
  } else {
    throw new CodexToolSurfaceError('tool_authorization_skill_shape_invalid')
  }
  const allowedToolNames = uniqueSorted(
    value.allowedToolNames,
    'tool_authorization_allowed_names_invalid',
  )
  if (canonicalJson(allowedToolNames) !== canonicalJson(value.allowedToolNames)) {
    throw new CodexToolSurfaceError('tool_authorization_allowed_names_order_invalid')
  }
  const unsigned = {
    authorizationId: nonEmpty(value.authorizationId, 'tool_authorization_id_invalid'),
    allowedToolNames,
    skillAuthorization,
  }
  if (digestCanonicalJson(unsigned) !== value.authorizationDigest) {
    throw new CodexToolSurfaceError('tool_authorization_digest_mismatch')
  }
}

export function buildReadyBoundTurnToolAuthorization(input: {
  authorization: ReadyTurnToolAuthorization
  readySessionKey: string
  readyTaskId: string
  readyRunId: string
  scopeId: string
  toolSurfaceDigest: string
  turnContractDigest: string
  resourceAnchorDigest: string
  createdAt: string
}): ReadyBoundTurnToolAuthorization {
  assertReadyTurnToolAuthorization(input.authorization)
  const unsigned = {
    authorizationId: input.authorization.authorizationId,
    authorizationDigest: input.authorization.authorizationDigest,
    readySessionKey: nonEmpty(input.readySessionKey, 'tool_authorization_session_key_invalid'),
    readyTaskId: nonEmpty(input.readyTaskId, 'tool_authorization_task_id_invalid'),
    readyRunId: nonEmpty(input.readyRunId, 'tool_authorization_run_id_invalid'),
    scopeId: nonEmpty(input.scopeId, 'tool_authorization_scope_id_invalid'),
    toolSurfaceDigest: nonEmpty(
      input.toolSurfaceDigest,
      'tool_authorization_surface_digest_invalid',
    ),
    turnContractDigest: nonEmpty(
      input.turnContractDigest,
      'tool_authorization_turn_contract_invalid',
    ),
    resourceAnchorDigest: nonEmpty(
      input.resourceAnchorDigest,
      'tool_authorization_resource_anchor_invalid',
    ),
    createdAt: nonEmpty(input.createdAt, 'tool_authorization_created_at_invalid'),
    allowedToolNames: [...input.authorization.allowedToolNames],
    skillAuthorization: input.authorization.skillAuthorization,
  }
  return deepFreeze({
    ...unsigned,
    authorizationSnapshotDigest: digestCanonicalJson(unsigned),
  })
}

export function assertReadyBoundTurnToolAuthorization(value: ReadyBoundTurnToolAuthorization): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'authorizationId',
      'authorizationDigest',
      'authorizationSnapshotDigest',
      'readySessionKey',
      'readyTaskId',
      'readyRunId',
      'scopeId',
      'toolSurfaceDigest',
      'turnContractDigest',
      'resourceAnchorDigest',
      'createdAt',
      'allowedToolNames',
      'skillAuthorization',
    ])
  ) throw new CodexToolSurfaceError('tool_bound_authorization_shape_invalid')
  assertReadyTurnToolAuthorization({
    authorizationId: value.authorizationId,
    authorizationDigest: value.authorizationDigest,
    allowedToolNames: value.allowedToolNames,
    skillAuthorization: value.skillAuthorization,
  })
  const unsigned = {
    authorizationId: value.authorizationId,
    authorizationDigest: value.authorizationDigest,
    readySessionKey: nonEmpty(value.readySessionKey, 'tool_authorization_session_key_invalid'),
    readyTaskId: nonEmpty(value.readyTaskId, 'tool_authorization_task_id_invalid'),
    readyRunId: nonEmpty(value.readyRunId, 'tool_authorization_run_id_invalid'),
    scopeId: nonEmpty(value.scopeId, 'tool_authorization_scope_id_invalid'),
    toolSurfaceDigest: nonEmpty(value.toolSurfaceDigest, 'tool_authorization_surface_digest_invalid'),
    turnContractDigest: nonEmpty(value.turnContractDigest, 'tool_authorization_turn_contract_invalid'),
    resourceAnchorDigest: nonEmpty(value.resourceAnchorDigest, 'tool_authorization_resource_anchor_invalid'),
    createdAt: nonEmpty(value.createdAt, 'tool_authorization_created_at_invalid'),
    allowedToolNames: value.allowedToolNames,
    skillAuthorization: value.skillAuthorization,
  }
  if (digestCanonicalJson(unsigned) !== value.authorizationSnapshotDigest) {
    throw new CodexToolSurfaceError('tool_bound_authorization_digest_mismatch')
  }
}
