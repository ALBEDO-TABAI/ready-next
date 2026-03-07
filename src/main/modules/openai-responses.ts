export async function parseJsonOrEventStreamResponse(response: Response): Promise<unknown> {
  const raw = await response.text()
  return parseJsonOrEventStreamText(raw)
}

export function parseJsonOrEventStreamText(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  try {
    return JSON.parse(trimmed)
  } catch {
    const ssePayload = parseEventStreamPayload(trimmed)
    if (typeof ssePayload !== 'undefined') return ssePayload
    throw new Error(`Unable to parse response body: ${trimmed.slice(0, 120)}`)
  }
}

function parseEventStreamPayload(raw: string): unknown {
  let lastPayload: unknown
  const blocks = raw.split(/\r?\n\r?\n/)

  for (const block of blocks) {
    if (!block.trim()) continue

    let eventName = ''
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    const data = dataLines.join('\n').trim()
    if (!data || data === '[DONE]') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }

    if (!parsed || typeof parsed !== 'object') {
      lastPayload = parsed
      continue
    }

    const record = parsed as Record<string, unknown>
    const candidate = record.response && typeof record.response === 'object'
      ? record.response
      : record

    if (eventName === 'response.completed' || record.type === 'response.completed') {
      return candidate
    }

    lastPayload = candidate
  }

  return lastPayload
}
