import { RSS_READ_TOOL_NAMES } from './codex-rss-resources'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import {
  CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES,
  FOLDER_EXPORT_FLOOR_TOOL_NAMES,
} from '../domain-adapters/capability-floors'
import {
  DOCUMENT_WRITE_FLOOR_TOOL_NAMES,
  FILE_WRITE_OR_ORGANIZE_TOOL_NAMES,
  TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
} from './codex-product-action-map'
import {
  buildReadyTurnToolAuthorization,
  type ReadyToolTurnSnapshot,
} from './codex-tool-surface'
import {
  composeBrowserAdmissionExtraToolNames,
  stripBrowserPublicToolNames,
  type BrowserAdmissionAuthoritySnapshot,
} from './codex-browser-admission'
import {
  isReadyCapabilityCatalogTool,
  readyCapabilityToolsForGroup,
} from './codex-capability-catalog'
import {
  resolveReadyCapabilityTurnAvailability,
  type ReadyCapabilityTurnAvailability,
} from './codex-capability-turn-availability'
import { READY_MEMORY_SEARCH_TOOL_NAME } from '../ready-memory'

const DOCUMENT_WRITE_TOOLS = new Set<string>([
  'document_new_tab',
  'document_open_tab',
  'document_switch_tab',
  'document_rename_tab',
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
  'document_save_tab',
])

const ANCHORED_DOCUMENT_TOOLS = new Set<string>([...DOCUMENT_WRITE_TOOLS, 'document_read_section', 'document_list_widgets'])

const FILE_WRITE_OR_ORGANIZE = new Set<string>(FILE_WRITE_OR_ORGANIZE_TOOL_NAMES)

