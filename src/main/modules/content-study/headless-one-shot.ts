/**
 * Provider-agnostic one-shot LLM call used by content-study pipeline and
 * other "non-chat" backgrounds (cron skill jobs, scheduled summarisation).
 *
 * Not wired through `DirectChatEngine` because:
 *   - we don't want a chat session, transcript or tool loop
 *   - we don't want to run any of the §6.13/§6.20/§6.22 lifecycle / projection
 *     plumbing that even `requestSimpleText` brings along when called from the
 *     domain-adapter engine
 *   - we want to be callable from `src/main/modules/clipping/` and similar
 *     leaves that boot BEFORE the agent runtime
 *
 * Two protocols covered:
 *   - `anthropic`: POST `${baseUrl}/v1/messages`
 *   - `openai`   : POST `${baseUrl}/v1/chat/completions` (default)
 *
 * The 7-provider matrix (§6.26) collapses to one of these two on the wire
 * once `resolveAIConfigCapabilities` has decided `agentProtocol`. Kimi-coding
 * is treated as openai-compatible here — its chat-specific niceties (auto
 * websearch, Anthropic fallback) are NOT replicated; content-study is a
 * single-shot pipeline and does not need them.
 */

import type { AIModelConfig } from '../../../shared/ai-providers'
import { resolveAIConfigCapabilities } from '../../../shared/ai-providers'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_USER_BYTES = 200_000
const DEFAULT_MAX_TOKENS = 4096

export interface HeadlessOneShotInput {
  system: string
  user: string
  config: AIModelConfig
  signal?: AbortSignal
  timeoutMs?: number
  maxTokens?: number
}

export interface HeadlessOneShotOk {
  ok: true
  text: string
}

export type HeadlessOneShotErrorKind =
  | 'no_config'
  | 'invalid_config'
  | 'aborted'
  | 'timeout'
  | 'http_error'
  | 'network_failed'
  | 'parse_failed'
  | 'empty_response'
  | 'user_too_large'

export interface HeadlessOneShotError {
  ok: false
  errorKind: HeadlessOneShotErrorKind
  message: string
  detail?: Record<string, unknown>
}

export type HeadlessOneShotResult = HeadlessOneShotOk | HeadlessOneShotError

function makeError(errorKind: HeadlessOneShotErrorKind, message: string, detail?: Record<string, unknown>): HeadlessOneShotError {
  return { ok: false, errorKind, message, detail }
}

function normalizeBaseUrl(raw: string): string {
  return String(raw || '').trim().replace(/\/+$/, '')
}

export async function requestHeadlessOneShot(input: HeadlessOneShotInput): Promise<HeadlessOneShotResult> {
  if (!input.config) {
    return makeError('no_config', 'AI config is missing — configure a model in settings before using content-study')
  }
  const userBytes = Buffer.byteLength(input.user || '', 'utf8')
  if (userBytes > MAX_USER_BYTES) {
    return makeError('user_too_large', `user payload ${userBytes} bytes exceeds ${MAX_USER_BYTES} cap`, { userBytes })
  }
  const capabilities = resolveAIConfigCapabilities(input.config)
  if (!capabilities) {
    return makeError('invalid_config', 'AI config provider could not be resolved')
  }
  const baseUrl = normalizeBaseUrl(capabilities.baseUrl || input.config.baseUrl)
  if (!baseUrl) {
    return makeError('invalid_config', 'AI config baseUrl is empty')
  }
  const apiKey = String(input.config.apiKey || '').trim()
  if (!apiKey) {
    return makeError('invalid_config', 'AI config apiKey is empty')
  }
  const model = String(input.config.model || '').trim()
  if (!model) {
    return makeError('invalid_config', 'AI config model is empty')
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS

  const internalController = new AbortController()
  const onExternalAbort = () => internalController.abort()
  if (input.signal) {
    if (input.signal.aborted) {
      internalController.abort()
    } else {
      input.signal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  const timer = setTimeout(() => internalController.abort(), timeoutMs)

  try {
    if (capabilities.agentProtocol === 'anthropic') {
      return await callAnthropic({
        baseUrl,
        apiKey,
        model,
        system: input.system,
        user: input.user,
        signal: internalController.signal,
        maxTokens,
      })
    }
    return await callOpenAICompatible({
      baseUrl,
      apiKey,
      model,
      system: input.system,
      user: input.user,
      signal: internalController.signal,
      maxTokens,
    })
  } finally {
    clearTimeout(timer)
    if (input.signal) {
      input.signal.removeEventListener('abort', onExternalAbort)
    }
  }
}

interface ProtocolCallArgs {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  user: string
  signal: AbortSignal
  maxTokens: number
}

async function callAnthropic(args: ProtocolCallArgs): Promise<HeadlessOneShotResult> {
  const url = `${args.baseUrl}/v1/messages`
  const body = {
    model: args.model,
    system: args.system,
    max_tokens: args.maxTokens,
    messages: [{ role: 'user', content: args.user }],
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': args.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: args.signal,
    })
  } catch (err) {
    return classifyFetchError(err)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return makeError('http_error', `anthropic ${response.status} ${response.statusText}`, {
      status: response.status,
      body: detail.slice(0, 1000),
    })
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (err) {
    return makeError('parse_failed', `failed to parse anthropic response: ${(err as Error).message}`)
  }
  const text = extractAnthropicText(json)
  if (!text) {
    return makeError('empty_response', 'anthropic response had no text content', { json })
  }
  return { ok: true, text }
}

async function callOpenAICompatible(args: ProtocolCallArgs): Promise<HeadlessOneShotResult> {
  const url = `${args.baseUrl}/v1/chat/completions`
  const body = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    })
  } catch (err) {
    return classifyFetchError(err)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return makeError('http_error', `openai ${response.status} ${response.statusText}`, {
      status: response.status,
      body: detail.slice(0, 1000),
    })
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (err) {
    return makeError('parse_failed', `failed to parse openai response: ${(err as Error).message}`)
  }
  const text = extractOpenAIText(json)
  if (!text) {
    return makeError('empty_response', 'openai response had no text content', { json })
  }
  return { ok: true, text }
}

function classifyFetchError(err: unknown): HeadlessOneShotError {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && err.name === 'AbortError') {
    // Caller can disambiguate timeout vs user-abort by checking timer state;
    // for the renderer-facing UI both surface as "已取消".
    return makeError('aborted', 'request aborted (user cancel or timeout)')
  }
  return makeError('network_failed', `network error: ${message}`)
}

function extractAnthropicText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const content = (json as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('').trim()
}

function extractOpenAIText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as { message?: { content?: unknown } } | undefined
  const content = first?.message?.content
  if (typeof content !== 'string') return ''
  return content.trim()
}
