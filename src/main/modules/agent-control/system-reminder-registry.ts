import { composeSystemReminder } from './system-reminder-assembly'

export type ReminderTopic =
  | 'budget'
  | 'missing-input'
  | 'checkpoint'
  | 'child-owned'
  | 'force-tool-locked'
  | 'force-tool-missing'
  | 'typed-action-preferred'
  // Stage 4 W2 — dedicated topics that previously lived as inline strings
  // in turn-engine.ts. Routing through the registry lets conflict resolution
  // and ordering apply, and keeps the topic taxonomy honest about which
  // reminders the engine emits.
  | 'skill-resume-context-prompt'
  | 'force-tool-checkpoint-blocked'

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
