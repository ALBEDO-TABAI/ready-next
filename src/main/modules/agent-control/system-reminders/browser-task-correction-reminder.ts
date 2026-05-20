/**
 * Stage U PR U1.4 — browser task correction reminder (relocated from turn-engine.ts).
 *
 * When the model returns with zero tool calls during a browser task
 * (or returns calls that don't satisfy `shouldEnforceBrowserToolRetry()`),
 * the text-tool bridge needs to nudge the model toward at least one
 * `browser_*` tool call. Previously this nudge text lived inline in
 * turn-engine.ts:3834, violating AGENTS.md §5. U1.4 relocates the text
 * here so the gate can fence the regression.
 *
 * Trigger logic stays in turn-engine (iteration loop +
 * `shouldEnforceBrowserToolRetry` arbitration). The composer below is
 * the single source of the reminder text.
 */

import { composeSystemReminder } from './system-reminder-assembly'

export const BROWSER_TASK_CORRECTION_REMINDER_TEXT =
  '系统补充：当前任务是浏览器任务，至少先调用一个 browser_* 工具（例如 browser_search、browser_navigate、browser_read_page），不要直接解释这轮工具列表。'

export function composeBrowserTaskCorrectionReminder(): string | null {
  return composeSystemReminder([{
    topic: 'checkpoint',
    priority: 80,
    text: BROWSER_TASK_CORRECTION_REMINDER_TEXT,
  }])
}
