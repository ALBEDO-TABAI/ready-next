import { createRequire } from 'node:module'
import type { CapabilityGroupDefinition, CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { CAPABILITY_GROUPS } from '../../../shared/ai-capability-groups'

type ToolSchemaFormat = 'anthropic' | 'openai'
const require = createRequire(import.meta.url)

export interface ToolDescriptor {
  id: string
  group: string
  description: string
  module?: string
  executionKind?: 'deterministic' | 'interactive' | 'job' | 'pipeline'
  family?: string
}

export interface CapabilityGroupRegistryEntry extends CapabilityGroupDefinition {
  toolNames: string[]
  hasDynamicSource: boolean
}

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

interface CapabilityGroupToolProvider {
  staticToolNames: string[]
  hasDynamicSource?: boolean
  getAnthropicTools?: () => Array<Record<string, unknown>>
  getOpenAITools?: () => Array<Record<string, unknown>>
}

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

function mergeSchemasWithFallback(
  tools: Array<Record<string, unknown>>,
  staticToolNames: string[],
  format: ToolSchemaFormat,
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>()
  for (const tool of tools) {
    const name = format === 'anthropic' ? getAnthropicToolName(tool) : getOpenAIToolName(tool)
    if (name && !merged.has(name)) {
      merged.set(name, tool)
    }
  }
  for (const toolName of staticToolNames) {
    if (!merged.has(toolName)) {
      merged.set(toolName, createStaticFallbackSchema(toolName, format))
    }
  }
  return Array.from(merged.values())
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

const GROUP_TOOL_PROVIDERS: Record<CapabilityGroupId, CapabilityGroupToolProvider> = {
  browser_interaction: {
    staticToolNames: BROWSER_INTERACTION_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getAnthropicTools } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
      return getAnthropicTools().filter((tool) => {
        const name = getAnthropicToolName(tool)
        return typeof name === 'string' ? BROWSER_INTERACTION_TOOL_NAMES.includes(name) : false
      })
    },
    getOpenAITools: () => {
      const { getOpenAITools } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
      return getOpenAITools().filter((tool) => {
        const name = getOpenAIToolName(tool)
        return typeof name === 'string' ? BROWSER_INTERACTION_TOOL_NAMES.includes(name) : false
      })
    },
  },
  browser_content_tasks: {
    staticToolNames: BROWSER_CONTENT_TASK_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getAnthropicTools } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
      return getAnthropicTools().filter((tool) => {
        const name = getAnthropicToolName(tool)
        return typeof name === 'string' ? BROWSER_CONTENT_TASK_TOOL_NAMES.includes(name) : false
      })
    },
    getOpenAITools: () => {
      const { getOpenAITools } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
      return getOpenAITools().filter((tool) => {
        const name = getOpenAIToolName(tool)
        return typeof name === 'string' ? BROWSER_CONTENT_TASK_TOOL_NAMES.includes(name) : false
      })
    },
  },
  document: {
    staticToolNames: DOCUMENT_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getDocumentAnthropicTools } = require('../tools/document-tools') as typeof import('../tools/document-tools')
      return getDocumentAnthropicTools()
    },
    getOpenAITools: () => {
      const { getDocumentOpenAITools } = require('../tools/document-tools') as typeof import('../tools/document-tools')
      return getDocumentOpenAITools()
    },
  },
  rss: {
    staticToolNames: RSS_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getRSSAnthropicTools } = require('../tools/rss-tools') as typeof import('../tools/rss-tools')
      return getRSSAnthropicTools()
    },
    getOpenAITools: () => {
      const { getRSSOpenAITools } = require('../tools/rss-tools') as typeof import('../tools/rss-tools')
      return getRSSOpenAITools()
    },
  },
  calendar: {
    staticToolNames: CALENDAR_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getCalendarAnthropicTools } = require('../tools/calendar-tools') as typeof import('../tools/calendar-tools')
      return getCalendarAnthropicTools()
    },
    getOpenAITools: () => {
      const { getCalendarOpenAITools } = require('../tools/calendar-tools') as typeof import('../tools/calendar-tools')
      return getCalendarOpenAITools()
    },
  },
  skills: {
    staticToolNames: resolveStaticSkillToolNames(),
    hasDynamicSource: true,
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
    getAnthropicTools: () => {
      const { getMemoryAnthropicTools } = require('../tools/memory-tools') as typeof import('../tools/memory-tools')
      return getMemoryAnthropicTools()
    },
    getOpenAITools: () => {
      const { getMemoryOpenAITools } = require('../tools/memory-tools') as typeof import('../tools/memory-tools')
      return getMemoryOpenAITools()
    },
  },
  session_recall: {
    staticToolNames: SESSION_RECALL_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getSessionRecallAnthropicTools } = require('../tools/session-recall-tools') as typeof import('../tools/session-recall-tools')
      return getSessionRecallAnthropicTools()
    },
    getOpenAITools: () => {
      const { getSessionRecallOpenAITools } = require('../tools/session-recall-tools') as typeof import('../tools/session-recall-tools')
      return getSessionRecallOpenAITools()
    },
  },
  channel_feishu: {
    staticToolNames: FEISHU_TOOL_NAMES,
    getAnthropicTools: () => {
      const { getFeishuAnthropicTools } = require('../tools/feishu-tools') as typeof import('../tools/feishu-tools')
      return getFeishuAnthropicTools()
    },
    getOpenAITools: () => {
      const { getFeishuOpenAITools } = require('../tools/feishu-tools') as typeof import('../tools/feishu-tools')
      return getFeishuOpenAITools()
    },
  },
  system_host: {
    staticToolNames: SYSTEM_TOOL_NAMES,
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
  },
}

