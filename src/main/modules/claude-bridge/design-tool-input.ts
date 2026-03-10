import type { DesignPlannerResult } from './design-intent-planner'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function mergeDesignPlannerIntoToolInput(
  toolName: string,
  input: Record<string, unknown>,
  options: {
    preferredDesignTool: string | null
    designPlanner: DesignPlannerResult | null
    forceDesignTool: boolean
  },
): Record<string, unknown> {
  if (!options.forceDesignTool) return input
  if (!options.preferredDesignTool || toolName !== options.preferredDesignTool) return input
  if (!options.designPlanner) return input

  const plan = options.designPlanner.plan
  const merged: Record<string, unknown> = {
    ...input,
    taskType: typeof input.taskType === 'string' && input.taskType.trim() ? input.taskType : plan.taskType,
    audience: typeof input.audience === 'string' && input.audience.trim() ? input.audience : plan.audience,
    tone: typeof input.tone === 'string' && input.tone.trim() ? input.tone : plan.tone,
    compositionFamily: typeof input.compositionFamily === 'string' && input.compositionFamily.trim()
      ? input.compositionFamily
      : plan.compositionFamily,
    placementStrategy: typeof input.placementStrategy === 'string' && input.placementStrategy.trim()
      ? input.placementStrategy
      : plan.placementStrategy,
    themeKeywords: Array.isArray(input.themeKeywords) && input.themeKeywords.length > 0
      ? input.themeKeywords
      : plan.themeKeywords,
    contentSections: Array.isArray(input.contentSections) && input.contentSections.length > 0
      ? input.contentSections
      : plan.contentSections,
    palette: isPlainRecord(input.palette)
      ? { ...plan.palette, ...input.palette }
      : plan.palette,
    board: isPlainRecord(input.board)
      ? { ...plan.board, ...input.board }
      : plan.board,
    typography: isPlainRecord(input.typography)
      ? { ...plan.typography, ...input.typography }
      : plan.typography,
    layoutStrategy: isPlainRecord(input.layoutStrategy)
      ? { ...plan.layoutStrategy, ...input.layoutStrategy }
      : plan.layoutStrategy,
    semanticControls: isPlainRecord(input.semanticControls)
      ? { ...(plan.semanticControls || {}), ...input.semanticControls }
      : plan.semanticControls,
    reviewChecklist: Array.isArray(input.reviewChecklist) && input.reviewChecklist.length > 0
      ? input.reviewChecklist
      : plan.reviewChecklist,
    reasoningSummary: typeof input.reasoningSummary === 'string' && input.reasoningSummary.trim()
      ? input.reasoningSummary
      : plan.reasoningSummary,
    decisionTrace: Array.isArray(input.decisionTrace) && input.decisionTrace.length > 0
      ? input.decisionTrace
      : plan.decisionTrace,
    designDirectiveText: typeof input.designDirectiveText === 'string' && input.designDirectiveText.trim()
      ? input.designDirectiveText
      : options.designPlanner.instructionText,
    styleGuide: isPlainRecord(input.styleGuide)
      ? { ...(plan.styleGuide || {}), ...input.styleGuide }
      : plan.styleGuide,
    brief: isPlainRecord(input.brief)
      ? { ...(plan.brief || {}), ...input.brief }
      : plan.brief,
    styleSystem: isPlainRecord(input.styleSystem)
      ? { ...(plan.styleSystem || {}), ...input.styleSystem }
      : plan.styleSystem,
    layoutBlueprint: isPlainRecord(input.layoutBlueprint)
      ? { ...(plan.layoutBlueprint || {}), ...input.layoutBlueprint }
      : plan.layoutBlueprint,
    layoutBudget: isPlainRecord(input.layoutBudget)
      ? { ...(plan.layoutBudget || {}), ...input.layoutBudget }
      : plan.layoutBudget,
    scenePlan: isPlainRecord(input.scenePlan)
      ? { ...(plan.scenePlan || {}), ...input.scenePlan }
      : plan.scenePlan,
    executionProgram: isPlainRecord(input.executionProgram)
      ? { ...(plan.executionProgram || {}), ...input.executionProgram }
      : plan.executionProgram,
    repairScope: typeof input.repairScope === 'string' && input.repairScope.trim()
      ? input.repairScope
      : plan.repairScope,
    constraintFlags: plan.constraintFlags,
  }

  merged.ratio = plan.ratio
  merged.platform = plan.platform
  merged.sectionCount = plan.sectionCount

  return merged
}
