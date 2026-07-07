/**
 * P3-2 — selected-turn reminder when the active skill has scripts but lacks shell-execution consent.
 *
 * Tells the model, plainly, that it cannot run this skill's scripts this turn and how the USER can
 * grant it — so it uses the read-only methodology instead of FABRICATING script results. Reminder
 * text lives here (a reminder module), never inlined in the scheduler (CLAUDE.md §5).
 */
import type { SystemReminderRegistry } from './system-reminder-registry'

/**
 * Reminder text, or null when no reminder is warranted (no scripts, embedded, or already consented).
 * Pure — the caller supplies the resolved flags.
 */
export function skillShellConsentReminderText(params: {
  skillName: string
  hasScripts: boolean
  isEmbedded: boolean
  hasConsent: boolean
}): string | null {
  if (!params.hasScripts || params.isEmbedded || params.hasConsent) return null
  return `技能「${params.skillName}」包含可执行脚本但未获脚本执行授权；请在 技能中心 → ${params.skillName} 开启“允许运行脚本”，或改用只读方法论部分完成任务，不要伪造脚本运行结果。`
}

export function registerSkillShellConsentReminder(
  registry: SystemReminderRegistry,
  params: { skillName: string; hasScripts: boolean; isEmbedded: boolean; hasConsent: boolean },
): void {
  const text = skillShellConsentReminderText(params)
  if (!text) return
  registry.register({
    topic: 'skill-shell-consent',
    priority: 85,
    text,
  })
}
