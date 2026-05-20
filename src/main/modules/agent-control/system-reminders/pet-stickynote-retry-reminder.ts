/**
 * Stage U PR U1.4 — pet stickynote retry reminder (relocated from turn-engine.ts).
 *
 * When the model returns with zero tool calls during a pet sticky-note
 * intent, `shouldEnforcePetToolRetry()` returns true and the text-tool
 * bridge needs to nudge the model toward the `pet_show_sticky_note`
 * action. Previously this nudge text lived inline in turn-engine.ts:3807,
 * which violated AGENTS.md §5 ("turn-engine.ts only schedules; it must
 * not carry product identity"). U1.4 relocates the text here so the
 * `check-turn-engine-no-domain-branch.cjs` gate can fence the regression.
 *
 * Trigger logic stays in turn-engine (it owns the iteration loop +
 * `shouldEnforcePetToolRetry` arbitration). The composer below is the
 * single source of the reminder text.
 */

import { composeSystemReminder } from './system-reminder-assembly'

export const PET_STICKYNOTE_RETRY_REMINDER_TEXT =
  '系统补充：当前任务是宠物便利贴任务，必须调用 pet_show_sticky_note 把内容贴到猫猫旁边；不要写入文档，也不要只用文字说"贴好了"。'

export function composePetStickynoteRetryReminder(): string | null {
  return composeSystemReminder([{
    topic: 'checkpoint',
    priority: 80,
    text: PET_STICKYNOTE_RETRY_REMINDER_TEXT,
  }])
}
