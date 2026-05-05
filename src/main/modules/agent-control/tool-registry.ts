import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ZodObject, ZodRawShape } from 'zod'
import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { getToolResourceTag } from './tool-parallelism-policy'
import type {
  ToolConcurrency,
  ToolDefinition,
  ToolDefinitionSchema,
  ToolDomain,
  ToolExecutionVisibility,
  ToolInterruptBehavior,
  ToolKind,
  ToolProjectionHint,
  ToolTimeoutProfile,
} from './tool-definition'
import { getCalendarAnthropicTools, getCalendarOpenAITools } from '../tools/calendar-tools'
import {
  BROWSER_CONTENT_TASK_TOOL_NAMES,
  BROWSER_INTERACTION_TOOL_NAMES,
  getBrowserAnthropicTools,
  getBrowserOpenAITools,
} from '../tools/browser-tool-catalog'
import { getDocumentAnthropicTools, getDocumentOpenAITools } from '../tools/document-tools'
// Import the metadata-only entry point (`file-management-tool-defs`) rather than
// the executor entry (`file-management-tools`). The executor module transitively
// pulls in `search-engine/ipc-handler` -> `document-engine/ipc-handler` ->
// `electron` (BrowserWindow), which crashes 13 test files on module load under
// `tsx --test` where `electron` is a stub. This mirrors how
// `STATIC_SKILL_TOOL_NAMES_BOOT_SAFE` is imported from `skills-tools-static`
// instead of `skills-tools` for the same reason. See lines 35-46 above for why
// lazyRequire is NOT used here (electron-vite bundle resolution regressed
// `createRequire(import.meta.url)`-based paths in production).
import {
  FILE_MANAGEMENT_TOOL_NAMES,
  getFileManagementAnthropicTools,
  getFileManagementOpenAITools,
} from '../tools/file-management-tool-defs'
import { getFeishuAnthropicTools, getFeishuOpenAITools } from '../tools/feishu-tools'
import { getMemoryAnthropicTools, getMemoryOpenAITools } from '../tools/memory-tools'
import { getPetAnthropicTools, getPetOpenAITools } from '../tools/pet-tools'
import { getRSSAnthropicTools, getRSSOpenAITools } from '../tools/rss-tools'
import { getSessionRecallAnthropicTools, getSessionRecallOpenAITools } from '../tools/session-recall-tools'
import {
  STATIC_SKILL_ACTIONS_BY_TOOL_NAME,
  STATIC_SKILL_TOOL_NAMES_BOOT_SAFE,
} from '../tools/skills-tools-static'
import { PRIMITIVE_TOOL_NAME_SET } from '../tools/skill-primitives/tool-defs'
import { shouldExposeSkillPrimitive } from '../tools/skill-tool-session-gate'
import { normalizeToolJsonSchema } from '../tools/tool-schema'
import {
  buildSkillToolName,
  findSkillToolByNameForExecution,
  getSkillActionSchemas,
  getSkillAnthropicTools,
  getSkillOpenAITools,
  getSkillToolDefsForRegistry,
} from '../tools/skills-tools'
import { getToolInputSchemas } from '../tools/schemas'
import { getSystemAnthropicTools, getSystemOpenAITools } from '../tools/system-tools'
import { getLastReferenceSkill } from './skill-reference-hints'
import { resolveActiveSkillContext } from './active-skill-context'
import { hasActiveSkillTaskRun } from './skill-task-tracker'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from './tool-result-types'
import type {
  SkillRunResult,
  SkillsRuntimeManager,
} from '../skills-runtime/runtime-manager'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import { snapshotTurnFeatureFlags } from './turn-feature-flags'

// skills-tools / system-tools transitively import SkillsRuntimeManager (which
// imports `electron`). Top-level imports are required here because electron-vite
// bundles the main process into a single file — a previous `createRequire(import.meta.url)`
// based lazy-require pattern resolved relative paths against the bundle directory
// at runtime and always failed with "Cannot find module '../tools/skills-tools'",
// silently falling back to STATIC_SKILL_TOOL_NAMES so user-installed custom skills
// (e.g. `skill_novel_writer_system_read_skill`) never appeared in the tool list.
// In test contexts `electron`'s node entry exports a string, so `app` is undefined;
// import succeeds and the downstream `getSkillsRuntimeManager()` call throws at
// method-invocation time. The try/catch wrappers below ensure graceful fallback
// to static names in that situation.

export type ToolSchemaFormat = 'anthropic' | 'openai'

export interface ToolRegistryProvider {
  staticToolNames?: readonly string[]
  hasDynamicSource?: boolean
  getToolDefinitions?: () => ToolDefinition[]
  // `sessionId` is optional and providers can ignore it. It is currently only
  // consumed by the `skills` group to gate workflow-control tools when no
  // active execution exists (B plan Phase 0).
  getToolDefinitionsDetailed?: (sessionId?: string) => ToolDefinitionResolution
  getAnthropicTools?: () => Array<Record<string, unknown>>
  getAnthropicToolsDetailed?: (sessionId?: string) => ToolSchemaResolution
  getOpenAITools?: () => Array<Record<string, unknown>>
  getOpenAIToolsDetailed?: (sessionId?: string) => ToolSchemaResolution
}

