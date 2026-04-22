import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { getToolResourceTag } from './tool-parallelism-policy'
import type {
  ToolConcurrency,
  ToolDefinition,
  ToolDefinitionSchema,
  ToolDomain,
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
import {
  FILE_MANAGEMENT_TOOL_NAMES,
  getFileManagementAnthropicTools,
  getFileManagementOpenAITools,
} from '../tools/file-management-tools'
import { getFeishuAnthropicTools, getFeishuOpenAITools } from '../tools/feishu-tools'
import { getMemoryAnthropicTools, getMemoryOpenAITools } from '../tools/memory-tools'
import { getRSSAnthropicTools, getRSSOpenAITools } from '../tools/rss-tools'
import { getSessionRecallAnthropicTools, getSessionRecallOpenAITools } from '../tools/session-recall-tools'
import { STATIC_SKILL_TOOL_NAMES } from '../tools/skills-tools-static'
import { normalizeToolJsonSchema } from '../tools/tool-schema'
import { createRequire } from 'node:module'

// Skills/system tool runtime getters import the SkillsRuntimeManager (which
// pulls electron) — keep them lazy via createRequire so this module stays
// loadable in non-bundled / test contexts. The static name list above is
// imported eagerly from the pure schema module so the bundled runtime no
// longer falls back to the inline hardcoded list.
const lazyRequire = createRequire(import.meta.url)

export type ToolSchemaFormat = 'anthropic' | 'openai'

export interface ToolRegistryProvider {
  staticToolNames?: readonly string[]
  hasDynamicSource?: boolean
  getToolDefinitions?: () => ToolDefinition[]
  getToolDefinitionsDetailed?: () => ToolDefinitionResolution
  getAnthropicTools?: () => Array<Record<string, unknown>>
  getAnthropicToolsDetailed?: () => ToolSchemaResolution
  getOpenAITools?: () => Array<Record<string, unknown>>
  getOpenAIToolsDetailed?: () => ToolSchemaResolution
}

export interface ToolRegistryOptions {
  __testGroupProviders?: Partial<Record<CapabilityGroupId, ToolRegistryProvider>>
}

export interface ToolRegistryReader {
  hasDynamicSource(groupId: CapabilityGroupId): boolean
  getToolDefinition(toolName: string): ToolDefinition | null
  listToolDefinitions(): ToolDefinition[]
  getToolDefinitionsForGroup(groupId: CapabilityGroupId): ToolDefinition[]
  getToolSchemasForGroup(groupId: CapabilityGroupId, format: ToolSchemaFormat): Array<Record<string, unknown>>
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
const SYSTEM_TOOL_NAMES = ['system_run_embedded_python', 'system_run_openclaw']

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

function collectToolNames(tools: Array<Record<string, unknown>>, format: ToolSchemaFormat): string[] {
  const names = tools
    .map((tool) => format === 'anthropic' ? getAnthropicToolName(tool) : getOpenAIToolName(tool))
    .filter((name): name is string => Boolean(name))
  return Array.from(new Set(names))
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

function resolveStaticSkillToolNames(): string[] {
  return Array.from(new Set(STATIC_SKILL_TOOL_NAMES))
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

function resolveSkillToolSchemas(format: ToolSchemaFormat): ToolSchemaResolution {
  const staticToolNames = resolveStaticSkillToolNames()
  const staticTools = staticToolNames.map((toolName) => createStaticFallbackSchema(toolName, format))
  try {
    const skillToolsModule = lazyRequire('../tools/skills-tools') as typeof import('../tools/skills-tools')
    return {
      tools: format === 'anthropic'
        ? skillToolsModule.getSkillAnthropicTools()
        : skillToolsModule.getSkillOpenAITools(),
    }
  } catch (error) {
    return {
      tools: staticTools,
      error: getErrorMessage(error),
      usedStaticFallback: true,
    }
  }
}

function resolveSkillToolDefinitions(): ToolDefinitionResolution {
  const staticToolNames = resolveStaticSkillToolNames()
  try {
    const { getSkillOpenAITools } = lazyRequire('../tools/skills-tools') as typeof import('../tools/skills-tools')
    const skillNames = collectToolNames(getSkillOpenAITools(), 'openai')
    return {
      definitions: buildToolDefinitions('skills', skillNames),
    }
  } catch (error) {
    return {
      definitions: buildToolDefinitions('skills', staticToolNames),
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
    getToolDefinitionsDetailed: () => resolveSkillToolDefinitions(),
    getAnthropicToolsDetailed: () => resolveSkillToolSchemas('anthropic'),
    getOpenAIToolsDetailed: () => resolveSkillToolSchemas('openai'),
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
        const { getSystemAnthropicTools } = lazyRequire('../tools/system-tools') as typeof import('../tools/system-tools')
        return getSystemAnthropicTools()
      } catch {
        return SYSTEM_TOOL_NAMES.map((name) => createStaticFallbackSchema(name, 'anthropic'))
      }
    },
    getOpenAITools: () => {
      try {
        const { getSystemOpenAITools } = lazyRequire('../tools/system-tools') as typeof import('../tools/system-tools')
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

  getToolDefinitionsResolutionForGroup(groupId: CapabilityGroupId): ToolDefinitionResolution {
    const provider = this.groupProviders[groupId]
    if (!provider) {
      return { definitions: [] }
    }
    if (provider.getToolDefinitionsDetailed) {
      return this.enrichToolDefinitions(groupId, provider.getToolDefinitionsDetailed())
    }
    if (provider.getToolDefinitions) {
      try {
        return this.enrichToolDefinitions(groupId, { definitions: provider.getToolDefinitions() })
      } catch (error) {
        return this.enrichToolDefinitions(groupId, {
          definitions: buildToolDefinitions(groupId, provider.staticToolNames || []),
          error: getErrorMessage(error),
          usedStaticFallback: Boolean(provider.staticToolNames && provider.staticToolNames.length > 0),
        })
      }
    }
    return this.enrichToolDefinitions(groupId, {
      definitions: buildToolDefinitions(groupId, provider.staticToolNames || []),
      usedStaticFallback: Boolean(provider.staticToolNames && provider.staticToolNames.length > 0),
    })
  }

  getToolSchemasResolutionForGroup(groupId: CapabilityGroupId, format: ToolSchemaFormat): ToolSchemaResolution {
    const provider = this.groupProviders[groupId]
    const staticToolNames = provider?.staticToolNames || []

    const detailedResolver = format === 'anthropic'
      ? provider?.getAnthropicToolsDetailed
      : provider?.getOpenAIToolsDetailed
    if (detailedResolver) {
      return detailedResolver()
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

  getToolDefinitionsForGroup(groupId: CapabilityGroupId): ToolDefinition[] {
    return this.getToolDefinitionsResolutionForGroup(groupId).definitions
  }

  getToolSchemasForGroup(groupId: CapabilityGroupId, format: ToolSchemaFormat): Array<Record<string, unknown>> {
    return this.getToolSchemasResolutionForGroup(groupId, format).tools
  }

  private enrichToolDefinitions(
    groupId: CapabilityGroupId,
    resolution: ToolDefinitionResolution,
  ): ToolDefinitionResolution {
    if (resolution.definitions.length === 0) {
      return resolution
    }

    const metadata = mergeToolMetadata(
      buildToolMetadataMap(this.getToolSchemasResolutionForGroup(groupId, 'openai').tools, 'openai'),
      buildToolMetadataMap(this.getToolSchemasResolutionForGroup(groupId, 'anthropic').tools, 'anthropic'),
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
          resultShape: definition.resultShape || fallback.resultShape,
        }
      }),
    }
  }
}

export const defaultToolRegistry = new ToolRegistry()
