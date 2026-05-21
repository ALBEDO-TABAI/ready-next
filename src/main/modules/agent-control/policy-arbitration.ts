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

export function resolvePolicyConflicts(params: {
  toolPolicy: ToolPolicy
  browserDecisionMode: BrowserTaskDecisionMode
  executionIntentContext: ExecutionIntentContext
}): {
  conflicts: PolicyConflictType[]
  demotedBrowserDecisionMode: BrowserTaskDecisionMode | null
  skillPassthroughApplied: boolean
} {
  const conflicts: PolicyConflictType[] = []
  const browserWorkflow =
    params.browserDecisionMode === 'browser_workflow' ||
    params.browserDecisionMode === 'browser_upload_workflow'
  const widgetTaskKind = params.executionIntentContext.documentWidgetTaskKind
  const widgetMaintenanceKind =
    widgetTaskKind === 'update' || widgetTaskKind === 'inspect' || widgetTaskKind === 'remove'
  const explicitCreate = params.executionIntentContext.explicitWidgetCreateIntent === true

  if (params.toolPolicy.forceDocumentTool && browserWorkflow && !explicitCreate) {
    conflicts.push('force_document_x_browser_workflow')
  }
  if (widgetMaintenanceKind && params.toolPolicy.allowBrowserTools && browserWorkflow && !explicitCreate) {
    conflicts.push('widget_task_x_browser_tools_allowed')
  }
  const hasExplicitSkillPreference =
    Array.isArray(params.toolPolicy.preferredSkillToolNames)
    && params.toolPolicy.preferredSkillToolNames.length > 0
  if (params.toolPolicy.forceDocumentTool && hasExplicitSkillPreference) {
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
