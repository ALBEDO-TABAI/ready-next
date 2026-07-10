import { composeSystemReminder } from './system-reminder-assembly'

export type ReminderTopic =
  | 'action-announcement-steer'
  | 'budget'
  | 'missing-input'
  | 'checkpoint'
  | 'child-owned'
  | 'force-tool-locked'
  | 'force-tool-missing'
  | 'typed-action-preferred'
  | 'provider-tool-arguments-corrupt'
  // Stage 4 W2 — dedicated topics that previously lived as inline strings
  // in turn-engine.ts. Routing through the registry lets conflict resolution
  // and ordering apply, and keeps the topic taxonomy honest about which
  // reminders the engine emits.
  | 'skill-resume-context-prompt'
  | 'force-tool-checkpoint-blocked'
  // Stage N — fired when the parent's force-tool synthesis is blocked
  // because the action belongs to a manifest-declared `child_loop` skill.
  // Coexists with `force-tool-checkpoint-blocked`: Phase 1.2 fires the two
  // on disjoint branches (the manifest fence's early-break short-circuits
  // before the checkpoint-instead-of-force logic can run), so default
  // conflicts table lists none.
  | 'force-tool-blocked-child-owned'
  // Stage R W1.3 — daily date prompt for live-info / web research turns.
  // Pure observability: the reminder advises the model about the current
  // date so it can apply staleness judgement to web_search / web_fetch
  // citations. No conflicts with other topics.
  | 'current-date'
  // S2-2 — background task terminal summaries drained before each model
  // call (previously registered via an `as ReminderTopic` cast; now part of
  // the honest vocabulary). No conflicts.
  | 'background-task-terminal'
  // S4-5 — active plan current-step re-injection with evidence-backed advancement. No conflicts.
  | 'active-plan-step'
  | 'browser-action-session'
  // D2 (2026-07-03) — per-model-call acceptance-criteria self-check for
  // outcome-bearing task types (multi_step/research/media/browser_transaction).
  // Same template source as terminal adjudication (resolveCriteria). No conflicts.
  | 'criteria-self-check'
  // P2-1 (T4) — L1 技能目录：全部技能 name+description 常驻注入（预算裁剪），让模型按描述自选。
  // 纯清单，不开原语（激活才开）。priority 80（低于 current-date 90）。No conflicts.
  | 'skill-catalog'
  // P3-2 — selected 轮：激活技能带脚本但未获脚本执行授权时提醒模型走只读方法论，别伪造脚本结果。priority 85。
  | 'skill-shell-consent'

export interface ReminderEntry {
  readonly topic: ReminderTopic
  readonly priority: number
  readonly text: string
  readonly conflictsWith?: ReadonlyArray<ReminderTopic>
}

export interface SystemReminderRegistry {
  register(entry: ReminderEntry): void
  compose(): string | null
}

export function createSystemReminderRegistry(): SystemReminderRegistry {
  const entries = new Map<ReminderTopic, ReminderEntry>()

  return {
    register(entry): void {
      entries.set(entry.topic, entry)
    },
    compose(): string | null {
      return composeSystemReminder(Array.from(entries.values()))
    },
  }
}
