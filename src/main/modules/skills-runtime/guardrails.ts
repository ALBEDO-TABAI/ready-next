import type { SkillActionDefinition, SkillDefinition, SkillStep } from '../../../shared/skill-execution-types'

export function getVisibleSkillActions(definition: SkillDefinition): SkillActionDefinition[] {
  return definition.actions.filter((action) => action.visibility !== 'internal')
}

export function getSkillStep(definition: SkillDefinition, stepId: string): SkillStep | null {
  return definition.workflow?.steps.find((step) => step.id === stepId) || null
}

export function assertWorkflowSkill(definition: SkillDefinition): void {
  if (definition.executionMode !== 'workflow' || !definition.workflow) {
    throw new Error(`Skill ${definition.id} is not a workflow skill`)
  }
}

export function isWorkflowStarterAction(definition: SkillDefinition, actionName: string): boolean {
  return definition.executionMode === 'workflow' && definition.defaultAction === actionName
}
