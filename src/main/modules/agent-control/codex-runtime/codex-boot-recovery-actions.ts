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
import { sameCodexThreadDirectory } from './codex-thread-directory-identity'

type ReadbackRuntime = Pick<CodexNativeRuntime, 'threadList' | 'threadRead' | 'threadResume'>

type ThreadStartIdentity = {
  method: 'thread/start' | 'thread/fork'
  expectedCwd: string
  expectedParentThreadId: string | null
  expectedForkedFromId: string | null
  expectedPrefixTurnIds: string[]
  materializationRequestDigest: string | null
}

type ReadbackResult =
  | {
      kind: 'accepted'
      nativeId: string
      nativeResult: unknown
      evidenceDigest: string
      forkRecoveryEvidence?: {
        connectionEpoch: string
        preResumeThreadReadDigest: string
        resumedThreadDigest: string
      }
    }
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
  commit(input: CodexHostFailureRecovery): Promise<{
    productTerminalDigest: string
    closeoutAt: string
  }>
  deliver(input: CodexHostFailureRecovery): Promise<void>
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

function exactThreadMetadata(thread: CodexThread, identity: ThreadStartIdentity, source: string): boolean {
  return sameCodexThreadDirectory(thread.cwd, identity.expectedCwd)
    && thread.source === source
    && thread.sessionId === thread.id
    && thread.parentThreadId === identity.expectedParentThreadId
    && thread.forkedFromId === identity.expectedForkedFromId
    && thread.threadSource === null
    && thread.modelProvider === 'ready_gateway'
}

function exactThread(thread: CodexThread, identity: ThreadStartIdentity, source: string): boolean {
  return exactThreadMetadata(thread, identity, source)
    && (identity.method !== 'thread/fork' || (
      thread.id !== identity.expectedForkedFromId
      && identity.materializationRequestDigest !== null
      && JSON.stringify(thread.turns.map((turn) => turn.id))
        === JSON.stringify(identity.expectedPrefixTurnIds)
      && thread.turns.every((turn) => turn.status !== 'inProgress')
    ))
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
    recoveryConnectionEpoch: string
  }): Promise<CodexRecoveredStartResolution> {
    const zeroDigests: string[] = []
    for (let readIndex = 0; readIndex < this.deps.stableZeroReadCount; readIndex += 1) {
      let readback: ReadbackResult
      try {
        readback = await this.readStart(input.member, input.recoveryConnectionEpoch)
      } catch (error) {
        return {
          resolution: 'unknown',
          evidenceDigest: evidence({
            method: input.member.method,
            bindingId: input.member.bindingId,
            readIndex,
            readError: error instanceof Error ? error.message : String(error),
          }),
        }
      }
      if (readback.kind === 'accepted') {
        return {
          resolution: 'accepted',
          nativeId: readback.nativeId,
          nativeResult: readback.nativeResult,
          evidenceDigest: readback.evidenceDigest,
          forkRecoveryEvidence: readback.forkRecoveryEvidence,
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
  }): Promise<{ productTerminalDigest: string; closeoutAt: string }> {
    return this.deps.hostFailureTerminal.commit(input.failure)
  }

  deliverHostFailureProductTerminal(input: {
    failure: CodexHostFailureRecovery
  }): Promise<void> {
    return this.deps.hostFailureTerminal.deliver(input.failure)
  }

  reconcileManualCompaction(input: CodexManualCompactionRecovery): Promise<void> {
    return this.deps.manualCompaction.reconcile(input)
  }

  reconcileProductFence(input: CodexProductFenceRecovery): Promise<void> {
    return this.deps.productFence.reconcile(input)
  }

  private async readStart(
    member: CodexBindingRecoveryMember,
    recoveryConnectionEpoch: string,
  ): Promise<ReadbackResult> {
    const identity = this.deps.repository.readStartInboundIdentity(member.method, member.bindingId)
    if (identity.method !== 'turn/start') return this.readThread(identity, recoveryConnectionEpoch)
    return this.readTurn(identity.threadId, identity.clientUserMessageId)
  }

  private async readThread(
    identity: ThreadStartIdentity,
    recoveryConnectionEpoch: string,
  ): Promise<ReadbackResult> {
    const listed = await this.deps.runtime.threadList({
      limit: this.deps.threadListLimit,
      cwd: identity.expectedCwd,
      sourceKinds: ['vscode'],
    })
    if (listed.nextCursor !== null) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ identity, listed }) }
    }
    const candidates = listed.data.filter((thread) => (
      exactThreadMetadata(thread, identity, this.deps.pinnedThreadSource)
    ))
    if (candidates.length === 0) {
      return {
        kind: listed.data.length === 0 ? 'zero' : 'ambiguous',
        evidenceDigest: evidence({ identity, listed }),
      }
    }
    if (candidates.length !== 1) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ identity, candidates }) }
    }
    const read = await this.deps.runtime.threadRead({ threadId: candidates[0].id, includeTurns: true })
    if (!exactThread(read.thread, identity, this.deps.pinnedThreadSource)) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ identity, read }) }
    }
    const preResumeThreadReadDigest = evidence(read)
    const nativeResult = identity.method === 'thread/fork'
      ? await this.deps.runtime.threadResume({ threadId: read.thread.id })
      : { thread: read.thread, instructionSources: [] }
    if (!exactThread(nativeResult.thread, identity, this.deps.pinnedThreadSource)) {
      return { kind: 'ambiguous', evidenceDigest: evidence({ identity, read, nativeResult }) }
    }
    return {
      kind: 'accepted',
      nativeId: read.thread.id,
      nativeResult,
      evidenceDigest: evidence({ identity, read, nativeResult }),
      ...(identity.method === 'thread/fork' ? {
        forkRecoveryEvidence: {
          connectionEpoch: recoveryConnectionEpoch,
          preResumeThreadReadDigest,
          resumedThreadDigest: evidence(nativeResult),
        },
      } : {}),
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
