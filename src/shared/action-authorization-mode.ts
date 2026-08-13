export const ACTION_AUTHORIZATION_MODES = ['ask', 'auto', 'full'] as const

export type ActionAuthorizationMode = typeof ACTION_AUTHORIZATION_MODES[number]

export const DEFAULT_ACTION_AUTHORIZATION_MODE: ActionAuthorizationMode = 'ask'

export function parseActionAuthorizationMode(value: unknown): ActionAuthorizationMode {
  return typeof value === 'string'
    && (ACTION_AUTHORIZATION_MODES as readonly string[]).includes(value)
    ? value as ActionAuthorizationMode
    : DEFAULT_ACTION_AUTHORIZATION_MODE
}

export function readActionAuthorizationModeFromEnvelope(value: unknown): ActionAuthorizationMode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_ACTION_AUTHORIZATION_MODE
  }
  return parseActionAuthorizationMode(
    (value as { actionAuthorizationMode?: unknown }).actionAuthorizationMode,
  )
}