export interface ToolRegistryOptions {
  __testGroupProviders?: Partial<Record<CapabilityGroupId, ToolRegistryProvider>>
}

export interface ToolRegistryReader {
  hasDynamicSource(groupId: CapabilityGroupId): boolean
  getToolDefinition(toolName: string): ToolDefinition | null
  getToolDefinitionForExecution(toolName: string): ToolDefinition | null
  listToolDefinitions(): ToolDefinition[]
  getToolDefinitionsForGroup(groupId: CapabilityGroupId, sessionId?: string): ToolDefinition[]
  getToolSchemasForGroup(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId?: string,
  ): Array<Record<string, unknown>>
}

export interface ToolDefinitionResolution {
  definitions: ToolDefinition[]
  error?: string | null
  usedStaticFallback?: boolean
}

export interface ToolSchemaResolution {
  tools: Array<Record<string, unknown>>
  error?: string | null
  usedStaticFallback?: boolean
}

const DOCUMENT_TOOL_NAMES = [
  'document_new_tab',
  'document_open_tab',
  'document_switch_tab',
  'document_rename_tab',
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_list_widgets',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
  'document_save_tab',
]

const RSS_TOOL_NAMES = [
  'rss_add_source',
  'rss_fetch_updates',
  'rss_select_item',
  'rss_analyze_item',
  'rss_capture_session',
]

const CALENDAR_TOOL_NAMES = [
  'calendar_list_window',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_capture_session',
]

const FEISHU_TOOL_NAMES = [
  'feishu_doc_read',
  'feishu_doc_create',
  'feishu_doc_update',
  'feishu_doc_list',
  'feishu_message_send',
  'feishu_message_get_context',
  'feishu_message_reply',
  'feishu_calendar_list_events',
  'feishu_calendar_create_event',
  'feishu_calendar_update_event',
  'feishu_calendar_delete_event',
  'feishu_chat_list',
  'feishu_chat_get_members',
  'feishu_chat_get_info',
  'feishu_file_upload',
  'feishu_file_download',
]

const MEMORY_TOOL_NAMES = [
  'memory_create',
  'memory_search',
  'memory_update',
  'memory_list_recent',
]

const SESSION_RECALL_TOOL_NAMES = ['session_search']
const PET_TOOL_NAMES = ['pet_show_sticky_note', 'pet_dismiss_sticky_note', 'pet_clear_sticky_notes']
const SYSTEM_TOOL_NAMES = ['system_run_embedded_python', 'system_run_openclaw']

interface StaticSkillActionMeta {
  skillId: string
  actionName: string
  visibility: string
  timeoutMs?: number
  exposeWhenHintArmed: string[]
}

let staticSkillActionMetaCache: Map<string, StaticSkillActionMeta> | null = null

const BROWSER_JOB_TOOL_NAMES = new Set([
  'browser_start_task',
  'browser_get_task',
  'browser_resume_task',
  'browser_cancel_task',
  'browser_aggregate_results',
  'browser_download_gallery',
  'browser_research_topic',
  'browser_run_workflow',
])

const BROWSER_READ_TOOL_NAMES = new Set([
  'browser_collect_images',
  'browser_extract_structured',
  'browser_scroll_collect',
])

const BROWSER_WRITE_TOOL_NAMES = new Set(['browser_download_urls'])
const PROJECTION_PATCH_TOOL_DOMAINS = new Set<ToolDomain>(['skill'])
const PROJECTION_PATCH_DOCUMENT_TOOL_NAMES = new Set<string>([
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_save_tab',
])

function getOpenAIToolName(tool: Record<string, unknown>): string | null {
  const fn = tool.function && typeof tool.function === 'object'
    ? tool.function as { name?: unknown }
    : null
  return typeof fn?.name === 'string' ? fn.name : null
}

function getAnthropicToolName(tool: Record<string, unknown>): string | null {
  return typeof tool.name === 'string' ? tool.name : null
}

