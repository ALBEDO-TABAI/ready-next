import type {
  MutableSkillChildCloseEvent,
  SkillChildCloseEvent,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'

type CloseStatus = MutableSkillChildCloseEvent['status']

const ALLOWED_PAIRS: Record<CloseStatus, ReadonlySet<SkillChildRunTerminalReason>> = {
  completed: new Set(['completed']),
  failed: new Set([
    'tool_not_registered',
    'nested_child_run_not_supported',
    'host_unavailable',
    'persistence_failed',
    'resume_launch_failed',
    'failed_skill',
    'child_process_crashed',
    'launch_stuck',
    'input_validation',
  ]),
  killed: new Set(['cancelled_user', 'process_restarted']),
  recoverable_paused: new Set([
    'queued_global_concurrency',
    'process_restarted',
    'checkpoint_background',
  ]),
  budget_paused: new Set(['checkpoint_budget', 'checkpoint_background']),
  blocked: new Set(['blocked_external', 'blocked_config']),
}

export class InvalidCloseEventError extends Error {
  readonly status: CloseStatus
  readonly terminalReason: SkillChildRunTerminalReason

  constructor(status: CloseStatus, terminalReason: SkillChildRunTerminalReason) {
    super(`Invalid skill close event: status=${status} terminalReason=${terminalReason}`)
    this.name = 'InvalidCloseEventError'
    this.status = status
    this.terminalReason = terminalReason
  }
}

export function validateSkillChildCloseInvariant(
  status: CloseStatus,
  terminalReason: SkillChildRunTerminalReason,
): void {
  const allowed = ALLOWED_PAIRS[status]
  if (!allowed || !allowed.has(terminalReason)) {
    throw new InvalidCloseEventError(status, terminalReason)
  }
}

export function freezeSkillChildCloseEvent(
  close: MutableSkillChildCloseEvent,
): SkillChildCloseEvent {
  validateSkillChildCloseInvariant(close.status, close.terminalReason)
  return deepFreeze(close)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen)
  }

  return Object.freeze(value)
}
