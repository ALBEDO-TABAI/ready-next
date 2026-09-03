import type { CodexBindingRepository } from './codex-binding-repository'
import type { CodexStartDeliveryEvidenceResolver } from './codex-durable-start-dispatch'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import type { CodexNativeRuntime } from './codex-native-runtime'

type ReadbackRuntime = Pick<CodexNativeRuntime, 'threadList' | 'threadRead'>

type Readback =
  | { kind: 'zero'; evidenceDigest: string }
  | { kind: 'nonzero_or_ambiguous'; evidenceDigest: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTypedRpcRejection(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Number.isSafeInteger(value.code)
    && typeof value.message === 'string'
    && value.message.trim().length > 0
}

export class CodexLiveStartRejectionResolver implements CodexStartDeliveryEvidenceResolver {
  constructor(private readonly deps: {
    runtime: ReadbackRuntime
    repository: Pick<CodexBindingRepository, 'readStartInboundIdentity'>
    threadListLimit: number
    stableZeroReadCount: number
    waitBetweenZeroReads: () => Promise<void>
    isConnectionLive: (connectionEpoch: string) => boolean
  }) {
    if (!Number.isSafeInteger(deps.threadListLimit) || deps.threadListLimit <= 0) {
      throw new Error('codex_rejection_thread_list_limit_invalid')
    }
    if (!Number.isSafeInteger(deps.stableZeroReadCount) || deps.stableZeroReadCount < 2) {
      throw new Error('codex_rejection_stable_zero_read_count_invalid')
    }
  }

  async resolveTypedRejection(input: Parameters<CodexStartDeliveryEvidenceResolver['resolveTypedRejection']>[0]) {
    if (!isTypedRpcRejection(input.rpcError) || !this.deps.isConnectionLive(input.connectionEpoch)) {
      return { resolution: 'unknown' as const }
    }
    const zeroDigests: string[] = []
    for (let index = 0; index < this.deps.stableZeroReadCount; index += 1) {
      if (!this.deps.isConnectionLive(input.connectionEpoch)) {
        return { resolution: 'unknown' as const }
      }
      const readback = await this.readStart(input.method, input.bindingId)
      if (readback.kind !== 'zero') return { resolution: 'unknown' as const }
      zeroDigests.push(readback.evidenceDigest)
      if (index + 1 < this.deps.stableZeroReadCount) {
        await this.deps.waitBetweenZeroReads()
      }
    }
    if (!this.deps.isConnectionLive(input.connectionEpoch)) {
      return { resolution: 'unknown' as const }
    }
    return {
      resolution: 'proven_absent' as const,
      evidenceDigest: digestCanonicalJson({
        connectionEpoch: input.connectionEpoch,
        rpcId: input.rpcId,
        method: input.method,
        bindingId: input.bindingId,
        responseDigest: input.responseDigest,
        zeroDigests,
      }),
    }
  }

  private async readStart(method: 'thread/start' | 'thread/fork' | 'turn/start', bindingId: string): Promise<Readback> {
    const identity = this.deps.repository.readStartInboundIdentity(method, bindingId)
    if (identity.method !== 'turn/start') {
      const listed = await this.deps.runtime.threadList({
        limit: this.deps.threadListLimit,
        cwd: identity.expectedCwd,
        sourceKinds: ['vscode'],
      })
      const payload = { method, bindingId, expectedCwd: identity.expectedCwd, listed }
      return listed.nextCursor === null && listed.data.length === 0
        ? { kind: 'zero', evidenceDigest: digestCanonicalJson(payload) }
        : { kind: 'nonzero_or_ambiguous', evidenceDigest: digestCanonicalJson(payload) }
    }
    const read = await this.deps.runtime.threadRead({
      threadId: identity.threadId,
      includeTurns: true,
    })
    const matching = read.thread.id === identity.threadId
      ? read.thread.turns.filter((turn) => turn.items.some((item) => (
          item.type === 'userMessage' && item.clientId === identity.clientUserMessageId
        )))
      : []
    const payload = {
      method,
      bindingId,
      threadId: identity.threadId,
      clientUserMessageId: identity.clientUserMessageId,
      read,
    }
    return read.thread.id === identity.threadId && matching.length === 0
      ? { kind: 'zero', evidenceDigest: digestCanonicalJson(payload) }
      : { kind: 'nonzero_or_ambiguous', evidenceDigest: digestCanonicalJson(payload) }
  }
}
