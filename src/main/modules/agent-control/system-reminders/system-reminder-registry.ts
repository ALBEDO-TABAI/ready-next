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
