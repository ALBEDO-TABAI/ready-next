import type { TaskType } from '../../../../shared/task-types'
import type { IntentClassification } from '../intent-classifier'
import type { CodexSkillCompletionProfile } from './codex-skill-completion-profile'

// The serialized product contract currently requires finite safe integers.
// This sentinel means ordinary work is Runtime-managed: it leaves headroom for
// the small delivery/final lanes while removing task-shape quotas in practice.
export const CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL = Number.MAX_SAFE_INTEGER - 1_024

type CodexProductTaskInput = {
  skillAuthorization:
    | { mode: 'none' }
    | {
        mode: 'selected'
        completionProfile: CodexSkillCompletionProfile
      }
  intentClassification?: Pick<IntentClassification, 'primaryDomain'>
  hasFolderExportDestination?: boolean
  hasActionObligations?: boolean
  hasBrowserToolSurface?: boolean
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
  if (input.intentClassification?.primaryDomain === 'browser' || input.hasBrowserToolSurface) {
    return { taskType: 'direct_answer', module: 'browser' }
  }
  if (input.hasActionObligations) {
    return { taskType: 'short_task', module: 'system' }
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
  const browserObservationClosureCapacity = input.intentClassification?.primaryDomain === 'browser'
    || input.hasBrowserToolSurface
    ? 1
    : 0
  return {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + browserObservationClosureCapacity,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + browserObservationClosureCapacity,
    maxParallelToolGroups: 1,
  }
}
