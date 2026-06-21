import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { ToolPolicy } from './tool-policy/execution-tool-config'
import type { ExecutionIntentContext } from './execution-intent-resolver'

export type PolicyConflictType =
  | 'force_document_x_browser_workflow'
  | 'widget_task_x_browser_tools_allowed'
  | 'force_document_x_skill_preferred'

export interface PolicyArbitration {
  conflictsDetected: PolicyConflictType[]
  resolutionApplied: string[]
  recursionDepth: number
}

export const MAX_ARBITRATION_RECURSION = 1

export function resolvePolicyConflictFacts(params: {
  forceDocumentTool: boolean
  allowBrowserTools: boolean
  preferredSkillToolNames?: string[] | null
  browserDecisionMode: BrowserTaskDecisionMode
  documentWidgetTaskKind: ExecutionIntentContext['documentWidgetTaskKind']
  explicitWidgetCreateIntent: boolean
}): {
  conflicts: PolicyConflictType[]
  demotedBrowserDecisionMode: BrowserTaskDecisionMode | null
  skillPassthroughApplied: boolean
} {
  const conflicts: PolicyConflictType[] = []
  const browserWorkflow =
    params.browserDecisionMode === 'browser_workflow' ||
    params.browserDecisionMode === 'browser_upload_workflow'
  const widgetTaskKind = params.documentWidgetTaskKind
  const widgetMaintenanceKind =
    widgetTaskKind === 'update' || widgetTaskKind === 'inspect' || widgetTaskKind === 'remove'
  const explicitCreate = params.explicitWidgetCreateIntent === true

  if (params.forceDocumentTool && browserWorkflow && !explicitCreate) {
    conflicts.push('force_document_x_browser_workflow')
  }
  if (widgetMaintenanceKind && params.allowBrowserTools && !explicitCreate) {
    conflicts.push('widget_task_x_browser_tools_allowed')
  }
  const hasExplicitSkillPreference =
    Array.isArray(params.preferredSkillToolNames)
    && params.preferredSkillToolNames.length > 0
  if (params.forceDocumentTool && hasExplicitSkillPreference) {
    conflicts.push('force_document_x_skill_preferred')
  }

  const hasBrowserConflicts = conflicts.some((c) =>
    c === 'force_document_x_browser_workflow' || c === 'widget_task_x_browser_tools_allowed')
  const hasSkillConflict = conflicts.includes('force_document_x_skill_preferred')

  if (!hasBrowserConflicts && !hasSkillConflict) {
    return { conflicts, demotedBrowserDecisionMode: null, skillPassthroughApplied: false }
  }
  return {
    conflicts,
    demotedBrowserDecisionMode: hasBrowserConflicts ? 'free_tool_loop' : null,
    skillPassthroughApplied: hasSkillConflict,
  }
}

export function resolvePolicyConflicts(params: {
  toolPolicy: ToolPolicy
  browserDecisionMode: BrowserTaskDecisionMode
  executionIntentContext: ExecutionIntentContext
}): {
  conflicts: PolicyConflictType[]
  demotedBrowserDecisionMode: BrowserTaskDecisionMode | null
  skillPassthroughApplied: boolean
} {
  return resolvePolicyConflictFacts({
    forceDocumentTool: params.toolPolicy.forceDocumentTool,
    allowBrowserTools: params.toolPolicy.allowBrowserTools,
    preferredSkillToolNames: params.toolPolicy.preferredSkillToolNames,
    browserDecisionMode: params.browserDecisionMode,
    documentWidgetTaskKind: params.executionIntentContext.documentWidgetTaskKind,
    explicitWidgetCreateIntent: params.executionIntentContext.explicitWidgetCreateIntent,
  })
}
