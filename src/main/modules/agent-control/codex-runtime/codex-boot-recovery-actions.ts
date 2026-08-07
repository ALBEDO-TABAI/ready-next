import { createHash } from 'node:crypto'

import type {
  CodexBindingRecoveryMember,
  CodexBindingRepository,
  CodexHostFailureRecovery,
  CodexManualCompactionRecovery,
  CodexProductFenceRecovery,
} from './codex-binding-repository'
import type { CodexNativeRuntime, CodexThread, CodexTurn } from './codex-native-runtime'
import type {
  CodexBootRecoveryActions,
  CodexRecoveredStartResolution,
} from './codex-runtime-boot-reconciler'
import type { CodexStartIdentityRegistry } from './codex-start-identity-registry'

type ReadbackRuntime = Pick<CodexNativeRuntime, 'threadList' | 'threadRead'>

type ReadbackResult =
  | { kind: 'accepted'; nativeId: string; nativeResult: unknown; evidenceDigest: string }
  | { kind: 'zero'; evidenceDigest: string }
  | { kind: 'ambiguous'; evidenceDigest: string }

export interface CodexRecoveredHeldStartDispatcher {
  dispatch(input: {
    member: CodexBindingRecoveryMember
    registry: CodexStartIdentityRegistry
  }): Promise<'accepted' | 'pending' | 'blocked'>
}

export interface CodexStableStartAbsenceProof {
  prove(input: {
    member: CodexBindingRecoveryMember
    stableReadbackEvidenceDigest: string
  }): Promise<{ proven: false } | { proven: true; evidenceDigest: string }>
}

export interface CodexHostFailureTerminalPort {
  commit(input: CodexHostFailureRecovery): Promise<{ productTerminalDigest: string }>
}

export interface CodexManualCompactionBootPort {
  reconcile(input: CodexManualCompactionRecovery): Promise<void>
}

export interface CodexProductFenceBootPort {
  reconcile(input: CodexProductFenceRecovery): Promise<void>
}

