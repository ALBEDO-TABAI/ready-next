export const SKILL_CHILD_RUN_STATUSES = [
  'queued',
  'running',
  'recoverable_paused',
  'budget_paused',
  'blocked',
  'completed',
  'failed',
  'killed',
] as const

export type SkillChildRunStatus = typeof SKILL_CHILD_RUN_STATUSES[number]

export const SKILL_CHILD_RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'killed',
] as const satisfies readonly SkillChildRunStatus[]

export type SkillChildRunTerminalStatus = typeof SKILL_CHILD_RUN_TERMINAL_STATUSES[number]
export type SkillChildRunOpenStatus = Exclude<SkillChildRunStatus, SkillChildRunTerminalStatus>

const SKILL_CHILD_RUN_STATUS_SET = new Set<string>(SKILL_CHILD_RUN_STATUSES)
const SKILL_CHILD_RUN_TERMINAL_STATUS_SET = new Set<string>(SKILL_CHILD_RUN_TERMINAL_STATUSES)
export const SKILL_CHILD_RUN_OPEN_STATUSES = SKILL_CHILD_RUN_STATUSES.filter(
  (status): status is SkillChildRunOpenStatus => !SKILL_CHILD_RUN_TERMINAL_STATUS_SET.has(status),
)
const SKILL_CHILD_RUN_OPEN_STATUS_SET = new Set<string>(SKILL_CHILD_RUN_OPEN_STATUSES)

export function isSkillChildRunStatus(value: unknown): value is SkillChildRunStatus {
  return typeof value === 'string' && SKILL_CHILD_RUN_STATUS_SET.has(value)
}

export function isSkillChildRunTerminalStatus(
  value: unknown,
): value is SkillChildRunTerminalStatus {
  return typeof value === 'string' && SKILL_CHILD_RUN_TERMINAL_STATUS_SET.has(value)
}

export function isSkillChildRunOpenStatus(value: unknown): value is SkillChildRunOpenStatus {
  return typeof value === 'string' && SKILL_CHILD_RUN_OPEN_STATUS_SET.has(value)
}
