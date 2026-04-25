interface OpenAIHistoryMessage {
  role?: unknown
  content?: unknown
  tool_call_id?: unknown
  tool_calls?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function containsAnthropicToolBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => {
    if (!isRecord(block)) return false
    return block.type === 'tool_use' || block.type === 'tool_result'
  })
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function sanitizeAnthropicToolContent(content: unknown): unknown {
  if (!Array.isArray(content) || !containsAnthropicToolBlock(content)) return content

  const textParts: string[] = []
  const passthroughParts: Record<string, unknown>[] = []

  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'tool_use') continue
    if (block.type === 'tool_result') {
      const toolResultText = stringifyToolResultContent(block.content)
      if (toolResultText) textParts.push(toolResultText)
      continue
    }
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim()) textParts.push(block.text)
      continue
    }
    passthroughParts.push(block)
  }

  if (passthroughParts.length > 0) {
    return [
      ...(textParts.length > 0 ? [{ type: 'text', text: textParts.join('\n\n') }] : []),
      ...passthroughParts,
    ]
  }
  return textParts.join('\n\n')
}

export interface SanitizeOpenAIHistoryOptions {
  /**
   * Phase 4 cleanup: when provided, assistant `tool_calls[]` entries whose
   * `function.name` is not in this set get dropped, along with the matching
   * `role: 'tool'` follow-up identified by `tool_call_id`. Lets the sanitizer
   * scrub recalled sessions that still reference retired tools (e.g.
   * `skill_submit_input`) without leaking phantom tool entries to the model.
   * Pass `null`/`undefined` to skip this pass.
   */
  validToolNames?: Set<string> | null
}

function getToolCallFunctionName(toolCall: Record<string, unknown>): string | null {
  const fn = toolCall.function && typeof toolCall.function === 'object'
    ? toolCall.function as { name?: unknown }
    : null
  return typeof fn?.name === 'string' ? fn.name : null
}

export function sanitizeOpenAICompatibleMessageHistory(
  messages: OpenAIHistoryMessage[],
  options?: SanitizeOpenAIHistoryOptions,
): Array<Record<string, unknown>> {
  const rawMessages: Array<Record<string, unknown>> = messages.map((message) => {
    const raw = message as unknown as Record<string, unknown>
    return {
      ...raw,
      content: sanitizeAnthropicToolContent(message.content),
    }
  })

  // Pass 1 — collect orphaned tool_call ids (assistant said it called a tool
  // but no matching `role: 'tool'` reply ever arrived).
  const openToolCallIds = new Set<string>()
  for (const message of rawMessages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls as Array<Record<string, unknown>>) {
        if (typeof toolCall.id === 'string') {
          openToolCallIds.add(toolCall.id)
        }
      }
      continue
    }
    if (message.role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : null
      if (toolCallId) {
        openToolCallIds.delete(toolCallId)
      }
    }
  }

  // Pass 2 — collect tool_call ids referencing retired/unknown tool names so
  // we can drop both sides of the pair. Only runs when the caller supplies a
  // current registered tool list; tests pass a custom set, prod callers
  // resolve it via `getRegisteredToolNames()` from the tool registry.
  const retiredToolCallIds = new Set<string>()
  if (options?.validToolNames && options.validToolNames.size > 0) {
    for (const message of rawMessages) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
      for (const toolCall of message.tool_calls as Array<Record<string, unknown>>) {
        const name = getToolCallFunctionName(toolCall)
        const id = typeof toolCall.id === 'string' ? toolCall.id : null
        if (!name) continue
        if (!options.validToolNames.has(name) && id) {
          retiredToolCallIds.add(id)
        }
      }
    }
  }

  if (openToolCallIds.size === 0 && retiredToolCallIds.size === 0) return rawMessages

  return rawMessages.reduce<Array<Record<string, unknown>>>((acc, message) => {
    // Drop the matching `role: 'tool'` follow-up for any retired tool_call id.
    if (message.role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : null
      if (toolCallId && retiredToolCallIds.has(toolCallId)) return acc
      acc.push(message)
      return acc
    }

    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      acc.push(message)
      return acc
    }

    // Scrub the assistant's tool_calls[] in-place: drop entries whose id is
    // either orphaned (Pass 1) or names a retired tool (Pass 2).
    const filteredToolCalls = (message.tool_calls as Array<Record<string, unknown>>).filter((toolCall) => {
      const id = typeof toolCall.id === 'string' ? toolCall.id : null
      if (id && openToolCallIds.has(id)) return false
      if (id && retiredToolCallIds.has(id)) return false
      return true
    })

    // Phase 4: if the assistant message was nothing but retired tool_calls,
    // it now has no surviving payload — drop the whole message rather than
    // leaving an empty `tool_calls: []` shell that some providers reject.
    const hasContent = typeof message.content === 'string'
      ? message.content.trim().length > 0
      : Array.isArray(message.content) ? message.content.length > 0 : Boolean(message.content)
    if (filteredToolCalls.length === 0 && !hasContent) return acc

    if (filteredToolCalls.length === (message.tool_calls as unknown[]).length) {
      acc.push(message)
      return acc
    }
    acc.push({
      ...message,
      tool_calls: filteredToolCalls,
    })
    return acc
  }, [])
}
