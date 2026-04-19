import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { ToolPolicy } from './execution-tool-config'
import type { ExecutionIntentContext } from './execution-intent-resolver'

export type PolicyConflictType =
  | 'force_document_x_browser_workflow'
  | 'widget_task_x_browser_tools_allowed'

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

  if (conflicts.length === 0) {
    return { conflicts, demotedBrowserDecisionMode: null }
  }
  return { conflicts, demotedBrowserDecisionMode: 'free_tool_loop' }
}