export function composeCodexTurnToolSnapshot(input: {
  resolved: ReadyToolTurnSnapshot
  authorizationId: string
  authorization: SkillToolAuthorization
  currentDocument?: { present: boolean; allowWrite: boolean }
  folderExport?: { present: boolean; allowWrite: boolean }
  externalReadAllowedToolNames?: readonly string[]
  explicitResourceAllowedToolNames?: readonly string[]
  hasRSSResource?: boolean
  workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar' | null
  exclusiveAllowSet?: readonly string[] | null
  browserAdmission?: BrowserAdmissionAuthoritySnapshot | null
  capabilityAvailability?: ReadyCapabilityTurnAvailability | null
  readyMemory?: { enabled: boolean; hasEntries: boolean }
  mapRouteMode?: 'configured_primary' | 'public_web_fallback' | null
}): ReadyToolTurnSnapshot {
  const intentAllowed = new Set(input.resolved.readyTurnToolAuthorization.allowedToolNames)
  let allowed = input.resolved.readyTurnToolAuthorization.allowedToolNames.filter(
    (name) => name !== READY_MEMORY_SEARCH_TOOL_NAME,
  )

  if (input.currentDocument?.present) {
    allowed = allowed.filter((name) => !DOCUMENT_WRITE_TOOLS.has(name))
    if (!allowed.includes('document_read_section')) allowed.push('document_read_section')
    if (input.currentDocument.allowWrite) {
      // Writing is the default for a pointed-at document, so a thread frozen without these tools stays read-only.
      const frozenNames = new Set(input.resolved.readyToolSurface.toolNames)
      for (const name of DOCUMENT_WRITE_FLOOR_TOOL_NAMES) {
        if (frozenNames.has(name) && !allowed.includes(name)) allowed.push(name)
      }
    } else {
      allowed = allowed.filter((name) => name !== 'document_list_widgets')
    }
  } else {
    // Every document action runs against the document anchored when the message was sent; without one, a
    // document tool can only fail, so the model is not offered any (files and folders keep their own tools).
    allowed = allowed.filter((name) => !ANCHORED_DOCUMENT_TOOLS.has(name))
  }

  if (input.externalReadAllowedToolNames && input.externalReadAllowedToolNames.length > 0) {
    for (const name of input.externalReadAllowedToolNames) {
      if (!allowed.includes(name)) allowed.push(name)
    }
  }

  const explicitNames = new Set(input.explicitResourceAllowedToolNames || [])
  allowed = allowed.filter((name) => !FILE_WRITE_OR_ORGANIZE.has(name) || explicitNames.has(name))
  for (const name of explicitNames) {
    if (!allowed.includes(name)) allowed.push(name)
  }

  const surfaceNames = new Set(input.resolved.readyToolSurface.toolNames)
  if (
    input.readyMemory?.enabled === true
    && input.readyMemory.hasEntries
    && surfaceNames.has(READY_MEMORY_SEARCH_TOOL_NAME)
    && input.exclusiveAllowSet == null
  ) {
    allowed.push(READY_MEMORY_SEARCH_TOOL_NAME)
  }
  if (input.folderExport?.present && input.folderExport.allowWrite && input.exclusiveAllowSet == null) {
    for (const name of FOLDER_EXPORT_FLOOR_TOOL_NAMES) {
      if (surfaceNames.has(name) && !allowed.includes(name)) allowed.push(name)
    }
  }
  if (
    input.workbenchMode === 'rss'
    && surfaceNames.has('rss_capture_session')
    && !allowed.includes('rss_capture_session')
  ) {
    allowed.push('rss_capture_session')
  }
  if (
    allowed.includes('map_plan_route')
    && surfaceNames.has('ask_user_questions')
    && !allowed.includes('ask_user_questions')
  ) {
    allowed.push('ask_user_questions')
  }

  const applyCapabilityCatalog = input.capabilityAvailability != null
    || input.browserAdmission != null
    || input.workbenchMode === 'calendar'

  if (input.browserAdmission) {
    allowed = stripBrowserPublicToolNames(allowed)
  }

  if (applyCapabilityCatalog) {
    allowed = allowed.filter((name) => !isReadyCapabilityCatalogTool(name) && name !== 'browser_research')
    const availability = input.capabilityAvailability ?? resolveReadyCapabilityTurnAvailability({
      publicResearchProviderAvailable: surfaceNames.has('web_search') || surfaceNames.has('web_fetch'),
      calendarHostAvailable: surfaceNames.has('calendar_list_window')
        || surfaceNames.has('calendar_capture_session')
        || surfaceNames.has('calendar_create_event'),
      calendarProductMapped: surfaceNames.has('calendar_create_event'),
      workbenchMode: input.workbenchMode,
      currentBrowserPageRef: input.browserAdmission?.currentBrowserRoot || null,
      explicitBrowserReadRefs: input.browserAdmission?.explicitBrowserReadRefs || [],
      tagForgeExclusive: input.exclusiveAllowSet != null
        || input.browserAdmission?.tagForgeExclusive === true,
    })
    if (input.exclusiveAllowSet == null) {
      for (const groupId of availability.availableGroupIds) {
        for (const name of readyCapabilityToolsForGroup(groupId)) {
          if (surfaceNames.has(name) && !allowed.includes(name)) allowed.push(name)
        }
      }
      if (input.browserAdmission) {
        for (const name of composeBrowserAdmissionExtraToolNames(input.browserAdmission)) {
          if (surfaceNames.has(name) && !allowed.includes(name)) allowed.push(name)
        }
      }
    }
  }

  const candidatePrimitives = input.authorization.mode === 'none'
    ? input.authorization.candidateSkillPrimitives
    : null
  if (input.exclusiveAllowSet == null && candidatePrimitives) {
    for (const name of candidatePrimitives.primitives) {
      if (surfaceNames.has(name) && !allowed.includes(name)) allowed.push(name)
    }
    if (
      surfaceNames.has('ask_user_questions')
      && !allowed.includes('ask_user_questions')
      && (
        allowed.includes('calendar_list_window')
        || surfaceNames.has('calendar_list_window')
      )
    ) {
      allowed.push('ask_user_questions')
    }
  }

  if (input.mapRouteMode) {
    allowed = allowed.filter((name) => (
      !isReadyCapabilityCatalogTool(name) || intentAllowed.has(name)
    ))
  }

  if (input.exclusiveAllowSet && input.exclusiveAllowSet.length > 0) {
    allowed = [...input.exclusiveAllowSet]
  }

  if (input.hasRSSResource) for (const name of RSS_READ_TOOL_NAMES) {
    if (!surfaceNames.has(name)) throw new Error('rss_read_tool_surface_missing')
    if (!allowed.includes(name)) allowed.push(name)
  }

  return {
    readyToolSurface: input.resolved.readyToolSurface,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: input.authorizationId,
      authorization: input.authorization,
      toolSurface: input.resolved.readyToolSurface,
      allowedToolNames: allowed,
    }),
  }
}

export function currentDocumentWriteFloorToolNames(): readonly string[] {
  return CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES
}

export function tagForgeExclusiveToolNames(): readonly string[] {
  return TAG_FORGE_EXCLUSIVE_TOOL_NAMES
}
