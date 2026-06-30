export const TASK_TYPES = ['direct_answer', 'short_task', 'multi_step_task', 'media_task', 'browser_transaction', 'continuation', 'research'] as const
export type TaskType = typeof TASK_TYPES[number]
export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value)
}
