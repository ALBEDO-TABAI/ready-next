import {
  isSkillChildRunOpenStatus,
  SKILL_CHILD_RUN_OPEN_STATUSES,
  type SkillChildRunOpenStatus,
} from '../../../../shared/skill-child-run-status'

export type OpenTaskStatus = SkillChildRunOpenStatus

export const OPEN_TASK_STATUSES = SKILL_CHILD_RUN_OPEN_STATUSES

export function isOpenTaskStatus(value: unknown): value is OpenTaskStatus {
  return isSkillChildRunOpenStatus(value)
}

export function isPausedTaskStatus(
  value: unknown,
): value is Extract<OpenTaskStatus, 'blocked' | 'recoverable_paused' | 'budget_paused'> {
  return value === 'blocked' || value === 'recoverable_paused' || value === 'budget_paused'
}

export function isDirectlyResumableTaskStatus(
  value: unknown,
): value is Extract<OpenTaskStatus, 'recoverable_paused' | 'budget_paused'> {
  return value === 'recoverable_paused' || value === 'budget_paused'
}
