import { CHATGPT_OAUTH_BASE_URL, CHATGPT_OAUTH_PROFILE_ID } from '../../../../shared/chatgpt-oauth'
import { CodexModelGatewayError } from './codex-model-gateway-common'
import type { CodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'

export function isCodexUpstreamEventStream(
  response: Pick<Response, 'headers'>,
  snapshot: Pick<CodexUpstreamProfileSnapshot, 'profileId' | 'baseUrl' | 'wireApi'>,
): boolean {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/event-stream')) return true
  return isChatGptOAuthResponsesSnapshot(snapshot)
    && contentType.includes('application/json')
}

export function isChatGptOAuthResponsesSnapshot(
  snapshot: Pick<CodexUpstreamProfileSnapshot, 'profileId' | 'baseUrl' | 'wireApi'>,
): boolean {
  return snapshot.profileId === CHATGPT_OAUTH_PROFILE_ID
    && snapshot.baseUrl === CHATGPT_OAUTH_BASE_URL
    && snapshot.wireApi === 'responses'
}

export const DEFAULT_NATIVE_MAX_BYTES = 8 * 1024 * 1024

export const DEFAULT_NATIVE_MAX_EVENTS = 4_096

export const DEFAULT_NATIVE_MAX_ITEM_BYTES = 4 * 1024 * 1024

export const DEFAULT_BODY_DEADLINE_MS = 10_000

export const DEFAULT_HEADERS_DEADLINE_MS = 120_000

export const DEFAULT_FIRST_BYTE_DEADLINE_MS = 120_000

const DEFAULT_EVENT_IDLE_MS = 120_000

const CHATGPT_OAUTH_EVENT_IDLE_MS = 300_000

export function resolveCodexGatewayEventIdleMs(input: {
  snapshot: Pick<CodexUpstreamProfileSnapshot, 'profileId' | 'baseUrl' | 'wireApi'>
  overrideMs?: number
}): number {
  if (input.overrideMs !== undefined) {
    if (!Number.isSafeInteger(input.overrideMs) || input.overrideMs <= 0) {
      throw new CodexModelGatewayError('gateway_configuration_invalid')
    }
    return input.overrideMs
  }
  return isChatGptOAuthResponsesSnapshot(input.snapshot)
    ? CHATGPT_OAUTH_EVENT_IDLE_MS
    : DEFAULT_EVENT_IDLE_MS
}
