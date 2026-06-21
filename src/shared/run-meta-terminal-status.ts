export const RUN_META_TERMINAL_STATUSES = [
  'done',
  'error',
  'cancelled',
  'preempted',
  'interrupted',
  'checkpoint',
  'completed',
  'failed',
  'killed',
] as const

export type RunMetaTerminalStatus = typeof RUN_META_TERMINAL_STATUSES[number]

const RUN_META_TERMINAL_STATUS_SET = new Set<string>(RUN_META_TERMINAL_STATUSES)

export function isRunMetaTerminalStatus(value: unknown): value is RunMetaTerminalStatus {
  return typeof value === 'string' && RUN_META_TERMINAL_STATUS_SET.has(value)
}
