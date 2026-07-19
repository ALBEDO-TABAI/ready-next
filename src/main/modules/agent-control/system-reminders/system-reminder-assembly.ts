import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import type { ReminderEntry, ReminderTopic } from './system-reminder-registry'

const DEFAULT_CONFLICTS: Record<ReminderTopic, ReadonlyArray<ReminderTopic>> = {
  'action-announcement-steer': [],
  checkpoint: [],
  'child-owned': ['typed-action-preferred', 'force-tool-locked', 'force-tool-missing'],
  'force-tool-locked': ['typed-action-preferred'],
  'force-tool-missing': ['typed-action-preferred', 'force-tool-locked'],
  budget: [],
  'missing-input': [],
  'provider-tool-arguments-corrupt': [],
  'typed-action-preferred': [],
  // Stage 4 W2 — no implicit conflicts. The skill-resume reminder is a
  // synthetic skill-detection input the rest of the turn consumes, and the
  // force-tool checkpoint is a per-iteration mid-loop guard. They don't
  // suppress or conflict with the other topics.
  'skill-resume-context-prompt': [],
  'force-tool-checkpoint-blocked': [],
  // Stage N — see system-reminder-registry.ts; no conflicts. Fires only
  // when the manifest fence early-breaks the force-tool synthesis path,
  // disjoint from `force-tool-checkpoint-blocked` (post-preflight checkpoint).
  'force-tool-blocked-child-owned': [],
  // Stage R W1.3 — daily date prompt; no conflicts.
  'current-date': [],
  // S2-2 — background task terminal summaries; no conflicts.
  'background-task-terminal': [],
  // D2 — 验收标准事中自检（每 run 首次模型调用注入一次）；no conflicts.
  'criteria-self-check': [],
  // P2-1 — L1 技能目录；纯清单，no conflicts。
  'skill-catalog': [],
  // P3-2 — 脚本执行同意缺失提醒；selected 轮独立文案，no conflicts。
  'skill-shell-consent': [],
  'tool-capability-conflict': [],
  'browser-observation-required': [],
  'browser-research-incomplete': [],
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
