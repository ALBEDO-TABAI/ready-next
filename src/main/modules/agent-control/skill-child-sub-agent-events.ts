export interface SkillChildActionStartedPayload {
  readonly kind: 'action_started'
  readonly actionName: string
  readonly actionInput: Record<string, unknown>
  /** 1-indexed action counter inside the child subagent lifecycle. */
  readonly actionIndex: number
}

export interface SkillChildActionCompletedPayload {
  readonly kind: 'action_completed'
  readonly actionName: string
  readonly success: boolean
  readonly durationMs: number
}

export interface SkillChildStateObservedPayload {
  readonly kind: 'state_observed'
  readonly stage: string | null
  readonly fingerprint: string | null
}

export type SkillChildProgressPayload =
  | SkillChildActionStartedPayload
  | SkillChildActionCompletedPayload
  | SkillChildStateObservedPayload

export function isSkillChildProgressPayload(value: unknown): value is SkillChildProgressPayload {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'action_started' || kind === 'action_completed' || kind === 'state_observed'
}
