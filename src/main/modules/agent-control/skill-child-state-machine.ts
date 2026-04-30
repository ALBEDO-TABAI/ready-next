import type {
  SkillChildCloseEvent,
  SkillChildRunStatus,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'

export const CANONICAL_SKILL_CHILD_TERMINAL_REASONS = [
  'completed',
  'checkpoint_budget',
  'checkpoint_background',
  'queued_global_concurrency',
  'launch_stuck',
  'blocked_config',
  'blocked_external',
  'nested_child_run_not_supported',
  'cancelled_user',
  'failed_skill',
  'resume_launch_failed',
  'persistence_failed',
  'child_process_crashed',
  'host_unavailable',
  'tool_not_registered',
  'input_validation',
  'process_restarted',
] as const satisfies readonly SkillChildRunTerminalReason[]

export type SkillChildRunStatusClass = 'active' | 'paused' | 'blocked' | 'terminal'

const TERMINAL_REASON_SET = new Set<string>(CANONICAL_SKILL_CHILD_TERMINAL_REASONS)

const INFRA_ERROR_KIND_TO_TERMINAL_REASON: Partial<Record<string, SkillChildRunTerminalReason>> = {
  child_process_crashed: 'child_process_crashed',
  host_unavailable: 'host_unavailable',
  tool_not_registered: 'tool_not_registered',
  input_validation: 'input_validation',
  no_record: 'resume_launch_failed',
  no_payload: 'resume_launch_failed',
  repository_create_failed: 'persistence_failed',
  repository_update_failed: 'persistence_failed',
  repository_lookup_failed: 'persistence_failed',
  persistence_failed: 'persistence_failed',
}

export function isSkillChildRunTerminalReason(value: unknown): value is SkillChildRunTerminalReason {
  return typeof value === 'string' && TERMINAL_REASON_SET.has(value)
}

type StoredCloseLike = {
  terminalReason?: unknown
  error?: {
    kind?: unknown
  } | null
}

export function decodeStoredSkillChildTerminalReason(
  close: StoredCloseLike,
): SkillChildRunTerminalReason {
  if (close.terminalReason === 'infra_error') {
    const errorKind = typeof close.error?.kind === 'string' ? close.error.kind : null
    const mapped = errorKind
      ? INFRA_ERROR_KIND_TO_TERMINAL_REASON[errorKind]
      : undefined
    if (mapped) return mapped
    return 'child_process_crashed'
  }

  if (isSkillChildRunTerminalReason(close.terminalReason)) return close.terminalReason
  return 'child_process_crashed'
}

export function decodeStoredSkillChildCloseEvent(close: SkillChildCloseEvent): SkillChildCloseEvent
export function decodeStoredSkillChildCloseEvent(
  close: Omit<SkillChildCloseEvent, 'terminalReason'> & { terminalReason: unknown },
): SkillChildCloseEvent
export function decodeStoredSkillChildCloseEvent(
  close: Omit<SkillChildCloseEvent, 'terminalReason'> & { terminalReason: unknown },
): SkillChildCloseEvent {
  return {
    ...close,
    terminalReason: decodeStoredSkillChildTerminalReason(close),
  }
}

export function classifySkillChildRunStatus(status: SkillChildRunStatus): SkillChildRunStatusClass {
  switch (status) {
    case 'queued':
    case 'running':
      return 'active'
    case 'recoverable_paused':
    case 'budget_paused':
      return 'paused'
    case 'blocked':
      return 'blocked'
    case 'completed':
    case 'failed':
    case 'killed':
      return 'terminal'
  }
}

export function isSkillChildRunResumable(status: SkillChildRunStatus): boolean {
  return status === 'recoverable_paused' || status === 'budget_paused'
}
