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

function filterToolsByNames(
  tools: Array<Record<string, unknown>>,
  names: Set<string>,
  format: ToolSchemaFormat,
): Array<Record<string, unknown>> {
  return tools.filter((tool) => {
    const toolName = format === 'anthropic' ? getAnthropicToolName(tool) : getOpenAIToolName(tool)
    return typeof toolName === 'string' ? names.has(toolName) : false
  })
}

export class ToolGateway {
  private readonly capabilityGroups: CapabilityGroupRegistryEntry[]
  private readonly capabilityGroupIndex = new Map<CapabilityGroupId, CapabilityGroupRegistryEntry>()
  private readonly toolDescriptors: ToolDescriptor[]
  private readonly toolDescriptorIndex = new Map<string, ToolDescriptor>()

  constructor() {
    this.capabilityGroups = this.buildCapabilityGroups()
    for (const group of this.capabilityGroups) {
      this.capabilityGroupIndex.set(group.id, group)
    }

    this.toolDescriptors = this.capabilityGroups.flatMap((group) =>
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

    for (const tool of this.toolDescriptors) {
      this.toolDescriptorIndex.set(tool.id, tool)
    }
  }

  private buildCapabilityGroups(): CapabilityGroupRegistryEntry[] {
    const groupToolNames: Record<CapabilityGroupId, string[]> = {
      browser_interaction: BROWSER_INTERACTION_TOOL_NAMES,
      browser_content_tasks: BROWSER_CONTENT_TASK_TOOL_NAMES,
      document: DOCUMENT_TOOL_NAMES,
      rss: RSS_TOOL_NAMES,
      calendar: CALENDAR_TOOL_NAMES,
      skills: this.resolveStaticSkillToolNames(),
      memory: MEMORY_TOOL_NAMES,
      session_recall: SESSION_RECALL_TOOL_NAMES,
      channel_feishu: FEISHU_TOOL_NAMES,
      system_host: SYSTEM_TOOL_NAMES,
      design_reserved: [],
    }

    return CAPABILITY_GROUPS.map((group) => ({
      ...group,
      toolNames: groupToolNames[group.id] || [],
    }))
  }

  private resolveStaticSkillToolNames(): string[] {
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

  listCapabilityGroups(): CapabilityGroupRegistryEntry[] {
    return this.capabilityGroups.map((group) => ({ ...group, toolNames: [...group.toolNames] }))
  }

  getCapabilityGroup(id: CapabilityGroupId): CapabilityGroupRegistryEntry | null {
    const group = this.capabilityGroupIndex.get(id)
    return group ? { ...group, toolNames: [...group.toolNames] } : null
  }

  collectToolNamesForGroups(groupIds: CapabilityGroupId[]): string[] {
    const names = new Set<string>()
    for (const groupId of groupIds) {
      const group = this.capabilityGroupIndex.get(groupId)
      if (!group) continue
      for (const toolName of group.toolNames) names.add(toolName)
    }
    return Array.from(names)
  }

  private getAllAnthropicTools(): Array<Record<string, unknown>> {
    const {
      getAnthropicTools: getBrowserAnthropicTools,
    } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
    const {
      getDocumentAnthropicTools,
    } = require('../tools/document-tools') as typeof import('../tools/document-tools')
    const {
      getRSSAnthropicTools,
    } = require('../tools/rss-tools') as typeof import('../tools/rss-tools')
    const {
      getCalendarAnthropicTools,
    } = require('../tools/calendar-tools') as typeof import('../tools/calendar-tools')
    const {
      getSkillAnthropicTools,
    } = require('../tools/skills-tools') as typeof import('../tools/skills-tools')
    const {
      getFeishuAnthropicTools,
    } = require('../tools/feishu-tools') as typeof import('../tools/feishu-tools')
    const {
      getMemoryAnthropicTools,
    } = require('../tools/memory-tools') as typeof import('../tools/memory-tools')
    const {
      getSessionRecallAnthropicTools,
    } = require('../tools/session-recall-tools') as typeof import('../tools/session-recall-tools')
    const {
      getSystemAnthropicTools,
    } = require('../tools/system-tools') as typeof import('../tools/system-tools')

    return [
      ...getBrowserAnthropicTools(),
      ...getDocumentAnthropicTools(),
      ...getRSSAnthropicTools(),
      ...getCalendarAnthropicTools(),
      ...getSkillAnthropicTools(),
      ...getFeishuAnthropicTools(),
      ...getMemoryAnthropicTools(),
      ...getSessionRecallAnthropicTools(),
      ...getSystemAnthropicTools(),
    ]
  }

  private getAllOpenAITools(): Array<Record<string, unknown>> {
    const {
      getOpenAITools: getBrowserOpenAITools,
    } = require('../tools/browser-tools') as typeof import('../tools/browser-tools')
    const {
      getDocumentOpenAITools,
    } = require('../tools/document-tools') as typeof import('../tools/document-tools')
    const {
      getRSSOpenAITools,
    } = require('../tools/rss-tools') as typeof import('../tools/rss-tools')
    const {
      getCalendarOpenAITools,
    } = require('../tools/calendar-tools') as typeof import('../tools/calendar-tools')
    const {
      getSkillOpenAITools,
    } = require('../tools/skills-tools') as typeof import('../tools/skills-tools')
    const {
      getFeishuOpenAITools,
    } = require('../tools/feishu-tools') as typeof import('../tools/feishu-tools')
    const {
      getMemoryOpenAITools,
    } = require('../tools/memory-tools') as typeof import('../tools/memory-tools')
    const {
      getSessionRecallOpenAITools,
    } = require('../tools/session-recall-tools') as typeof import('../tools/session-recall-tools')
    const {
      getSystemOpenAITools,
    } = require('../tools/system-tools') as typeof import('../tools/system-tools')

    return [
      ...getBrowserOpenAITools(),
      ...getDocumentOpenAITools(),
      ...getRSSOpenAITools(),
      ...getCalendarOpenAITools(),
      ...getSkillOpenAITools(),
      ...getFeishuOpenAITools(),
      ...getMemoryOpenAITools(),
      ...getSessionRecallOpenAITools(),
      ...getSystemOpenAITools(),
    ]
  }

  getAnthropicToolsForGroups(groupIds: CapabilityGroupId[]): Array<Record<string, unknown>> {
    const allowed = new Set(this.collectToolNamesForGroups(groupIds))
    return filterToolsByNames(this.getAllAnthropicTools(), allowed, 'anthropic')
  }

  getOpenAIToolsForGroups(groupIds: CapabilityGroupId[]): Array<Record<string, unknown>> {
    const allowed = new Set(this.collectToolNamesForGroups(groupIds))
    return filterToolsByNames(this.getAllOpenAITools(), allowed, 'openai')
  }

  listTools(): ToolDescriptor[] {
    return [...this.toolDescriptors]
  }

  count(): number {
    return this.toolDescriptors.length
  }

  listToolGroups(): string[] {
    return this.capabilityGroups.map((group) => group.id)
  }

  getTool(id: string): ToolDescriptor | null {
    return this.toolDescriptorIndex.get(id) || null
  }

  hasTool(id: string): boolean {
    return this.toolDescriptorIndex.has(id)
  }

  listByModule(module: string): ToolDescriptor[] {
    return this.toolDescriptors.filter((tool) => tool.module === module)
  }
}

export const defaultToolGateway = new ToolGateway()