function createStaticFallbackSchema(toolName: string, format: ToolSchemaFormat): Record<string, unknown> {
  if (format === 'anthropic') {
    return {
      name: toolName,
      description: `${toolName} fallback schema`,
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    }
  }

  return {
    type: 'function',
    function: {
      name: toolName,
      description: `${toolName} fallback schema`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  }
}

function parsePositiveTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readStaticSkillActionMeta(): Map<string, StaticSkillActionMeta> {
  if (staticSkillActionMetaCache) return staticSkillActionMetaCache
  const meta = new Map<string, StaticSkillActionMeta>()
  const root = join(process.cwd(), 'assets', 'embedded-skills')
  if (!existsSync(root)) {
    staticSkillActionMetaCache = meta
    return meta
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, entry.name, 'ready-skill.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        id?: unknown
        actions?: unknown
        host_requirements?: {
          default_action_timeout_ms?: unknown
          expose_when_hint_armed?: unknown
        }
      }
      const skillId = typeof manifest.id === 'string' ? manifest.id : entry.name
      const actions = Array.isArray(manifest.actions) ? manifest.actions : []
      const exposeWhenHintArmed = Array.isArray(manifest.host_requirements?.expose_when_hint_armed)
        ? manifest.host_requirements!.expose_when_hint_armed.filter((item): item is string => typeof item === 'string')
        : []
      for (const rawAction of actions) {
        if (!rawAction || typeof rawAction !== 'object') continue
        const action = rawAction as { name?: unknown; visibility?: unknown; timeoutMs?: unknown; timeout_ms?: unknown }
        if (typeof action.name !== 'string') continue
        const byStaticAlias = Object.entries(STATIC_SKILL_ACTIONS_BY_TOOL_NAME)
          .filter(([, ref]) => ref.skillId === skillId && ref.actionName === action.name)
          .map(([toolName]) => toolName)
        for (const toolName of byStaticAlias) {
          meta.set(toolName, {
            skillId,
            actionName: action.name,
            visibility: typeof action.visibility === 'string' ? action.visibility : 'public',
            timeoutMs: parsePositiveTimeout(action.timeoutMs)
              || parsePositiveTimeout(action.timeout_ms)
              || parsePositiveTimeout(manifest.host_requirements?.default_action_timeout_ms),
            exposeWhenHintArmed,
          })
        }
      }
    } catch {
      continue
    }
  }
  staticSkillActionMetaCache = meta
  return meta
}

function getStaticSkillActionMeta(toolName: string): StaticSkillActionMeta | null {
  return readStaticSkillActionMeta().get(toolName) || null
}

function isStaticSkillToolVisible(toolName: string, sessionId?: string): boolean {
  const activeSkillContext = sessionId ? resolveActiveSkillContext({ sessionId }) : null
  if (PRIMITIVE_TOOL_NAME_SET.has(toolName)) {
    return shouldExposeSkillPrimitive(
      sessionId,
      () => false,
      (sid) => getLastReferenceSkill(sid) !== null,
      (sid) => Boolean(activeSkillContext && sid === sessionId),
      hasActiveSkillTaskRun,
    )
  }
  const meta = getStaticSkillActionMeta(toolName)
  if (!meta || meta.visibility !== 'internal') return true
  if (!sessionId) return false
  const hint = getLastReferenceSkill(sessionId)
  const contextSkillId = hint?.id || activeSkillContext?.skillId || null
  return contextSkillId === meta.skillId && meta.exposeWhenHintArmed.includes(meta.actionName)
}

function resolveStaticSkillToolNames(sessionId?: string): string[] {
  // Patch A2: the static fallback runs while the runtime-manager is still
  // booting. Advertising the gated submit/restart/cancel tools during that
  // window is exactly the vector that inspired Phase 0 — the model sees them,
  // no execution exists yet, it fabricates `executionId: "new"`, loop.
  // `STATIC_SKILL_TOOL_NAMES_BOOT_SAFE` strips those 5; they re-appear
  // dynamically via the session-aware provider once an execution lands.
  return Array.from(new Set(STATIC_SKILL_TOOL_NAMES_BOOT_SAFE))
    .filter((toolName) => isStaticSkillToolVisible(toolName, sessionId))
}

function resolveToolKind(toolName: string, domain: ToolDomain): ToolKind {
  if (domain === 'browser') {
    if (BROWSER_JOB_TOOL_NAMES.has(toolName)) return 'job'
    if (BROWSER_READ_TOOL_NAMES.has(toolName)) return 'read'
    if (BROWSER_WRITE_TOOL_NAMES.has(toolName)) return 'write'
    return 'interactive'
  }

  const { accessMode } = getToolResourceTag(toolName)
  if (accessMode === 'read') return 'read'
  if (accessMode === 'write') return 'write'
  return 'interactive'
}

function resolveToolTimeoutProfile(toolName: string, domain: ToolDomain, kind: ToolKind): ToolTimeoutProfile {
  if (domain === 'browser') return 'browser_interactive'
  if (domain === 'document' && kind === 'write') return 'document_write'
  if (toolName === 'skill_run_shell') return 'skill_long'
  if (domain === 'skill') return 'skill'
  if (domain === 'feishu') return 'feishu'
  return 'default'
}

function buildToolDefinition(
  groupId: CapabilityGroupId,
  toolName: string,
  metadata?: ToolDefinitionMetadata | null,
): ToolDefinition {
  const tag = getToolResourceTag(toolName)
  const domain = tag.domain as ToolDomain
  const kind = resolveToolKind(toolName, domain)
  const concurrency: ToolConcurrency = tag.accessMode === 'read' ? 'parallel_read_safe' : 'serialized'
  const interruptBehavior: ToolInterruptBehavior = domain === 'skill' || domain === 'system'
    ? 'host_managed'
    : 'abort_signal'

  return {
    name: toolName,
    groupId,
    domain,
    kind,
    concurrency,
    interruptBehavior,
    timeoutProfile: resolveToolTimeoutProfile(toolName, domain, kind),
    supportsTextBridge: resolveSupportsTextBridge(toolName, domain),
    projectionHint: resolveToolProjectionHint(toolName, domain, kind),
    description: metadata?.description || toolName,
    schema: metadata?.schema || null,
    executionTimeoutMs: metadata?.executionTimeoutMs,
    executionVisibility: metadata?.executionVisibility || 'model',
    requiresExplicitAllowlist: metadata?.requiresExplicitAllowlist,
    resultShape: resolveToolResultShape(toolName, domain),
  }
}

