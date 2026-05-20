import { logAgentMetric } from '../metrics'
import { PROJECTION_OBSERVABILITY_METRICS } from '../projection-observability-metrics'

export const SKILL_TOOL_FALLBACK_ENTRIES = Object.freeze([
  'find_by_name',
  'find_by_skill_action',
  'execution',
  'schema_list',
  'definition_list',
  'input_schema',
  'group_definitions',
  'group_schemas',
  'action_schemas_map',
] as const)

export type SkillToolFallbackEntry = (typeof SKILL_TOOL_FALLBACK_ENTRIES)[number]
export type SkillToolFallbackReason = 'manager_throw' | 'manifest_miss'

export interface SkillToolFallbackPayload {
  entry: SkillToolFallbackEntry
  reason: SkillToolFallbackReason
  toolName?: string
  skillId?: string
  action?: string
}

export class SkillToolFallbackThrottle {
  private readonly seenAt = new Map<string, number>()

  constructor(
    private readonly throttleMs = 60_000,
    private readonly now = () => Date.now(),
  ) {}

  emit(payload: SkillToolFallbackPayload): void {
    const key = this.keyFor(payload)
    const at = this.now()
    const last = this.seenAt.get(key)
    if (typeof last === 'number' && at - last < this.throttleMs) return
    this.seenAt.set(key, at)

    const safePayload: SkillToolFallbackPayload = {
      entry: payload.entry,
      reason: payload.reason,
    }
    if (payload.toolName) safePayload.toolName = payload.toolName
    if (payload.skillId) safePayload.skillId = payload.skillId
    if (payload.action) safePayload.action = payload.action
    logAgentMetric(
      PROJECTION_OBSERVABILITY_METRICS.skillToolDynamicLookupFailed,
      safePayload as unknown as Record<string, unknown>,
    )
  }

  resetForTests(): void {
    this.seenAt.clear()
  }

  private keyFor(payload: SkillToolFallbackPayload): string {
    if (payload.entry === 'find_by_skill_action') {
      return `${payload.entry}:${payload.reason}:${payload.skillId || ''}:${payload.action || ''}`
    }
    if (payload.toolName) {
      return `${payload.entry}:${payload.reason}:${payload.toolName}`
    }
    return `${payload.entry}:${payload.reason}`
  }
}

export const fallbackThrottle = new SkillToolFallbackThrottle()
