import type {
  ReadyMemoryGenerationProvider,
  ReadyMemoryProviderRecovery,
  ReadyMemoryProviderRequest,
  ReadyMemoryProviderSubmission,
  ReadyMemoryProviderUsage,
} from './ready-memory-generation-types'
import type {
  CodexModelGatewayRepository,
  ReadySettingsModelGatewayCredentialStore,
} from '../codex-runtime/codex-model-gateway-authority'
import { upstreamEndpoint, type CodexUpstreamProfileSnapshot } from '../codex-runtime/codex-model-gateway-contract'

type Fetch = typeof globalThis.fetch

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function usage(
  value: unknown,
  wireApi: CodexUpstreamProfileSnapshot['wireApi'],
): ReadyMemoryProviderUsage | undefined {
  const row = object(value)
  if (!row) return undefined
  const inputTokens = integer(wireApi === 'responses' ? row.input_tokens : row.prompt_tokens)
  const outputTokens = integer(wireApi === 'responses' ? row.output_tokens : row.completion_tokens)
  const total = integer(row.total_tokens)
  if (inputTokens === null || outputTokens === null) return undefined
  return { inputTokens, outputTokens, totalTokens: total ?? inputTokens + outputTokens }
}

function outputText(value: Record<string, unknown>, wireApi: CodexUpstreamProfileSnapshot['wireApi']): string {
  if (wireApi === 'chat/completions') {
    const choice = Array.isArray(value.choices) ? object(value.choices[0]) : null
    const message = object(choice?.message)
    if (typeof message?.content === 'string') return message.content
    if (Array.isArray(message?.content)) {
      return message.content.map((part) => object(part)?.text).filter((part): part is string => typeof part === 'string').join('')
    }
    throw new Error('ready_memory_provider_output_missing')
  }
  if (typeof value.output_text === 'string') return value.output_text
  if (!Array.isArray(value.output)) throw new Error('ready_memory_provider_output_missing')
  const text = value.output.flatMap((item) => {
    const message = object(item)
    return Array.isArray(message?.content) ? message.content : []
  }).map((part) => {
    const content = object(part)
    return content?.type === 'output_text' && typeof content.text === 'string' ? content.text : ''
  }).join('')
  if (!text) throw new Error('ready_memory_provider_output_missing')
  return text
}

function providerError(response: Response, body: unknown): string {
  const payload = object(body)
  const nested = object(payload?.error)
  const message = typeof nested?.message === 'string'
    ? nested.message
    : typeof payload?.message === 'string' ? payload.message : `http_${response.status}`
  return `ready_memory_provider_${response.status}:${message.slice(0, 500)}`
}

export class ReadyMemoryProductionProvider implements ReadyMemoryGenerationProvider {
  readonly automaticGenerationAvailable = false

  constructor(private readonly dependencies: {
    profiles: Pick<CodexModelGatewayRepository, 'readSnapshot'>
    credentials: Pick<ReadySettingsModelGatewayCredentialStore, 'resolve'>
    fetch?: Fetch
    timeoutMs?: number
  }) {}

  async submit(request: ReadyMemoryProviderRequest): Promise<ReadyMemoryProviderSubmission> {
    this.resolveSnapshot(request)
    return { state: 'failed', error: 'ready_memory_provider_submission_recovery_unproven' }
  }

  async recover(
    request: ReadyMemoryProviderRequest,
    remoteId: string | null,
  ): Promise<ReadyMemoryProviderRecovery> {
    const snapshot = this.resolveSnapshot(request)
    if (snapshot.wireApi !== 'responses' || !remoteId) {
      return { state: 'unknown', remoteId: remoteId || undefined }
    }
    const credential = this.resolveCredential(snapshot)
    let response: Response
    try {
      response = await this.request(`${upstreamEndpoint(snapshot)}/${encodeURIComponent(remoteId)}`,
        snapshot, credential, { method: 'GET' })
    } catch {
      return { state: 'unknown', remoteId }
    }
    if (response.status === 404) return { state: 'not_found', remoteId }
    let body: unknown
    try { body = await response.json() as unknown } catch { return { state: 'unknown', remoteId } }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        return { state: 'unknown', remoteId }
      }
      return { state: 'failed', remoteId, error: providerError(response, body) }
    }
    const payload = object(body)
    if (!payload) return { state: 'unknown', remoteId }
    const status = typeof payload.status === 'string' ? payload.status : ''
    if (['queued', 'in_progress'].includes(status)) return { state: 'pending', remoteId }
    if (['failed', 'cancelled', 'incomplete'].includes(status)) {
      let partialOutput: string | undefined
      try { partialOutput = outputText(payload, snapshot.wireApi) } catch { /* digest unavailable */ }
      return {
        state: 'failed', remoteId, error: `ready_memory_provider_${status}`,
        outputText: partialOutput, usage: usage(payload.usage, snapshot.wireApi),
      }
    }
    try {
      const completedOutput = outputText(payload, snapshot.wireApi)
      const completedUsage = usage(payload.usage, snapshot.wireApi)
      if (!completedUsage) {
        return {
          state: 'failed', remoteId, error: 'ready_memory_provider_usage_missing',
          outputText: completedOutput,
        }
      }
      return {
        state: 'completed',
        remoteId,
        outputText: completedOutput,
        usage: completedUsage,
      }
    } catch {
      return { state: 'failed', remoteId, error: 'ready_memory_provider_output_invalid' }
    }
  }

  private resolveSnapshot(request: ReadyMemoryProviderRequest): CodexUpstreamProfileSnapshot {
    const snapshot = this.dependencies.profiles.readSnapshot(
      request.upstreamProfileSnapshotRef,
      request.upstreamProfileSnapshotDigest,
    )
    if (snapshot.model !== request.model || snapshot.agentProtocol !== 'openai') {
      throw new Error('ready_memory_provider_profile_mismatch')
    }
    return snapshot
  }

  private resolveCredential(snapshot: CodexUpstreamProfileSnapshot): string {
    return this.dependencies.credentials.resolve({
      credentialReferenceId: snapshot.credentialReferenceId,
      snapshot,
    })
  }

  private request(
    url: string,
    snapshot: CodexUpstreamProfileSnapshot,
    credential: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    return (this.dependencies.fetch || globalThis.fetch)(url, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(this.dependencies.timeoutMs || 60_000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...snapshot.extraHeaders,
        [snapshot.authHeader]: `${snapshot.authPrefix}${credential}`,
      },
    })
  }
}
