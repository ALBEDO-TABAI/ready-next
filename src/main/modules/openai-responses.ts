interface JsonResponseParseOptions {
  requestUrl?: string
}

export async function parseJsonResponse(
  response: Response,
  options: JsonResponseParseOptions = {},
): Promise<unknown> {
  const raw = await response.text()
  return parseJsonText(raw, options)
}

export async function parseJsonOrEventStreamResponse(
  response: Response,
  options: JsonResponseParseOptions = {},
): Promise<unknown> {
  const raw = await response.text()
  return parseJsonOrEventStreamText(raw, options)
}

export function parseJsonText(raw: string, options: JsonResponseParseOptions = {}): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  try {
    return JSON.parse(trimmed)
  } catch {
    throw buildJsonParseError(trimmed, options.requestUrl)
  }
}

export function parseJsonOrEventStreamText(
  raw: string,
  options: JsonResponseParseOptions = {},
): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  try {
    return JSON.parse(trimmed)
  } catch {
    const ssePayload = parseEventStreamPayload(trimmed)
    if (typeof ssePayload !== 'undefined') return ssePayload
    throw buildJsonParseError(trimmed, options.requestUrl)
  }
}

function buildJsonParseError(raw: string, requestUrl?: string): Error {
  const snippet = raw.slice(0, 120)
  if (looksLikeHtml(raw)) {
    const v1Hint = shouldSuggestV1(requestUrl)
      ? ' 如果这是 OpenAI 兼容服务，API 地址通常要写成带 /v1 的形式。'
      : ''
    return new Error(`API 返回了网页内容，不是 JSON。请检查 API 地址是否填成了官网页或登录页。${v1Hint}`)
  }
  return new Error(`API 返回了无法解析的内容: ${snippet}`)
}

function looksLikeHtml(raw: string): boolean {
  const normalized = raw.trimStart().slice(0, 64).toLowerCase()
  return normalized.startsWith('<!doctype html')
    || normalized.startsWith('<html')
    || normalized.startsWith('<head')
    || normalized.startsWith('<body')
}

function shouldSuggestV1(requestUrl?: string): boolean {
  if (!requestUrl) return false
  try {
    const url = new URL(requestUrl)
    const segments = url.pathname.split('/').filter(Boolean)
    return segments.length > 0 && segments[0] !== 'v1'
  } catch {
    return false
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