export class ToolGateway {
  private readonly capabilityGroupMeta = new Map<CapabilityGroupId, CapabilityGroupDefinition>(
    CAPABILITY_GROUPS.map((group) => [group.id, group]),
  )

  private resolveGroupToolSchemas(groupId: CapabilityGroupId, format: ToolSchemaFormat): Array<Record<string, unknown>> {
    const provider = GROUP_TOOL_PROVIDERS[groupId]
    const staticToolNames = provider?.staticToolNames || []
    try {
      const resolved = format === 'anthropic'
        ? provider?.getAnthropicTools?.() || []
        : provider?.getOpenAITools?.() || []
      return mergeSchemasWithFallback(resolved, staticToolNames, format)
    } catch {
      return staticToolNames.map((toolName) => createStaticFallbackSchema(toolName, format))
    }
  }

  private resolveGroupToolNames(groupId: CapabilityGroupId): string[] {
    const provider = GROUP_TOOL_PROVIDERS[groupId]
    const names = new Set(provider?.staticToolNames || [])
    for (const toolName of collectToolNames(this.resolveGroupToolSchemas(groupId, 'openai'), 'openai')) {
      names.add(toolName)
    }
    return Array.from(names)
  }

  private buildCapabilityGroupEntry(groupId: CapabilityGroupId): CapabilityGroupRegistryEntry {
    const group = this.capabilityGroupMeta.get(groupId)
    if (!group) {
      throw new Error(`Unknown capability group: ${groupId}`)
    }
    return {
      ...group,
      toolNames: this.resolveGroupToolNames(groupId),
      hasDynamicSource: Boolean(GROUP_TOOL_PROVIDERS[groupId]?.hasDynamicSource),
    }
  }

  private listResolvedToolDescriptors(): ToolDescriptor[] {
    return this.listCapabilityGroups().flatMap((group) =>
      group.toolNames.map((toolName) => ({
        id: toolName,
        group: group.id,
        description: group.description,
        module: group.id,
        executionKind: group.executionKinds[0] === 'job'
          ? 'job'
          : group.executionKinds[0] === 'pipeline'
            ? 'pipeline'
            : group.executionKinds[0] === 'interactive'
              ? 'interactive'
              : 'deterministic',
        family: `${group.id}_*`,
      })),
    )
  }

  listCapabilityGroups(): CapabilityGroupRegistryEntry[] {
    return CAPABILITY_GROUPS.map((group) => this.buildCapabilityGroupEntry(group.id))
  }

  getCapabilityGroup(id: CapabilityGroupId): CapabilityGroupRegistryEntry | null {
    return this.capabilityGroupMeta.has(id) ? this.buildCapabilityGroupEntry(id) : null
  }

  collectToolNamesForGroups(groupIds: CapabilityGroupId[]): string[] {
    const names = new Set<string>()
    for (const groupId of groupIds) {
      for (const toolName of this.resolveGroupToolNames(groupId)) {
        names.add(toolName)
      }
    }
    return Array.from(names)
  }

  getToolSchemasForGroup(groupId: CapabilityGroupId, format: ToolSchemaFormat): Array<Record<string, unknown>> {
    return this.resolveGroupToolSchemas(groupId, format)
  }

  getAnthropicToolsForGroups(groupIds: CapabilityGroupId[]): Array<Record<string, unknown>> {
    const tools = new Map<string, Record<string, unknown>>()
    for (const groupId of groupIds) {
      for (const tool of this.resolveGroupToolSchemas(groupId, 'anthropic')) {
        const name = getAnthropicToolName(tool)
        if (name && !tools.has(name)) {
          tools.set(name, tool)
        }
      }
    }
    return Array.from(tools.values())
  }

  getOpenAIToolsForGroups(groupIds: CapabilityGroupId[]): Array<Record<string, unknown>> {
    const tools = new Map<string, Record<string, unknown>>()
    for (const groupId of groupIds) {
      for (const tool of this.resolveGroupToolSchemas(groupId, 'openai')) {
        const name = getOpenAIToolName(tool)
        if (name && !tools.has(name)) {
          tools.set(name, tool)
        }
      }
    }
    return Array.from(tools.values())
  }

  listTools(): ToolDescriptor[] {
    return this.listResolvedToolDescriptors()
  }

  count(): number {
    return this.listResolvedToolDescriptors().length
  }

  listToolGroups(): string[] {
    return CAPABILITY_GROUPS.map((group) => group.id)
  }

  getTool(id: string): ToolDescriptor | null {
    return this.listResolvedToolDescriptors().find((tool) => tool.id === id) || null
  }

  hasTool(id: string): boolean {
    return this.getTool(id) !== null
  }

  listByModule(module: string): ToolDescriptor[] {
    return this.listResolvedToolDescriptors().filter((tool) => tool.module === module)
  }
}

export const defaultToolGateway = new ToolGateway()
