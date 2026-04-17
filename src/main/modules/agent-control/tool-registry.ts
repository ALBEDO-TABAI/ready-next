import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { getToolResourceTag } from './tool-parallelism-policy'
import type {
  ToolConcurrency,
  ToolDefinition,
  ToolDomain,
  ToolInterruptBehavior,
  ToolKind,
  ToolTimeoutProfile,
} from './tool-definition'
import { getCalendarAnthropicTools, getCalendarOpenAITools } from '../tools/calendar-tools'
import { getDocumentAnthropicTools, getDocumentOpenAITools } from '../tools/document-tools'
import { getFeishuAnthropicTools, getFeishuOpenAITools } from '../tools/feishu-tools'
import { getMemoryAnthropicTools, getMemoryOpenAITools } from '../tools/memory-tools'
import { getRSSAnthropicTools, getRSSOpenAITools } from '../tools/rss-tools'
import { getSessionRecallAnthropicTools, getSessionRecallOpenAITools } from '../tools/session-recall-tools'
import { createRequire } from 'node:module'

export type ToolSchemaFormat = 'anthropic' | 'openai'

export interface ToolRegistryProvider {
  staticToolNames?: string[]
  hasDynamicSource?: boolean
  getToolDefinitions?: () => ToolDefinition[]
  getAnthropicTools?: () => Array<Record<string, unknown>>
  getOpenAITools?: () => Array<Record<string, unknown>>
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

const require = createRequire(import.meta.url)

const BROWSER_INTERACTION_TOOL_NAMES = [
  'browser_navigate',
  'browser_search',
  'browser_get_tabs',
  'browser_read_page',
  'browser_click',
  'browser_click_text',
  'browser_type',
  'browser_type_smart',
  'browser_compose_message',
  'browser_capture_viewport',
  'browser_probe_workflow_state',
  'browser_locate_action_targets',
  'browser_locate_input_targets',
  'browser_analyze_viewport',
  'browser_list_upload_targets',
  'browser_upload_scope_attachment',
  'browser_click_at',
  'browser_type_at',
  'browser_scroll_at',
  'browser_send_keys',
  'browser_ask_user_takeover',
  'browser_query_gemini',
  'browser_wait',
  'browser_wait_for_condition',
  'browser_go_back',
]

const BROWSER_CONTENT_TASK_TOOL_NAMES = [
  'browser_collect_images',
  'browser_download_urls',
  'browser_extract_structured',
  'browser_scroll_collect',
  'browser_start_task',
  'browser_get_task',
  'browser_resume_task',
  'browser_cancel_task',
  'browser_aggregate_results',
  'browser_download_gallery',
  'browser_research_topic',
  'browser_run_workflow',
  'browser_execute_js',
]

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
  try {
    const { STATIC_SKILL_TOOL_NAMES } = require('../tools/skills-tools') as typeof import('../tools/skills-tools')
    return Array.from(new Set(STATIC_SKILL_TOOL_NAMES))
  } catch {
    return [
      'skill_get_state',
      'skill_submit_input',
      'skill_submit_confirmation',
      'skill_submit_agent_result',
      'skill_restart_from_step',
      'skill_cancel_execution',
    ]
  }
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

function buildToolDefinition(groupId: CapabilityGroupId, toolName: string): ToolDefinition {
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
    resultShape: 'text',
  }
}

function buildToolDefinitions(groupId: CapabilityGroupId, toolNames: string[]): ToolDefinition[] {
  return Array.from(new Set(toolNames)).map((toolName) => buildToolDefinition(groupId, toolName))
}

function getBrowserAnthropicTools(): Array<Record<string, unknown>> {
  const { getAnthropicTools } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
  return getAnthropicTools()
}

function getBrowserOpenAITools(): Array<Record<string, unknown>> {
  const { getOpenAITools } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
  return getOpenAITools()
}

function filterBrowserAnthropicTools(toolNames: string[]): Array<Record<string, unknown>> {
  const visible = new Set(toolNames)
  return getBrowserAnthropicTools().filter((tool) => {
    const name = getAnthropicToolName(tool)
    return typeof name === 'string' ? visible.has(name) : false
  })
}

function filterBrowserOpenAITools(toolNames: string[]): Array<Record<string, unknown>> {
  const visible = new Set(toolNames)
  return getBrowserOpenAITools().filter((tool) => {
    const name = getOpenAIToolName(tool)
    return typeof name === 'string' ? visible.has(name) : false
  })
}

function getSkillToolDefinitions(): ToolDefinition[] {
  const { getSkillOpenAITools, findSkillToolByName } = require('../tools/skills-tools') as typeof import('../tools/skills-tools')
  const skillNames = collectToolNames(getSkillOpenAITools(), 'openai')
  return skillNames.map((toolName) => {
    const tool = findSkillToolByName(toolName)
    return buildToolDefinition('skills', tool?.name || toolName)
  })
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
    getToolDefinitions: () => getSkillToolDefinitions(),
    getAnthropicTools: () => {
      const { getSkillAnthropicTools } = require('../tools/skills-tools') as typeof import('../tools/skills-tools')
      return getSkillAnthropicTools()
    },
    getOpenAITools: () => {
      const { getSkillOpenAITools } = require('../tools/skills-tools') as typeof import('../tools/skills-tools')
      return getSkillOpenAITools()
    },
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
      const { getSystemAnthropicTools } = require('../tools/system-tools') as typeof import('../tools/system-tools')
      return getSystemAnthropicTools()
    },
    getOpenAITools: () => {
      const { getSystemOpenAITools } = require('../tools/system-tools') as typeof import('../tools/system-tools')
      return getSystemOpenAITools()
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
    const provider = this.groupProviders[groupId]
    if (!provider) return []

    if (provider.getToolDefinitions) {
      try {
        return provider.getToolDefinitions()
      } catch {
        // fall through to static fallback
      }
    }

    return buildToolDefinitions(groupId, provider.staticToolNames || [])
  }

  getToolSchemasForGroup(groupId: CapabilityGroupId, format: ToolSchemaFormat): Array<Record<string, unknown>> {
    const provider = this.groupProviders[groupId]
    const staticToolNames = provider?.staticToolNames || []

    if (format === 'anthropic' && provider?.getAnthropicTools) {
      return provider.getAnthropicTools()
    }
    if (format === 'openai' && provider?.getOpenAITools) {
      return provider.getOpenAITools()
    }

    return staticToolNames.map((toolName) => createStaticFallbackSchema(toolName, format))
  }
}

export const defaultToolRegistry = new ToolRegistry()