function buildToolDefinitions(
  groupId: CapabilityGroupId,
  toolNames: readonly string[],
  metadata?: Map<string, ToolDefinitionMetadata>,
): ToolDefinition[] {
  return Array.from(new Set(toolNames)).map((toolName) =>
    buildToolDefinition(groupId, toolName, metadata?.get(toolName) || null))
}

function filterBrowserAnthropicTools(toolNames: readonly string[]): Array<Record<string, unknown>> {
  const visible = new Set(toolNames)
  return getBrowserAnthropicTools().filter((tool) => {
    const name = getAnthropicToolName(tool)
    return typeof name === 'string' ? visible.has(name) : false
  })
}

function filterBrowserOpenAITools(toolNames: readonly string[]): Array<Record<string, unknown>> {
  const visible = new Set(toolNames)
  return getBrowserOpenAITools().filter((tool) => {
    const name = getOpenAIToolName(tool)
    return typeof name === 'string' ? visible.has(name) : false
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ToolDefinitionMetadata {
  description: string
  schema: ToolDefinitionSchema | null
  executionTimeoutMs?: number
  executionVisibility?: ToolExecutionVisibility
  requiresExplicitAllowlist?: boolean
}

function toToolDefinitionSchema(schema: unknown): ToolDefinitionSchema | null {
  const normalized = normalizeToolJsonSchema(schema)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return null
  }
  return normalized as ToolDefinitionSchema
}

function readToolMetadata(
  tool: Record<string, unknown>,
  format: ToolSchemaFormat,
): { name: string; metadata: ToolDefinitionMetadata } | null {
  if (format === 'anthropic') {
    const name = getAnthropicToolName(tool)
    if (!name) return null
    return {
      name,
      metadata: {
        description: typeof tool.description === 'string' ? tool.description : name,
        schema: toToolDefinitionSchema(tool.input_schema),
      },
    }
  }

  const name = getOpenAIToolName(tool)
  if (!name) return null
  const fn = tool.function && typeof tool.function === 'object'
    ? tool.function as Record<string, unknown>
    : {}
  return {
    name,
    metadata: {
      description: typeof fn.description === 'string' ? fn.description : name,
      schema: toToolDefinitionSchema(fn.parameters),
    },
  }
}

function buildToolMetadataMap(
  tools: Array<Record<string, unknown>>,
  format: ToolSchemaFormat,
): Map<string, ToolDefinitionMetadata> {
  const metadata = new Map<string, ToolDefinitionMetadata>()
  for (const tool of tools) {
    const resolved = readToolMetadata(tool, format)
    if (!resolved) continue
    metadata.set(resolved.name, resolved.metadata)
  }
  return metadata
}

function mergeToolMetadata(
  primary: Map<string, ToolDefinitionMetadata>,
  fallback: Map<string, ToolDefinitionMetadata>,
): Map<string, ToolDefinitionMetadata> {
  const merged = new Map<string, ToolDefinitionMetadata>(fallback)
  for (const [toolName, metadata] of primary.entries()) {
    merged.set(toolName, metadata)
  }
  return merged
}

function buildStaticSkillMetadata(toolNames: readonly string[]): Map<string, ToolDefinitionMetadata> {
  const metadata = new Map<string, ToolDefinitionMetadata>()
  for (const toolName of toolNames) {
    const skillMeta = getStaticSkillActionMeta(toolName)
    metadata.set(toolName, {
      description: `${toolName} fallback schema`,
      schema: null,
      executionTimeoutMs: skillMeta?.timeoutMs,
      executionVisibility: skillMeta?.visibility === 'internal' ? 'internal' : 'model',
      requiresExplicitAllowlist: skillMeta?.visibility === 'internal',
    })
  }
  return metadata
}

function buildStaticSkillToolDefinition(toolName: string): ToolDefinition | null {
  if (!STATIC_SKILL_TOOL_NAMES_BOOT_SAFE.includes(toolName)) return null
  const skillMeta = getStaticSkillActionMeta(toolName)
  return buildToolDefinition('skills', toolName, {
    description: `${toolName} fallback schema`,
    schema: null,
    executionTimeoutMs: skillMeta?.timeoutMs,
    executionVisibility: skillMeta?.visibility === 'internal' ? 'internal' : 'model',
    requiresExplicitAllowlist: skillMeta?.visibility === 'internal',
  })
}

function resolveSkillToolDefinitionForExecution(toolName: string): ToolDefinition | null {
  try {
    const def = findSkillToolByNameForExecution(toolName)
    if (def) {
      return buildToolDefinition('skills', def.name, {
        description: def.description,
        schema: null,
        executionTimeoutMs: def.timeoutMs,
        executionVisibility: def.visibility === 'internal' ? 'internal' : 'model',
        requiresExplicitAllowlist: def.visibility === 'internal',
      })
    }
    // B1 — when the runtime-manager lookup returns null (e.g. boot ordering
    // or test contexts where electron's `app` is unavailable), fall back to
    // the boot-safe static skill tool table the same way the catch-path does.
    // Without this, `findSkillToolByNameForExecution` swallows the throw and
    // returns null, so the catch branch below never runs and dispatch fails
    // with `tool_not_registered` even when the action exists in the static
    // manifest. Aligning both branches makes "static skill action exists" ≡
    // "dispatch can execute it."
    return buildStaticSkillToolDefinition(toolName)
  } catch {
    return buildStaticSkillToolDefinition(toolName)
  }
}

function resolveSupportsTextBridge(_toolName: string, domain: ToolDomain): boolean {
  return domain !== 'browser'
}

function resolveToolProjectionHint(
  toolName: string,
  domain: ToolDomain,
  kind: ToolKind,
): ToolProjectionHint | null {
  const hint: ToolProjectionHint = {}
  if (kind === 'write') {
    hint.mutating = true
  }
  const emitsFromSkill =
    PROJECTION_PATCH_TOOL_DOMAINS.has(domain) && toolName.startsWith('skill_')
  const emitsFromDocument =
    domain === 'document' && PROJECTION_PATCH_DOCUMENT_TOOL_NAMES.has(toolName)
  if (emitsFromSkill || emitsFromDocument) {
    hint.emitsProjectionPatch = true
  }
  return Object.keys(hint).length > 0 ? hint : null
}

function resolveToolResultShape(toolName: string, domain: ToolDomain): ToolDefinition['resultShape'] {
  if (PROJECTION_PATCH_TOOL_DOMAINS.has(domain) && toolName.startsWith('skill_')) {
    return 'projection_patch'
  }
  if (domain === 'document' && PROJECTION_PATCH_DOCUMENT_TOOL_NAMES.has(toolName)) {
    return 'projection_patch'
  }
  return 'text'
}

function resolveSkillToolSchemas(format: ToolSchemaFormat, sessionId?: string): ToolSchemaResolution {
  const staticToolNames = resolveStaticSkillToolNames(sessionId)
  const staticTools = staticToolNames.map((toolName) => createStaticFallbackSchema(toolName, format))
  try {
    return {
      tools: format === 'anthropic'
        ? getSkillAnthropicTools(sessionId)
        : getSkillOpenAITools(sessionId),
    }
  } catch (error) {
    return {
      tools: staticTools,
      error: getErrorMessage(error),
      usedStaticFallback: true,
    }
  }
}

function resolveSkillToolDefinitions(sessionId?: string): ToolDefinitionResolution {
  const staticToolNames = resolveStaticSkillToolNames(sessionId)
  try {
    const defs = getSkillToolDefsForRegistry(sessionId)
    const metadata = new Map<string, ToolDefinitionMetadata>()
    for (const def of defs) {
      metadata.set(def.name, {
        description: def.description,
        schema: null,
        executionTimeoutMs: def.timeoutMs,
        executionVisibility: def.visibility === 'internal' ? 'internal' : 'model',
        requiresExplicitAllowlist: def.visibility === 'internal',
      })
    }
    return {
      definitions: buildToolDefinitions('skills', defs.map((def) => def.name), metadata),
    }
  } catch (error) {
    return {
      definitions: buildToolDefinitions('skills', staticToolNames, buildStaticSkillMetadata(staticToolNames)),
      error: getErrorMessage(error),
      usedStaticFallback: true,
    }
  }
}

const GROUP_TOOL_PROVIDERS: Record<CapabilityGroupId, ToolRegistryProvider> = {
  browser_interaction: {
    staticToolNames: BROWSER_INTERACTION_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('browser_interaction', BROWSER_INTERACTION_TOOL_NAMES),
    getAnthropicTools: () => filterBrowserAnthropicTools(BROWSER_INTERACTION_TOOL_NAMES),
    getOpenAITools: () => filterBrowserOpenAITools(BROWSER_INTERACTION_TOOL_NAMES),
  },
  browser_content_tasks: {
    staticToolNames: BROWSER_CONTENT_TASK_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('browser_content_tasks', BROWSER_CONTENT_TASK_TOOL_NAMES),
    getAnthropicTools: () => filterBrowserAnthropicTools(BROWSER_CONTENT_TASK_TOOL_NAMES),
    getOpenAITools: () => filterBrowserOpenAITools(BROWSER_CONTENT_TASK_TOOL_NAMES),
  },
  document: {
    staticToolNames: DOCUMENT_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('document', DOCUMENT_TOOL_NAMES),
    getAnthropicTools: () => getDocumentAnthropicTools(),
    getOpenAITools: () => getDocumentOpenAITools(),
  },
  file_management: {
    staticToolNames: FILE_MANAGEMENT_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('file_management', FILE_MANAGEMENT_TOOL_NAMES),
    getAnthropicTools: () => getFileManagementAnthropicTools(),
    getOpenAITools: () => getFileManagementOpenAITools(),
  },
  rss: {
    staticToolNames: RSS_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('rss', RSS_TOOL_NAMES),
    getAnthropicTools: () => getRSSAnthropicTools(),
    getOpenAITools: () => getRSSOpenAITools(),
  },
  calendar: {
    staticToolNames: CALENDAR_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('calendar', CALENDAR_TOOL_NAMES),
    getAnthropicTools: () => getCalendarAnthropicTools(),
    getOpenAITools: () => getCalendarOpenAITools(),
  },
  skills: {
    staticToolNames: resolveStaticSkillToolNames(),
    hasDynamicSource: true,
    getToolDefinitionsDetailed: (sessionId?: string) => resolveSkillToolDefinitions(sessionId),
    getAnthropicToolsDetailed: (sessionId?: string) => resolveSkillToolSchemas('anthropic', sessionId),
    getOpenAIToolsDetailed: (sessionId?: string) => resolveSkillToolSchemas('openai', sessionId),
  },
  memory: {
    staticToolNames: MEMORY_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('memory', MEMORY_TOOL_NAMES),
    getAnthropicTools: () => getMemoryAnthropicTools(),
    getOpenAITools: () => getMemoryOpenAITools(),
  },
  session_recall: {
    staticToolNames: SESSION_RECALL_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('session_recall', SESSION_RECALL_TOOL_NAMES),
    getAnthropicTools: () => getSessionRecallAnthropicTools(),
    getOpenAITools: () => getSessionRecallOpenAITools(),
  },
  pet: {
    staticToolNames: PET_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('pet', PET_TOOL_NAMES),
    getAnthropicTools: () => getPetAnthropicTools(),
    getOpenAITools: () => getPetOpenAITools(),
  },
  channel_feishu: {
    staticToolNames: FEISHU_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('channel_feishu', FEISHU_TOOL_NAMES),
    getAnthropicTools: () => getFeishuAnthropicTools(),
    getOpenAITools: () => getFeishuOpenAITools(),
  },
  system_host: {
    staticToolNames: SYSTEM_TOOL_NAMES,
    getToolDefinitions: () => buildToolDefinitions('system_host', SYSTEM_TOOL_NAMES),
    getAnthropicTools: () => {
      try {
        return getSystemAnthropicTools()
      } catch {
        return SYSTEM_TOOL_NAMES.map((name) => createStaticFallbackSchema(name, 'anthropic'))
      }
    },
    getOpenAITools: () => {
      try {
        return getSystemOpenAITools()
      } catch {
        return SYSTEM_TOOL_NAMES.map((name) => createStaticFallbackSchema(name, 'openai'))
      }
    },
  },
  design_reserved: {
    staticToolNames: [],
    getToolDefinitions: () => [],
  },
}

export class ToolRegistry implements ToolRegistryReader {
  private readonly groupProviders: Record<CapabilityGroupId, ToolRegistryProvider>

  constructor(options?: ToolRegistryOptions) {
    this.groupProviders = {
      ...GROUP_TOOL_PROVIDERS,
      ...(options?.__testGroupProviders || {}),
    }
  }

  hasDynamicSource(groupId: CapabilityGroupId): boolean {
    return Boolean(this.groupProviders[groupId]?.hasDynamicSource)
  }

  getToolDefinition(toolName: string): ToolDefinition | null {
    return this.listToolDefinitions().find((tool) => tool.name === toolName) || null
  }

  getToolDefinitionForExecution(toolName: string): ToolDefinition | null {
    return this.getToolDefinition(toolName)
      || (toolName.startsWith('skill_') ? resolveSkillToolDefinitionForExecution(toolName) : null)
  }

  getToolDefinitionsResolutionForGroup(
    groupId: CapabilityGroupId,
    sessionId?: string,
  ): ToolDefinitionResolution {
    const provider = this.groupProviders[groupId]
    if (!provider) {
      return { definitions: [] }
    }
    if (provider.getToolDefinitionsDetailed) {
      return this.enrichToolDefinitions(groupId, provider.getToolDefinitionsDetailed(sessionId), sessionId)
    }
    if (provider.getToolDefinitions) {
      try {
        return this.enrichToolDefinitions(groupId, { definitions: provider.getToolDefinitions() }, sessionId)
      } catch (error) {
        return this.enrichToolDefinitions(groupId, {
          definitions: buildToolDefinitions(groupId, provider.staticToolNames || []),
          error: getErrorMessage(error),
          usedStaticFallback: Boolean(provider.staticToolNames && provider.staticToolNames.length > 0),
        }, sessionId)
      }
    }
    return this.enrichToolDefinitions(groupId, {
      definitions: buildToolDefinitions(groupId, provider.staticToolNames || []),
      usedStaticFallback: Boolean(provider.staticToolNames && provider.staticToolNames.length > 0),
    }, sessionId)
  }

  getToolSchemasResolutionForGroup(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId?: string,
  ): ToolSchemaResolution {
    const provider = this.groupProviders[groupId]
    const staticToolNames = provider?.staticToolNames || []

    const detailedResolver = format === 'anthropic'
      ? provider?.getAnthropicToolsDetailed
      : provider?.getOpenAIToolsDetailed
    if (detailedResolver) {
      return detailedResolver(sessionId)
    }

    const directResolver = format === 'anthropic'
      ? provider?.getAnthropicTools
      : provider?.getOpenAITools
    if (directResolver) {
      try {
        return { tools: directResolver() }
      } catch (error) {
        return {
          tools: [],
          error: getErrorMessage(error),
        }
      }
    }

    return {
      tools: staticToolNames.map((toolName) => createStaticFallbackSchema(toolName, format)),
      usedStaticFallback: staticToolNames.length > 0,
    }
  }

  listToolDefinitions(): ToolDefinition[] {
    const tools = new Map<string, ToolDefinition>()
    for (const groupId of Object.keys(this.groupProviders) as CapabilityGroupId[]) {
      for (const tool of this.getToolDefinitionsForGroup(groupId)) {
        if (!tools.has(tool.name)) {
          tools.set(tool.name, tool)
        }
      }
    }
    return Array.from(tools.values())
  }

  getToolDefinitionsForGroup(groupId: CapabilityGroupId, sessionId?: string): ToolDefinition[] {
    return this.getToolDefinitionsResolutionForGroup(groupId, sessionId).definitions
  }

  getToolSchemasForGroup(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId?: string,
  ): Array<Record<string, unknown>> {
    return this.getToolSchemasResolutionForGroup(groupId, format, sessionId).tools
  }

  private enrichToolDefinitions(
    groupId: CapabilityGroupId,
    resolution: ToolDefinitionResolution,
    sessionId?: string,
  ): ToolDefinitionResolution {
    if (resolution.definitions.length === 0) {
      return resolution
    }

    const metadata = mergeToolMetadata(
      buildToolMetadataMap(this.getToolSchemasResolutionForGroup(groupId, 'openai', sessionId).tools, 'openai'),
      buildToolMetadataMap(this.getToolSchemasResolutionForGroup(groupId, 'anthropic', sessionId).tools, 'anthropic'),
    )

    return {
      ...resolution,
      definitions: resolution.definitions.map((definition) => {
        const fallback = buildToolDefinition(groupId, definition.name, metadata.get(definition.name) || null)
        return {
          ...fallback,
          ...definition,
          supportsTextBridge:
            typeof definition.supportsTextBridge === 'boolean'
              ? definition.supportsTextBridge
              : fallback.supportsTextBridge,
          projectionHint: definition.projectionHint ?? fallback.projectionHint,
          description:
            definition.description && definition.description !== definition.name
              ? definition.description
              : fallback.description,
          schema: definition.schema || fallback.schema,
          executionTimeoutMs: definition.executionTimeoutMs ?? fallback.executionTimeoutMs,
          executionVisibility: definition.executionVisibility ?? fallback.executionVisibility,
          requiresExplicitAllowlist: definition.requiresExplicitAllowlist ?? fallback.requiresExplicitAllowlist,
          resultShape: definition.resultShape || fallback.resultShape,
        }
      }),
    }
  }
}

export const defaultToolRegistry = new ToolRegistry()

/**
 * Phase 4 cleanup helper: returns the set of tool names currently advertised
 * by the registry. Used by `sanitizeOpenAICompatibleMessageHistory` to drop
 * `tool_calls[]` entries (and matching `role:'tool'` follow-ups) referencing
 * retired tool names that may still live in recalled session histories.
 */
export function getRegisteredToolNames(): Set<string> {
  return new Set(defaultToolRegistry.listToolDefinitions().map((tool) => tool.name))
}

/**
 * Phase 2 (B plan child-loop) — single execution-admission schema resolver.
 *
 * Before this lived in three places: `tool-executor.ts` did an inline merge
 * `{ ...getSkillActionSchemas(), ...getToolInputSchemas() }`, while the forced
 * preflight in `turn-engine.ts` and the steering validator in
 * `turn-frame-steering.ts` only consulted `getToolInputSchemas()`. The split
 * meant a dynamic skill action schema would validate at dispatch but be
 * invisible to the forced-tool preflight, so a forced dispatch could carry
 * empty input through the steering validator and only be rejected once the
 * executor merged the dynamic map back in.
 *
 * The resolver collapses those paths into one ordering:
 *   1. Static registry (`getToolInputSchemas()`) wins. It already includes
 *      static-manifest-derived skill action schemas via
 *      `getStaticSkillActionSchemas()`, plus all per-domain primitives. This
 *      mirrors the executor's old precedence (`...getToolInputSchemas()` came
 *      LAST in the spread, overriding dynamic for any name collision).
 *   2. Dynamic skill-action cache (`getSkillActionSchemas()`) is consulted
 *      only for `skill_*` tool names that the static map does not already
 *      cover. This is where user-installed manifests surface schemas that
 *      the static manifest table cannot know about.
 *   3. Returns `null` when neither map has the tool. Callers treat null as
 *      "passthrough" — same contract as `validateToolInput` when its
 *      registry has no entry for the tool.
 *
 * Child-loop runs share this resolver via the same call sites: the typed
 * action wrapper preflights through `validateForcedActionInput` (which calls
 * the resolver), and child internal tool calls dispatch through
 * `executeToolCall` (which also calls the resolver). One source of truth →
 * no split-schema hazard between the model-facing turn and the child loop.
 */
export function resolveToolInputSchemaForExecution(
  toolName: string,
): ZodObject<ZodRawShape> | null {
  const staticSchemas = getToolInputSchemas()
  const staticSchema = staticSchemas[toolName]
  if (staticSchema) return staticSchema
  if (toolName.startsWith('skill_')) {
    try {
      const dynamicSchemas = getSkillActionSchemas()
      const dynamicSchema = dynamicSchemas[toolName]
      if (dynamicSchema) return dynamicSchema
    } catch {
      // Same defensive posture as `getSkillActionSchemas` itself: when the
      // runtime manager is unavailable (boot ordering, test contexts), we
      // fall through to null rather than crashing the resolver. The static
      // manifest fallback above already handles the boot-time path.
    }
  }
  return null
}

// =====================================================================
// T6 (B child-loop) — child-internal gateway executor. The child runner enters
// through the same `executeToolCall` admission path as model-facing dispatch,
// but with an explicit child internal context.
// =====================================================================

export interface ChildGatewayParams {
  skillId: string
  action: string
  input: unknown
  childRunId: string
  scopeId: string | null
  sessionId: string | null
  outputDir: string | null
  runStatePath: string | null
  childInternal: true
  agentContext?: AgentSpawnContext | null
  /** Optional propagation of the child runner's per-run abort controller. */
  signal?: AbortSignal
  /**
   * Test/runner injection. When provided, used in place of
   * `getSkillsRuntimeManager()`. Production callers (the runner) pass the
   * runtime manager they were configured with so a singleton mismatch in
   * test contexts cannot misroute the dispatch.
   */
  runtimeManager?: SkillsRuntimeManager
}

export interface ChildGatewayResult extends ToolExecutionOutput {
  /**
   * The runtime's `SkillRunResult` is preserved on the gateway output so
   * the runner can keep the existing observe-after-action contract intact
   * when the dispatch succeeds. Null when the gateway short-circuited
   * (validation / nested guard / handler error / abort) before reaching
   * the runtime.
   */
  skillRunResult: SkillRunResult | null
}

/**
 * Routes a child-internal skill action through the same admission contract
 * the public typed dispatch uses. See module-level comment above for the
 * full pipeline.
 */
export async function executeSkillActionViaToolGateway(
  params: ChildGatewayParams,
): Promise<ChildGatewayResult> {
  const { skillId, action, input, childRunId, scopeId, sessionId, outputDir, runStatePath, signal } = params

  const toolName = buildSkillToolName(skillId, action)

  const registryDefinition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
  if (!registryDefinition) {
    return makeChildGatewayError({
      errorKind: 'host_unavailable',
      message: `Tool is not registered: ${toolName}`,
      detail: {
        reason: 'tool_not_registered',
        toolName,
        skillId,
        action,
        childRunId,
      },
    })
  }

  const rawArgs = (input && typeof input === 'object' && !Array.isArray(input))
    ? (input as Record<string, unknown>)
    : {}

  if (signal?.aborted) {
    return makeChildGatewayError({
      errorKind: 'aborted',
      message: 'Skill action aborted before runtime dispatch',
      detail: { skillId, action, childRunId },
    })
  }

  try {
    const { executeToolCall } = await import('../tools/tool-executor')
    const output = await executeToolCall(toolName, rawArgs, {
      allowedToolNames: new Set([toolName]),
      abortSignal: signal,
      agentContext: params.agentContext ?? null,
      sessionId: sessionId ?? undefined,
      scopeId: scopeId ?? undefined,
      invoker: 'child_runner',
      allowInternal: true,
      turnFeatureFlags: snapshotTurnFeatureFlags(),
      skillRuntimeManager: params.runtimeManager,
      childInternalSkillAction: {
        skillId,
        action,
        childRunId,
        outputDir,
        runStatePath,
      },
    })
    const skillRunResult = (output.data && typeof output.data === 'object')
      ? ((output.data as { skillRunResult?: SkillRunResult }).skillRunResult ?? null)
      : null
    return {
      ...output,
      skillRunResult,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const looksAborted = signal?.aborted
      || (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message)))
    const errorKind = looksAborted ? 'aborted' : 'tool_failed'
    return makeChildGatewayError({
      errorKind,
      message,
      detail: { skillId, action, childRunId, toolName },
    })
  }
}

function makeChildGatewayError(args: {
  errorKind: string
  message: string
  detail?: Record<string, unknown>
}): ChildGatewayResult {
  const text = `child gateway ${args.errorKind}: ${args.message}`
  const output = createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      status: 'error',
      errorKind: args.errorKind,
      message: args.message,
      ...(args.detail || {}),
    },
  })
  return {
    ...output,
    skillRunResult: null,
  }
}
