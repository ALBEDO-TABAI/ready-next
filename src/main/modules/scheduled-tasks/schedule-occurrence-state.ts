import { createHash } from 'node:crypto'
import type {
  ScheduleMissedPolicy,
  ScheduleOccurrenceClaimStatus,
  ScheduleTriggerSource,
} from '../../../shared/scheduled-tasks'

const TERMINAL = new Set<ScheduleOccurrenceClaimStatus>([
  'dispatched',
  'dispatch_failed',
  'skipped_missed',
  'skipped_coalesced',
  'blocked_target',
])

const ALLOWED: Record<ScheduleOccurrenceClaimStatus, ScheduleOccurrenceClaimStatus[]> = {
  queued: ['dispatching', 'skipped_missed', 'skipped_coalesced', 'blocked_target'],
  dispatching: ['queued', 'dispatched', 'dispatch_failed', 'blocked_target'],
  dispatched: [],
  dispatch_failed: [],
  skipped_missed: [],
  skipped_coalesced: [],
  blocked_target: [],
}
export function assertOccurrenceTransition(
  from: ScheduleOccurrenceClaimStatus,
  to: ScheduleOccurrenceClaimStatus,
): void {
  if (!ALLOWED[from].includes(to)) throw new Error(`Invalid occurrence transition: ${from} -> ${to}`)
}

export function isTerminalOccurrenceStatus(status: ScheduleOccurrenceClaimStatus): boolean {
  return TERMINAL.has(status)
}

export function createScheduledOccurrenceId(input: {
  scheduleId: string
  scheduledFor: string
  triggerSource: Exclude<ScheduleTriggerSource, 'manual'>
}): string {
  const key = `${input.scheduleId}\0${input.scheduledFor}\0scheduled`
  return `occ-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export interface MissedOccurrenceDecision {
  scheduledFor: string
  status: 'queued' | 'skipped_missed' | 'skipped_coalesced'
  delayMs: number
}

export function reconcileMissedOccurrences(input: {
  dueScheduledFor: string[]
  coalesceMaxDelayMs?: number | null
  now: string
  recurring: boolean
  policy: ScheduleMissedPolicy
}): MissedOccurrenceDecision[] {
  const nowMs = Date.parse(input.now)
  const due = [...new Set(input.dueScheduledFor)]
    .filter((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= nowMs)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  if (!due.length) return []

  if (input.policy === 'skip') {
    return due.map((scheduledFor) => ({
      scheduledFor,
      status: 'skipped_missed',
      delayMs: Math.max(0, nowMs - Date.parse(scheduledFor)),
    }))
  }

  if (!input.recurring) {
    const scheduledFor = due[due.length - 1]
    return [{ scheduledFor, status: 'queued', delayMs: nowMs - Date.parse(scheduledFor) }]
  }

  const latest = due[due.length - 1]
  const latestIsEligible = input.coalesceMaxDelayMs === null || nowMs - Date.parse(latest) <= (input.coalesceMaxDelayMs ?? 24 * 60 * 60 * 1000)
  return due.map((scheduledFor) => ({
    scheduledFor,
    status: scheduledFor === latest && latestIsEligible
      ? 'queued'
      : scheduledFor === latest
        ? 'skipped_missed'
        : 'skipped_coalesced',
    delayMs: nowMs - Date.parse(scheduledFor),
  }))
}
