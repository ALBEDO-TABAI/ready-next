import type { TaskType } from '../../../../shared/task-types'
import type { IntentClassification } from '../intent-classifier'
import { createRunBudgetSeed } from '../task-projection/run-budget-policy'
import type { CodexSkillCompletionProfile } from './codex-skill-completion-profile'

type CodexProductTaskInput = {
  skillAuthorization:
    | { mode: 'none' }
    | {
        mode: 'selected'
        completionProfile: CodexSkillCompletionProfile
      }
  intentClassification?: Pick<IntentClassification, 'primaryDomain'>
  hasFolderExportDestination?: boolean
}

type FolderOutputActivation = {
  kind: 'positive' | 'no_contract' | 'selection_required' | 'pending' | 'no_write'
}

function taskTypeForSkillProfile(profile: CodexSkillCompletionProfile): TaskType {
  switch (profile) {
    case 'advisory':
      return 'direct_answer'
    case 'research_sources':
      return 'research'
    case 'artifact_delivery':
      return 'artifact_task'
    case 'transaction_confirmed':
      return 'transaction_task'
    case 'research_artifact_delivery':
      return 'research_artifact_task'
    case 'tool_result':
      return 'short_task'
  }
}

export function resolveCodexProductTaskFacts(
  input: CodexProductTaskInput,
): { taskType: TaskType; module: 'skill' | 'browser' | 'system' } {
  if (input.skillAuthorization.mode === 'selected') {
    return {
      taskType: taskTypeForSkillProfile(input.skillAuthorization.completionProfile),
      module: 'skill',
    }
  }
  if (input.intentClassification?.primaryDomain === 'research') {
    return { taskType: 'research', module: 'browser' }
  }
  if (input.intentClassification?.primaryDomain === 'browser') {
    return { taskType: 'direct_answer', module: 'browser' }
  }
  return { taskType: 'direct_answer', module: 'system' }
}

export function resolveCodexBrowserWorkflowTaskFacts(
  facts: { taskType: TaskType; module: string },
  hasWorkflow: boolean,
): { taskType: TaskType; module: string } {
  return hasWorkflow && facts.module === 'browser'
    ? { taskType: 'browser_transaction', module: 'browser' }
    : facts
}

export function resolveCodexProductCloseoutTaskFacts(
  facts: { taskType: TaskType; module: 'skill' | 'browser' | 'system' },
  folderOutputActivation: FolderOutputActivation,
): { taskType: TaskType; module: 'skill' | 'browser' | 'system' } {
  if (
    facts.taskType === 'direct_answer'
    && facts.module === 'system'
    && folderOutputActivation.kind === 'positive'
  ) {
    return { taskType: 'short_task', module: 'system' }
  }
  return facts
}

export function createCodexProductBudgetSeed(
  input: CodexProductTaskInput,
): { maxIterations: number; maxToolCalls: number; maxParallelToolGroups: 1 } {
  const selectedProfile = input.skillAuthorization.mode === 'selected'
    ? input.skillAuthorization.completionProfile
    : null
  const researchProfile = selectedProfile === 'research_sources'
    || selectedProfile === 'research_artifact_delivery'
  const taskType = researchProfile
    ? resolveCodexProductTaskFacts(input).taskType
    : input.hasFolderExportDestination || (selectedProfile !== null && selectedProfile !== 'advisory')
    ? 'multi_step_task'
    : input.intentClassification?.primaryDomain === 'browser'
      ? 'browser_transaction'
      : resolveCodexProductTaskFacts(input).taskType
  const preset = createRunBudgetSeed(taskType)
  return {
    maxIterations: preset.maxIterations,
    maxToolCalls: preset.maxToolCalls,
    maxParallelToolGroups: 1,
  }
}
