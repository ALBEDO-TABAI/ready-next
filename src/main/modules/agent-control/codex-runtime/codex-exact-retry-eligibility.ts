import type { PreparedCodexProductRun } from './codex-product-run-preparer'

export function exactRetrySourceFacts(source: PreparedCodexProductRun) {
  const ingress = source.ingress
  return {
    sourceResourceEmpty: ingress.canonicalCurrentInputRef.input.every((item) => item.type === 'text')
      && ingress.explicitResourceEnvelope.input.length === 0
      && ingress.explicitResourceEnvelope.resourceRefs.length === 0
      && ingress.resourceAdditionalContext.length === 0
      && !ingress.currentDocumentAnchor && !source.browserPageRef && !source.externalReadSlice
      && !source.resourceAuthorities?.length
      && !Object.values(source.productSurfaceTargets || {}).some((target) => target != null),
    sourceSkillAndExecutionCeilingEmpty: source.readyTurnToolAuthorization.skillAuthorization.mode === 'none'
      && !source.outputContract && !source.actionObligations?.requirements.length,
    sourceMemoryPayloadEmpty: !source.readyMemorySnapshot.enabled || source.readyMemorySnapshot.entries.length === 0,
    sourceMode: source.sourceTrustedEnvironmentRef.workbenchMode,
  }
}

export const CODEX_ACTION_BLOCKER_PRECEDENCE = [
  'same_thread_history_retained',
  'terminal_history_unknown',
  'retry_source_not_current',
  'effectful_or_interactive_retry_unsupported',
  'resource_restatement_required',
  'current_skill_context_restatement_required',
  'current_memory_restatement_required',
  'current_environment_restatement_required',
  'history_materializing',
] as const

export type CodexActionBlocker = typeof CODEX_ACTION_BLOCKER_PRECEDENCE[number]

export type ExactRetryEligibility = {
  availability: 'ready' | 'blocked' | 'not_applicable'
  blockers: CodexActionBlocker[]
}

export function resolveExactRetryEligibility(input: {
  historyKind: 'continuation_safe' | 'diverged' | 'unknown_reset_required' | 'reset' | 'closed'
  effectState: 'none' | 'confirmed' | 'indeterminate'
  toolCount: number
  interactionCount: number
  sourceResourceEmpty: boolean
  sourceSkillAndExecutionCeilingEmpty: boolean
  sourceMemoryPayloadEmpty: boolean
  sourceMode: 'browser' | 'document' | 'rss' | 'calendar'
  currentMode: 'browser' | 'document' | 'rss' | 'calendar'
  trustedCurrentMode: 'browser' | 'document' | 'rss' | 'calendar'
  historyMaterialized: boolean
  currentSourceEligible: boolean
  currentFacts?: {
    resourceEmpty: boolean
    skillAndExecutionCeilingValid: boolean
    memoryPayloadEmpty: boolean
    selectedSeedCount: number
  }
}): ExactRetryEligibility {
  const blockers = new Set<CodexActionBlocker>()
  if (input.historyKind === 'continuation_safe') blockers.add('same_thread_history_retained')
  if (input.historyKind === 'unknown_reset_required') blockers.add('terminal_history_unknown')
  if (input.historyKind === 'diverged' && !input.currentSourceEligible) blockers.add('retry_source_not_current')
  if (input.effectState !== 'none' || input.toolCount > 0 || input.interactionCount > 0) {
    blockers.add('effectful_or_interactive_retry_unsupported')
  }
  if (!input.sourceResourceEmpty || input.currentFacts?.resourceEmpty === false) {
    blockers.add('resource_restatement_required')
  }
  if (!input.sourceSkillAndExecutionCeilingEmpty
    || input.currentFacts?.skillAndExecutionCeilingValid === false) {
    blockers.add('current_skill_context_restatement_required')
  }
  if (!input.sourceMemoryPayloadEmpty || input.currentFacts?.memoryPayloadEmpty === false) {
    blockers.add('current_memory_restatement_required')
  }
  if ((input.sourceMode !== 'browser' && input.sourceMode !== 'document')
    || input.currentMode !== input.trustedCurrentMode
    || input.sourceMode !== input.trustedCurrentMode) {
    blockers.add('current_environment_restatement_required')
  }
  if (input.historyKind === 'diverged' && input.currentSourceEligible
    && (!input.historyMaterialized
      || (input.currentFacts !== undefined && input.currentFacts.selectedSeedCount !== 1))) {
    blockers.add('history_materializing')
  }
  const ordered = CODEX_ACTION_BLOCKER_PRECEDENCE.filter((blocker) => blockers.has(blocker))
  return {
    availability: ordered.length === 0 && input.historyKind === 'diverged'
      ? 'ready'
      : !blockers.has('retry_source_not_current')
        && (blockers.has('history_materializing') || blockers.has('terminal_history_unknown'))
        ? 'blocked'
        : 'not_applicable',
    blockers: ordered,
  }
}
