import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'
import type { ReminderEntry, ReminderTopic } from './system-reminder-registry'

const DEFAULT_CONFLICTS: Record<ReminderTopic, ReadonlyArray<ReminderTopic>> = {
  checkpoint: [],
  'child-owned': ['typed-action-preferred', 'force-tool-locked', 'force-tool-missing'],
  'force-tool-locked': ['typed-action-preferred'],
  'force-tool-missing': ['typed-action-preferred', 'force-tool-locked'],
  budget: [],
  'missing-input': [],
  'typed-action-preferred': [],
}

export function composeSystemReminder(
  entries: ReadonlyArray<ReminderEntry>,
): string | null {
  const byTopic = new Map<ReminderTopic, ReminderEntry>()
  for (const entry of entries) {
    byTopic.set(entry.topic, entry)
  }

  const ordered = Array.from(byTopic.values()).sort(compareReminderEntries)
  if (ordered.length === 0) return null

  const suppressedTopics = collectSuppressedTopics(ordered)
  const visibleEntries = ordered.filter((entry) => !suppressedTopics.has(entry.topic))
  if (visibleEntries.length === 0) return null

  return visibleEntries.map((entry) => entry.text).join('\n')
}

function compareReminderEntries(a: ReminderEntry, b: ReminderEntry): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  return a.topic.localeCompare(b.topic)
}

function collectSuppressedTopics(
  ordered: ReadonlyArray<ReminderEntry>,
): Set<ReminderTopic> {
  const presentTopics = new Set(ordered.map((entry) => entry.topic))
  const suppressedTopics = new Set<ReminderTopic>()

  for (const entry of ordered) {
    const conflicts = entry.conflictsWith ?? DEFAULT_CONFLICTS[entry.topic]
    for (const topic of conflicts) {
      if (!presentTopics.has(topic) || suppressedTopics.has(topic)) continue
      suppressedTopics.add(topic)
      logAgentMetric(TOOL_ERROR_METRICS.systemReminderSuppressedByConflict, {
        suppressingTopic: entry.topic,
        suppressedTopic: topic,
      })
    }
  }

  return suppressedTopics
}
