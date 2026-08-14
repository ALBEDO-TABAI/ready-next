import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import {
  CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES,
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
  composeBrowserAdmissionToolNames,
  stripBrowserPublicToolNames,
  type BrowserAdmissionAuthoritySnapshot,
} from './codex-browser-admission'

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

const FILE_WRITE_OR_ORGANIZE = new Set<string>(FILE_WRITE_OR_ORGANIZE_TOOL_NAMES)

export function composeCodexTurnToolSnapshot(input: {
  resolved: ReadyToolTurnSnapshot
  authorizationId: string
  authorization: SkillToolAuthorization
  currentDocument?: { present: boolean; allowWrite: boolean }
  externalReadAllowedToolNames?: readonly string[]
  explicitResourceAllowedToolNames?: readonly string[]
  workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar' | null
  exclusiveAllowSet?: readonly string[] | null
  browserAdmission?: BrowserAdmissionAuthoritySnapshot | null
}): ReadyToolTurnSnapshot {
  let allowed = [...input.resolved.readyTurnToolAuthorization.allowedToolNames]

  if (input.currentDocument?.present) {
    allowed = allowed.filter((name) => !DOCUMENT_WRITE_TOOLS.has(name))
    if (!allowed.includes('document_read_section')) allowed.push('document_read_section')
    if (input.currentDocument.allowWrite) {
      for (const name of DOCUMENT_WRITE_FLOOR_TOOL_NAMES) {
        if (!allowed.includes(name)) allowed.push(name)
      }
    } else {
      allowed = allowed.filter((name) => name !== 'document_list_widgets')
    }
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
    input.workbenchMode === 'rss'
    && surfaceNames.has('rss_capture_session')
    && !allowed.includes('rss_capture_session')
  ) {
    allowed.push('rss_capture_session')
  }
  if (input.workbenchMode === 'calendar') {
    for (const name of ['calendar_capture_session', 'calendar_list_window'] as const) {
      if (surfaceNames.has(name) && !allowed.includes(name)) allowed.push(name)
    }
  }

  if (
    allowed.includes('map_plan_route')
    && surfaceNames.has('ask_user_questions')
    && !allowed.includes('ask_user_questions')
  ) {
    allowed.push('ask_user_questions')
  }

  if (input.browserAdmission) {
    allowed = stripBrowserPublicToolNames(allowed)
    for (const name of composeBrowserAdmissionToolNames(input.browserAdmission)) {
      if (surfaceNames.has(name) && !allowed.includes(name)) allowed.push(name)
    }
  }

  if (input.exclusiveAllowSet && input.exclusiveAllowSet.length > 0) {
    allowed = [...input.exclusiveAllowSet]
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
