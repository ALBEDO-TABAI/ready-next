export type CodexProviderEventClass = 'delta' | 'structural' | 'terminal'

const EVENT_CLASSES: Readonly<Record<string, CodexProviderEventClass>> = Object.freeze({
  'response.created': 'structural',
  'response.in_progress': 'structural',
  'response.output_item.added': 'structural',
  'response.output_item.done': 'structural',
  'response.content_part.added': 'structural',
  'response.content_part.done': 'structural',
  'response.output_text.delta': 'delta',
  'response.output_text.done': 'structural',
  'response.refusal.delta': 'delta',
  'response.refusal.done': 'structural',
  'response.function_call_arguments.delta': 'delta',
  'response.function_call_arguments.done': 'structural',
  'response.reasoning_summary_part.added': 'structural',
  'response.reasoning_summary_part.done': 'structural',
  'response.reasoning_summary_text.delta': 'delta',
  'response.reasoning_summary_text.done': 'structural',
  'response.completed': 'terminal',
  'response.incomplete': 'terminal',
  'response.failed': 'terminal',
  error: 'terminal',
})

export const CODEX_PROVIDER_RESPONSE_EVENT_TYPES = Object.freeze(Object.keys(EVENT_CLASSES))

export class CodexProviderStreamPolicyError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexProviderStreamPolicyError'
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function itemIdentity(payload: Readonly<Record<string, unknown>>): string | null {
  if (typeof payload.item_id === 'string' && payload.item_id.trim()) return payload.item_id
  return record(payload.item) && typeof payload.item.id === 'string' && payload.item.id.trim()
    ? payload.item.id
    : null
}

function initialHeldBytes(item: unknown): number {
  if (!record(item)) return 0
  if (typeof item.arguments === 'string') return utf8Bytes(item.arguments)
  const parts = Array.isArray(item.content)
    ? item.content
    : Array.isArray(item.summary) ? item.summary : []
  return parts.reduce((total, part) => {
    if (!record(part)) return total
    const value = typeof part.text === 'string'
      ? part.text
      : typeof part.refusal === 'string' ? part.refusal : ''
    return total + utf8Bytes(value)
  }, 0)
}

export function classifyCodexProviderResponseEvent(eventType: string): CodexProviderEventClass {
  const classification = EVENT_CLASSES[eventType]
  if (!classification) throw new CodexProviderStreamPolicyError('gateway_response_event_not_allowed')
  return classification
}

/**
 * Pure policy for Provider response.* SSE. It deliberately knows nothing about
 * app-server thread/turn/item notifications; those remain CodexTurnCollector state.
 */
export class CodexProviderStreamPolicy {
  private wireBytes = 0
  private structuralEvents = 0
  private readonly itemHeldBytes = new Map<string, number>()
  private responseId: string | null = null
  private lastProgressAt: number
  private terminalAt: number | null = null

  constructor(private readonly limits: Readonly<{
    maxWireBytes: number
    maxStructuralEvents: number
    maxItemHeldBytes: number
    eventIdleMs: number
  }>, startedAt = Date.now()) {
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new CodexProviderStreamPolicyError('gateway_configuration_invalid')
    }
    this.lastProgressAt = startedAt
  }

  recordWireBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new CodexProviderStreamPolicyError('gateway_native_wire_bytes_invalid')
    }
    this.wireBytes += bytes
    if (this.wireBytes > this.limits.maxWireBytes) {
      throw new CodexProviderStreamPolicyError('gateway_native_stream_too_large')
    }
  }

  acceptValidatedEvent(payload: Readonly<Record<string, unknown>>, at = Date.now()): void {
    const eventType = String(payload.type || '')
    const classification = classifyCodexProviderResponseEvent(eventType)
    if (this.terminalAt !== null) {
      throw new CodexProviderStreamPolicyError('gateway_native_event_after_terminal')
    }
    const payloadResponseId = record(payload.response) && typeof payload.response.id === 'string'
      ? payload.response.id
      : null
    if (eventType === 'response.created') {
      if (!payloadResponseId || this.responseId) {
        throw new CodexProviderStreamPolicyError('gateway_response_created_invalid')
      }
      this.responseId = payloadResponseId
    } else if (payloadResponseId && this.responseId && payloadResponseId !== this.responseId) {
      throw new CodexProviderStreamPolicyError('gateway_response_identity_changed')
    }
    if (classification === 'structural') {
      this.structuralEvents += 1
      if (this.structuralEvents > this.limits.maxStructuralEvents) {
        throw new CodexProviderStreamPolicyError('gateway_native_event_limit_exceeded')
      }
    }
    const itemId = itemIdentity(payload)
    if (eventType.includes('output_item.') && !itemId) {
      throw new CodexProviderStreamPolicyError('gateway_response_item_id_missing')
    }
    if (itemId) {
      const addedBytes = eventType === 'response.output_item.added'
        ? initialHeldBytes(payload.item)
        : classification === 'delta' && typeof payload.delta === 'string'
          ? utf8Bytes(payload.delta)
          : eventType.endsWith('_part.added') && record(payload.part)
            ? utf8Bytes(String(payload.part.text ?? payload.part.refusal ?? ''))
            : 0
      const heldBytes = (this.itemHeldBytes.get(itemId) || 0) + addedBytes
      if (heldBytes > this.limits.maxItemHeldBytes) {
        throw new CodexProviderStreamPolicyError('gateway_native_item_too_large')
      }
      this.itemHeldBytes.set(itemId, heldBytes)
    }
    this.lastProgressAt = at
    if (classification === 'terminal') this.terminalAt = at
  }

  remainingWaitMs(at = Date.now()): number {
    return this.lastProgressAt + this.limits.eventIdleMs - at
  }

  timeoutCode(): string {
    return 'gateway_native_event_idle_timeout'
  }

  snapshot(): Readonly<{
    wireBytes: number
    structuralEvents: number
    terminal: boolean
    itemHeldBytes: Readonly<Record<string, number>>
  }> {
    return Object.freeze({
      wireBytes: this.wireBytes,
      structuralEvents: this.structuralEvents,
      terminal: this.terminalAt !== null,
      itemHeldBytes: Object.freeze(Object.fromEntries(this.itemHeldBytes)),
    })
  }
}