function evidence(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function exactRootThread(thread: CodexThread, cwd: string, source: string): boolean {
  return thread.cwd === cwd
    && thread.source === source
    && thread.sessionId === thread.id
    && thread.parentThreadId === null
    && thread.forkedFromId === null
    && thread.threadSource === null
    && thread.modelProvider === 'ready_gateway'
}

function turnsWithClientIdentity(thread: CodexThread, clientUserMessageId: string): CodexTurn[] {
  return thread.turns.filter((turn) => turn.items.some((item) => (
    item.type === 'userMessage' && item.clientId === clientUserMessageId
  )))
}

export class CodexDefaultBootRecoveryActions implements CodexBootRecoveryActions {
  constructor(private readonly deps: {
    runtime: ReadbackRuntime
    repository: Pick<CodexBindingRepository, 'readStartInboundIdentity'>
    pinnedThreadSource: string
    threadListLimit: number
    stableZeroReadCount: number
    waitBetweenZeroReads: () => Promise<void>
    heldStartDispatcher: CodexRecoveredHeldStartDispatcher
    absenceProof: CodexStableStartAbsenceProof
    hostFailureTerminal: CodexHostFailureTerminalPort
    manualCompaction: CodexManualCompactionBootPort
    productFence: CodexProductFenceBootPort
  }) {
    if (!Number.isSafeInteger(deps.threadListLimit) || deps.threadListLimit <= 0) {
      throw new Error('codex_boot_thread_list_limit_invalid')
    }
    if (!Number.isSafeInteger(deps.stableZeroReadCount) || deps.stableZeroReadCount < 2) {
      throw new Error('codex_boot_stable_zero_read_count_invalid')
    }
  }

  dispatchHeldStart(input: {
    member: CodexBindingRecoveryMember
    registry: CodexStartIdentityRegistry
  }): Promise<'accepted' | 'pending' | 'blocked'> {
    return this.deps.heldStartDispatcher.dispatch(input)
  }

  async resolveIntentStart(input: {
    member: CodexBindingRecoveryMember
    registry: CodexStartIdentityRegistry
  }): Promise<CodexRecoveredStartResolution> {
    const zeroDigests: string[] = []
    for (let readIndex = 0; readIndex < this.deps.stableZeroReadCount; readIndex += 1) {
      const readback = await this.readStart(input.member)
      if (readback.kind === 'accepted') {
        return {
          resolution: 'accepted',
          nativeId: readback.nativeId,
          nativeResult: readback.nativeResult,
          evidenceDigest: readback.evidenceDigest,
        }
      }
      if (readback.kind === 'ambiguous') {
        return { resolution: 'unknown', evidenceDigest: readback.evidenceDigest }
      }
      zeroDigests.push(readback.evidenceDigest)
      if (readIndex + 1 < this.deps.stableZeroReadCount) {
        await this.deps.waitBetweenZeroReads()
      }
    }
    const stableReadbackEvidenceDigest = evidence({
      method: input.member.method,
      bindingId: input.member.bindingId,
      zeroDigests,
    })
    const absence = await this.deps.absenceProof.prove({
      member: input.member,
      stableReadbackEvidenceDigest,
    })
    return absence.proven
      ? { resolution: 'proven_absent', evidenceDigest: absence.evidenceDigest }
      : { resolution: 'unknown', evidenceDigest: stableReadbackEvidenceDigest }
  }

  commitHostFailureProductTerminal(input: {
    failure: CodexHostFailureRecovery
  }): Promise<{ productTerminalDigest: string }> {
    return this.deps.hostFailureTerminal.commit(input.failure)
  }

  reconcileManualCompaction(input: CodexManualCompactionRecovery): Promise<void> {
    return this.deps.manualCompaction.reconcile(input)
  }

  reconcileProductFence(input: CodexProductFenceRecovery): Promise<void> {
    return this.deps.productFence.reconcile(input)
  }

  private async readStart(member: CodexBindingRecoveryMember): Promise<ReadbackResult> {
    const identity = this.deps.repository.readStartInboundIdentity(member.method, member.bindingId)
    if (identity.method === 'thread/start') return this.readThread(identity.expectedCwd)
    return this.readTurn(identity.threadId, identity.clientUserMessageId)
  }

  private async readThread(expectedCwd: string): Promise<ReadbackResult> {
    const listed = await this.deps.runtime.threadList({
      limit: this.deps.threadListLimit,
      cwd: expectedCwd,
      sourceKinds: ['vscode'],
    })
    if (listed.nextCursor !== null) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ expectedCwd, listed }) }
    }
    const candidates = listed.data.filter((thread) => (
      exactRootThread(thread, expectedCwd, this.deps.pinnedThreadSource)
    ))
    if (candidates.length === 0) {
      return { kind: 'zero', evidenceDigest: evidence({ expectedCwd, listed }) }
    }
    if (candidates.length !== 1) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ expectedCwd, candidates }) }
    }
    const read = await this.deps.runtime.threadRead({ threadId: candidates[0].id, includeTurns: true })
    if (!exactRootThread(read.thread, expectedCwd, this.deps.pinnedThreadSource)) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ expectedCwd, read }) }
    }
    return {
      kind: 'accepted',
      nativeId: read.thread.id,
      nativeResult: { thread: read.thread, instructionSources: [] },
      evidenceDigest: evidence({ expectedCwd, thread: read.thread }),
    }
  }

  private async readTurn(threadId: string, clientUserMessageId: string): Promise<ReadbackResult> {
    const read = await this.deps.runtime.threadRead({ threadId, includeTurns: true })
    if (read.thread.id !== threadId) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ threadId, read }) }
    }
    const candidates = turnsWithClientIdentity(read.thread, clientUserMessageId)
    if (candidates.length === 0) {
      return {
        kind: 'zero',
        evidenceDigest: evidence({ threadId, clientUserMessageId, thread: read.thread }),
      }
    }
    if (candidates.length !== 1) {
      return {
        kind: 'ambiguous',
        evidenceDigest: evidence({ threadId, clientUserMessageId, candidates }),
      }
    }
    return {
      kind: 'accepted',
      nativeId: candidates[0].id,
      nativeResult: { turn: candidates[0] },
      evidenceDigest: evidence({ threadId, clientUserMessageId, turn: candidates[0] }),
    }
  }
}
