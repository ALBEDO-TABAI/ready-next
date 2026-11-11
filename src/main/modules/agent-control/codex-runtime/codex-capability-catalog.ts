import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  BROWSER_CURRENT_PAGE_TOOL_NAMES,
  BROWSER_EXPLICIT_READ_TOOL_NAMES,
  BROWSER_SKILL_ONLY_TOOL_NAMES,
} from './codex-browser-admission'

export const READY_CAPABILITY_GROUP_IDS = [
  'public_research',
  'browser_current_read',
  'browser_current_act',
  'calendar_read',
  'calendar_write',
] as const

export type ReadyCapabilityGroupId = (typeof READY_CAPABILITY_GROUP_IDS)[number]
export type ReadyCapabilityLoading = 'always' | 'mixed'

export type ReadyCapabilityGroup = {
  id: ReadyCapabilityGroupId
  description: string
  tools: readonly string[]
  loading: ReadyCapabilityLoading
}

export const PUBLIC_RESEARCH_TOOL_NAMES = [
  'web_search_domains',
  'web_search',
  'web_fetch',
] as const

export const CALENDAR_READ_TOOL_NAMES = [
  'calendar_list_window',
  'calendar_capture_session',
] as const

export const CALENDAR_WRITE_TOOL_NAMES = [
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
] as const

export const BROWSER_CURRENT_READ_TOOL_NAMES = BROWSER_EXPLICIT_READ_TOOL_NAMES

export const BROWSER_CURRENT_ACT_TOOL_NAMES = BROWSER_CURRENT_PAGE_TOOL_NAMES.filter(
  (name) => name !== 'browser_research' && !(BROWSER_EXPLICIT_READ_TOOL_NAMES as readonly string[]).includes(name),
)

/** Fixed 0.160.1 dynamic tool registration; loading never changes authorization. */
export const READY_DEFERRED_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  ...BROWSER_SKILL_ONLY_TOOL_NAMES,
  'browser_archive', 'browser_collect', 'browser_dialog', 'browser_drag',
  'browser_hover', 'browser_research', 'browser_select', 'browser_upload',
])

export function readyCapabilityGroups(): readonly ReadyCapabilityGroup[] {
  return [
    {
      id: 'public_research',
      description:
        'Public web search and page fetch for open facts. Use when the user wants latest public information, not a bound local page.',
      tools: PUBLIC_RESEARCH_TOOL_NAMES,
      loading: 'always',
    },
    {
      id: 'browser_current_read',
      description:
        'Read the already-bound browser page: snapshot, find, read, screenshot, wait, and status. Requires an exact current page or a typed browser reference.',
      tools: BROWSER_CURRENT_READ_TOOL_NAMES,
      loading: 'always',
    },
    {
      id: 'browser_current_act',
      description:
        'Change the already-bound browser page: navigate, click, type, fill, select, hover, scroll, keys, drag, dialogs, and collect. Requires an exact current page and does not include browser_research.',
      tools: BROWSER_CURRENT_ACT_TOOL_NAMES,
      loading: 'mixed',
    },
    {
      id: 'calendar_read',
      description:
        'Read Ready in-app local calendar windows and the current calendar session. This is not Feishu calendar. Available whenever the calendar host is present.',
      tools: CALENDAR_READ_TOOL_NAMES,
      loading: 'always',
    },
    {
      id: 'calendar_write',
      description:
        'Create, update, or delete Ready in-app local calendar events. This is not Feishu calendar. Each write still requires the existing confirmation and event-id readback.',
      tools: CALENDAR_WRITE_TOOL_NAMES,
      loading: 'always',
    },
  ]
}

export function readyCapabilityCatalogDigest(): string {
  return digestCanonicalJson(readyCapabilityGroups())
}

export function readyCapabilityToolOwner(): Readonly<Record<string, ReadyCapabilityGroupId>> {
  const owner: Record<string, ReadyCapabilityGroupId> = {}
  for (const group of readyCapabilityGroups()) {
    for (const tool of group.tools) {
      if (owner[tool]) throw new Error(`capability_catalog_duplicate_tool:${tool}`)
      owner[tool] = group.id
    }
  }
  return owner
}

export function isReadyCapabilityCatalogTool(name: string): boolean {
  return readyCapabilityToolOwner()[name] !== undefined
}

export function readyCapabilityToolsForGroup(id: ReadyCapabilityGroupId): readonly string[] {
  const group = readyCapabilityGroups().find((entry) => entry.id === id)
  if (!group) throw new Error(`capability_catalog_missing_group:${id}`)
  return group.tools
}

export function assertReadyCapabilityCatalogInvariants(): void {
  const owner = readyCapabilityToolOwner()
  for (const name of BROWSER_CURRENT_READ_TOOL_NAMES) {
    if (owner[name] !== 'browser_current_read') {
      throw new Error(`capability_catalog_read_mismatch:${name}`)
    }
  }
  const expectedAct = [...BROWSER_CURRENT_PAGE_TOOL_NAMES]
    .filter((name) => name !== 'browser_research' && !BROWSER_CURRENT_READ_TOOL_NAMES.includes(name as never))
    .sort()
  const actualAct = [...BROWSER_CURRENT_ACT_TOOL_NAMES].sort()
  if (JSON.stringify(expectedAct) !== JSON.stringify(actualAct)) {
    throw new Error('capability_catalog_act_remainder_mismatch')
  }
  if (owner.browser_research) {
    throw new Error('capability_catalog_browser_research_in_first_batch')
  }
}
