import type { SkillChildRunTerminalReason } from './skill-child-run-types'

export interface ChildRunRetryPolicy {
  retriable: boolean
  maxAttempts: number
  backoffMs: readonly number[]
}

const NON_RETRIABLE_POLICY: ChildRunRetryPolicy = {
  retriable: false,
  maxAttempts: 1,
  backoffMs: [],
}

const TWO_ATTEMPT_INFRA_POLICY: ChildRunRetryPolicy = {
  retriable: true,
  maxAttempts: 2,
  backoffMs: [2000, 10000],
}

export function getChildRunRetryPolicy(
  reason: SkillChildRunTerminalReason,
): ChildRunRetryPolicy {
  switch (reason) {
    case 'queued_global_concurrency':
      return {
        retriable: true,
        maxAttempts: 3,
        backoffMs: [5000, 5000, 5000],
      }
    case 'resume_launch_failed':
    case 'persistence_failed':
      return TWO_ATTEMPT_INFRA_POLICY
    case 'host_unavailable':
      return {
        retriable: true,
        maxAttempts: 3,
        backoffMs: [2000, 10000, 30000],
      }
    case 'process_restarted':
      return {
        retriable: true,
        maxAttempts: 2,
        backoffMs: [1000, 5000],
      }
    case 'completed':
    case 'checkpoint_budget':
    case 'checkpoint_background':
    case 'launch_stuck':
    case 'blocked_config':
    case 'blocked_external':
    case 'nested_child_run_not_supported':
    case 'cancelled_user':
    case 'failed_skill':
    case 'child_process_crashed':
    case 'tool_not_registered':
    case 'input_validation':
      return NON_RETRIABLE_POLICY
    default:
      return assertNever(reason)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled child-run terminal reason: ${String(value)}`)
}
