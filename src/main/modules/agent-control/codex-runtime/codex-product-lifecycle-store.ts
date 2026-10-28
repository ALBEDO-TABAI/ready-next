import { randomUUID } from 'node:crypto'

import { classifyLifecycleOperation } from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import { MAIN_AGENT_ID } from '../../../../shared/agent-identity'
import type { ConversationScope } from '../contracts/types'
import type { ExecutionHostResult } from '../contracts/run-contracts'
import {
  CodexBindingRepository,
  CodexBindingRepositoryError,
  type CodexActiveAliasBindingRead,
  type CodexLifecycleAction,
} from './codex-binding-repository'
import { digestCanonicalJson, resolveCodexNativeModelSettings } from './codex-model-gateway-contract'
import type { CodexNativeRuntime, CodexTurn } from './codex-native-runtime'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import type { CodexRuntimeHostPort, ReadyClosedCodexProductRun } from './codex-runtime-composition'
import type { CodexStartIdentityRegistry } from './codex-start-identity-registry'
import { CodexManualCompactionController } from './codex-manual-compaction-controller'
import { sameCodexThreadDirectory } from './codex-thread-directory-identity'
import {
  ReadyCodexLifecyclePortError,
  type CloseRetirementEvidence,
  type ProductTurnCloseoutEvidence,
  type ReadyCodexLifecycleStore,
  type StartedThreadResolution,
} from './ready-codex-lifecycle-adapter'

function isoNow(): string {
  return new Date().toISOString()
}

export type IdleCloseSnapshot =
  | 'idle_never_started'
  | 'idle_ready_terminal_no_native'
  | 'idle_native_thread'

function readExpectedForkedFromId(
  repository: CodexBindingRepository,
  binding: CodexActiveAliasBindingRead,
): string | null {
  if (binding.materializationKind !== 'native_fork') return null
  const fork = repository.readNativeForkMaterialization(binding.threadBindingId)
  if (!fork || fork.materializationState !== 'confirmed'
    || fork.sourceCodexThreadId === binding.codexThreadId) {
    throw new ReadyCodexLifecyclePortError('native_protocol_error')
  }
  return fork.sourceCodexThreadId
}

function startedThreadResolution(
  repository: CodexBindingRepository,
  loadedThreads: ReadonlySet<string>,
  binding: CodexActiveAliasBindingRead & { codexThreadId: string; isolatedThreadCwd: string },
  threadDeveloperInstructions: (instructionContractDigest: string) => string,
): StartedThreadResolution {
  if (loadedThreads.has(binding.codexThreadId)) {
    return { state: 'loaded', threadId: binding.codexThreadId }
  }
  if (!binding.instructionContractDigest) throw new ReadyCodexLifecyclePortError('native_protocol_error')
  return {
    state: 'resume_required',
    threadId: binding.codexThreadId,
    expectedCwd: binding.isolatedThreadCwd,
    expectedForkedFromId: readExpectedForkedFromId(repository, binding),
    developerInstructions: threadDeveloperInstructions(binding.instructionContractDigest),
  }
}

export async function retireCodexAliasForClose(input: {
  repository: CodexBindingRepository
  nativeRuntime: CodexNativeRuntime
  loadedThreads: Set<string>
  identity: { aliasId: string; aliasGeneration: number }
  snapshot: IdleCloseSnapshot
  retiredAt: string
  scheduleThreadArchiveCleanup: () => void
  sealClosedConversationInOpenTransaction: (input: {
    conversationId: string
    closedAt: string
  }) => void
}): Promise<CloseRetirementEvidence> {
  const current = input.repository.readActiveAliasBinding(input.identity.aliasId)
  if (!current || current.aliasGeneration !== input.identity.aliasGeneration) {
    throw new ReadyCodexLifecyclePortError('binding_conflict')
  }

  let idleThreadReadDigest: string | null = null
  if (input.snapshot === 'idle_native_thread') {
    if (!current.codexThreadId || !current.codexSessionId || !current.isolatedThreadCwd) {
      throw new ReadyCodexLifecyclePortError('native_protocol_error')
    }
    let readback: Awaited<ReturnType<CodexNativeRuntime['threadRead']>>
    try {
      readback = await input.nativeRuntime.threadRead({
        threadId: current.codexThreadId,
        includeTurns: true,
      })
    } catch {
      throw new ReadyCodexLifecyclePortError('native_protocol_error')
    }
    const thread = readback.thread
    const expectedForkedFromId = readExpectedForkedFromId(input.repository, current)
    if (
      thread.id !== current.codexThreadId
      || thread.sessionId !== current.codexSessionId
      || !sameCodexThreadDirectory(thread.cwd, current.isolatedThreadCwd)
      || thread.parentThreadId !== null
      || thread.forkedFromId !== expectedForkedFromId
      || thread.source !== 'vscode'
      || thread.threadSource !== null
    ) throw new ReadyCodexLifecyclePortError('native_protocol_error')
    if (
      thread.status.type === 'active'
      || thread.turns.some((turn) => turn.status === 'inProgress')
    ) throw new ReadyCodexLifecyclePortError('thread_busy')
    idleThreadReadDigest = digestCanonicalJson(thread)
  } else if (current.codexThreadId !== null) {
    throw new ReadyCodexLifecyclePortError('native_protocol_error')
  }

  const retirementEvidenceDigest = digestCanonicalJson({
    identity: input.identity,
    snapshot: input.snapshot,
    retiredAt: input.retiredAt,
    idleThreadReadDigest,
  })
  let retired: ReturnType<CodexBindingRepository['retireIdleAliasForClose']>
  try {
    retired = input.repository.retireIdleAliasForClose({
      aliasId: input.identity.aliasId,
      expectedGeneration: input.identity.aliasGeneration,
      expectedSnapshot: input.snapshot,
      retirementEvidenceDigest,
      retiredAt: input.retiredAt,
      idleThreadReadDigest,
      onClosedInOpenTransaction: input.sealClosedConversationInOpenTransaction,
    })
  } catch (error) {
    if (error instanceof CodexBindingRepositoryError) {
      if (
        error.code === 'active_alias_generation_mismatch'
        || error.code === 'alias_close_cas_failed'
      ) throw new ReadyCodexLifecyclePortError('binding_conflict')
      if (
        error.code === 'alias_not_idle'
        || error.code === 'alias_close_turn_unresolved'
        || error.code === 'thread_archive_fence_active'
        || error.code === 'thread_archive_turn_unresolved'
        || error.code === 'thread_archive_call_unresolved'
        || error.code === 'thread_archive_descendant_exists'
      ) throw new ReadyCodexLifecyclePortError('thread_busy')
      if (
        error.code === 'alias_close_thread_readback_invalid'
        || error.code === 'alias_close_snapshot_mismatch'
      ) throw new ReadyCodexLifecyclePortError('native_protocol_error')
    }
    throw new ReadyCodexLifecyclePortError('persistence_failed')
  }

  if (retired.codexThreadId) {
    input.loadedThreads.delete(retired.codexThreadId)
    input.scheduleThreadArchiveCleanup()
  }
  return {
    aliasId: retired.aliasId,
    retiredGeneration: retired.retiredGeneration,
    retirementTransactionDigest: retired.transactionDigest,
    archiveDisposition: retired.codexThreadId ? 'durable_cleanup_pending' : 'not_required',
    archiveIntentDigest: retired.archiveIntentDigest,
    scopeClosureEvidenceDigest: retired.scopeClosureEvidenceDigest,
    lastCommittedReadyTerminalTransactionDigest:
      retired.lastCommittedReadyTerminalTransactionDigest,
    idleThreadReadDigest,
    lastCommittedProductTerminalDigest: retired.lastCommittedProductTerminalDigest,
  }
}

export function createLifecycleStore(input: {
  repository: CodexBindingRepository
  nativeRuntime: CodexNativeRuntime
  getHost: () => CodexRuntimeHostPort | null
  getRegistry: () => CodexStartIdentityRegistry | null
  createAliasAtomic: (value: {
    aliasId: string
    agentId: string
    persistedAt: string
  }) => void
  loadedThreads: Set<string>
  getActiveConnectionEpoch: () => string
  currentRuntimeManifestDigest: string
  currentProtocolSchemaDigest: string
  settleHostFailureCloseout: (identity: {
    aliasId: string
    aliasGeneration: number
  }) => Promise<void>
  scheduleThreadArchiveCleanup: () => void
  sealClosedConversationInOpenTransaction: (input: {
    conversationId: string
    closedAt: string
  }) => void
  settleEngineTerminalUserStop: (identity: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
  }, action?: CodexLifecycleAction) => Promise<ProductTurnCloseoutEvidence>
  settleReadbackTerminalUserStop: (input: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
    codexThreadId: string
    turn: CodexTurn
  }, action?: CodexLifecycleAction) => Promise<ProductTurnCloseoutEvidence>
  retryEngineTerminalUserStopFinalization: (identity: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
  }) => Promise<ProductTurnCloseoutEvidence | null>
  manualCompactionController: CodexManualCompactionController
  getDeveloperInstructions: (prepared: PreparedCodexProductRun) => string
  /** The instructions a thread was created with, rebuilt from its frozen digest; throws on drift. */
  getThreadDeveloperInstructions: (instructionContractDigest: string) => string
  getNativeModelSettings: (
    prepared: PreparedCodexProductRun,
  ) => ReturnType<typeof resolveCodexNativeModelSettings>
}): ReadyCodexLifecycleStore {
  return {
    async createAlias(_request) {
      const boundHost = input.getHost()
      if (!boundHost) throw new Error('codex_runtime_host_unbound')
      const aliasId = `conv-${randomUUID()}`
      const persistedAt = isoNow()
      input.createAliasAtomic({ aliasId, agentId: MAIN_AGENT_ID, persistedAt })
      return { ok: true, action: 'create', aliasId, aliasGeneration: 1, persistedAt }
    },
    async readAliasIdentity(aliasId) {
      const binding = input.repository.readActiveAliasBinding(aliasId)
      if (!binding || binding.retiredAt) throw new Error('active_alias_binding_missing')
      return { aliasId: binding.aliasId, aliasGeneration: binding.aliasGeneration }
    },
    async resolveThreadBinding(identity, prepared) {
      const binding = input.repository.readActiveAliasBinding(identity.aliasId)
      if (
        !binding
        || binding.aliasGeneration !== identity.aliasGeneration
        || binding.readyScopeId !== prepared.readyToolHostIdentity.scopeId
        || !binding.isolatedThreadCwd
      ) throw new Error('active_alias_binding_mismatch')
      if (!binding.codexThreadId) {
        const nativeModelSettings = input.getNativeModelSettings(prepared)
        return {
          state: 'unstarted' as const,
          params: {
            model: 'ready-e0-model',
            modelProvider: 'ready_gateway',
            allowProviderModelFallback: false as const,
            cwd: binding.isolatedThreadCwd,
            approvalPolicy: 'never' as const,
            sandbox: 'read-only' as const,
            runtimeWorkspaceRoots: [] as [],
            environments: [] as [],
            config: nativeModelSettings.threadConfig,
            dynamicTools: prepared.readyToolSurface.dynamicTools,
            developerInstructions: input.getDeveloperInstructions(prepared),
          },
        }
      }
      return startedThreadResolution(input.repository, input.loadedThreads, {
        ...binding,
        codexThreadId: binding.codexThreadId,
        isolatedThreadCwd: binding.isolatedThreadCwd,
      }, input.getThreadDeveloperInstructions)
    },
    async resolveStartedThread(identity) {
      const binding = input.repository.readActiveAliasBinding(identity.aliasId)
      if (
        !binding
        || binding.aliasGeneration !== identity.aliasGeneration
        || !binding.isolatedThreadCwd
        || !binding.codexThreadId
      ) throw new Error('active_alias_binding_mismatch')
      return startedThreadResolution(input.repository, input.loadedThreads, {
        ...binding,
        codexThreadId: binding.codexThreadId,
        isolatedThreadCwd: binding.isolatedThreadCwd,
      }, input.getThreadDeveloperInstructions)
    },
    async bindStartedThread(binding) {
      if (
        binding.sessionId !== binding.threadId
        || binding.parentThreadId !== null
        || binding.forkedFromId !== null
        || binding.source !== 'vscode'
        || binding.threadSource !== null
      ) throw new Error('started_thread_identity_mismatch')
      const current = input.repository.readActiveAliasBinding(binding.identity.aliasId)
      if (
        !current
        || current.aliasGeneration !== binding.identity.aliasGeneration
        || current.codexThreadId !== binding.threadId
        || current.codexSessionId !== binding.sessionId
        || !current.isolatedThreadCwd
        || !sameCodexThreadDirectory(current.isolatedThreadCwd, binding.cwd)
      ) throw new Error('started_thread_durable_readback_mismatch')
      input.loadedThreads.add(binding.threadId)
    },
    async markThreadResumed(binding) {
      if (input.getActiveConnectionEpoch() !== binding.connectionEpoch) {
        throw new Error('resumed_thread_connection_epoch_mismatch')
      }
      const current = input.repository.readActiveAliasBinding(binding.identity.aliasId)
      if (!current || current.aliasGeneration !== binding.identity.aliasGeneration || current.codexThreadId !== binding.threadId) {
        throw new Error('resumed_thread_binding_mismatch')
      }
      input.repository.recordThreadResumeEvidence({
        aliasId: binding.identity.aliasId,
        aliasGeneration: binding.identity.aliasGeneration,
        threadId: binding.threadId,
        connectionEpoch: binding.connectionEpoch,
        preResumeThreadReadDigest: binding.preResumeThreadReadDigest,
        resumedThreadDigest: binding.resumedThreadDigest,
        recordedAt: isoNow(),
      })
      input.loadedThreads.add(binding.threadId)
    },
    async readLifecycleOperation(identity) {
      return input.repository.readLifecycleOperation(identity)
    },
    async requestProductInterrupt(interrupt) {
      const owner = input.repository.requestProductInterrupt({
        action: interrupt.action,
        aliasId: interrupt.identity.aliasId,
        aliasGeneration: interrupt.identity.aliasGeneration,
        readyRunId: interrupt.readyRunId,
        codexThreadId: interrupt.codexThreadId,
        codexTurnId: interrupt.codexTurnId,
        requestedAt: isoNow(),
      })
      const boundHost = input.getHost()
      if (!boundHost || !boundHost.abortActiveProductRun({
        readyRunId: owner.readyRunId,
        readyScopeId: owner.readyScopeId,
        readyAliasId: owner.readyAliasId,
      })) throw new Error('product_interrupt_ready_abort_failed')
    },
    async acknowledgeProductInterrupt(interrupt) {
      const owner = input.repository.resolveProductInterruptOwner({
        aliasId: interrupt.identity.aliasId,
        aliasGeneration: interrupt.identity.aliasGeneration,
        readyRunId: interrupt.readyRunId,
        codexThreadId: interrupt.codexThreadId,
        codexTurnId: interrupt.codexTurnId,
      })
      input.repository.acknowledgeProductInterrupt({
        readyRunId: owner.readyRunId,
        acknowledgedAt: isoNow(),
      })
    },
    async markProductInterruptUnknown(interrupt) {
      const owner = input.repository.resolveProductInterruptOwner({
        aliasId: interrupt.identity.aliasId,
        aliasGeneration: interrupt.identity.aliasGeneration,
        readyRunId: interrupt.readyRunId,
        codexThreadId: interrupt.codexThreadId,
        codexTurnId: interrupt.codexTurnId,
      })
      input.repository.markProductInterruptUnknown({
        readyRunId: owner.readyRunId,
        unknownAt: isoNow(),
      })
    },
    failureEvidenceDigest(value) { return digestCanonicalJson(value) },
    async resetIdleAlias({ identity, snapshot }) {
      const current = input.repository.readActiveAliasBinding(identity.aliasId)
      if (!current || current.aliasGeneration !== identity.aliasGeneration) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      const resetAt = isoNow()
      const result = input.repository.resetIdleAlias({
        aliasId: identity.aliasId,
        expectedGeneration: identity.aliasGeneration,
        retirementEvidenceDigest: digestCanonicalJson({ identity, snapshot, resetAt }),
        resetAt,
      })
      if (current.codexThreadId) input.loadedThreads.delete(current.codexThreadId)
      if (result.archiveIntentDigest) input.scheduleThreadArchiveCleanup()
      return {
        ok: true,
        action: 'reset',
        aliasId: result.aliasId,
        retiredGeneration: result.retiredGeneration,
        newGeneration: result.newGeneration,
        transactionDigest: result.transactionDigest,
      }
    },
    async resetLegacyPreparedAlias({ identity }) {
      const retiredAt = isoNow()
      const result = input.repository.retireLegacyPreparedAlias({
        aliasId: identity.aliasId,
        expectedGeneration: identity.aliasGeneration,
        action: 'reset',
        retirementEvidenceDigest: digestCanonicalJson({
          identity,
          reason: 'legacy_prepared_contract',
          retiredAt,
        }),
        retiredAt,
        currentRuntimeManifestDigest: input.currentRuntimeManifestDigest,
        currentProtocolSchemaDigest: input.currentProtocolSchemaDigest,
      })
      if (!result.newGeneration || !result.newThreadBindingId) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return {
        ok: true,
        action: 'reset',
        aliasId: result.aliasId,
        retiredGeneration: result.retiredGeneration,
        newGeneration: result.newGeneration,
        transactionDigest: result.transactionDigest,
      }
    },
    async closeLegacyPreparedAlias({ identity }) {
      const retiredAt = isoNow()
      const result = input.repository.retireLegacyPreparedAlias({
        aliasId: identity.aliasId,
        expectedGeneration: identity.aliasGeneration,
        action: 'close',
        retirementEvidenceDigest: digestCanonicalJson({
          identity,
          reason: 'legacy_prepared_contract',
          retiredAt,
        }),
        retiredAt,
        onClosedInOpenTransaction: input.sealClosedConversationInOpenTransaction,
      })
      if (!result.scopeClosureEvidenceDigest) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return {
        ok: true,
        action: 'close',
        closeoutDisposition: 'legacy_prepared_contract',
        aliasId: result.aliasId,
        retiredGeneration: result.retiredGeneration,
        retirementTransactionDigest: result.transactionDigest,
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: result.scopeClosureEvidenceDigest,
      }
    },
    async quarantineUnknownManualCompaction({ identity, manualCompactionId }) {
      const current = input.repository.readActiveAliasBinding(identity.aliasId)
      const operation = input.repository.readLifecycleOperation(identity)
      if (
        !current
        || current.aliasGeneration !== identity.aliasGeneration
        || operation.activeManualCompactionId !== manualCompactionId
        || classifyLifecycleOperation(operation.facts) !== 'manual_compaction_unknown'
      ) throw new ReadyCodexLifecyclePortError('persistence_failed')
      const quarantinedAt = isoNow()
      const result = input.repository.quarantineUnknownManualCompaction({
        aliasId: identity.aliasId,
        aliasGeneration: identity.aliasGeneration,
        manualCompactionId,
        reason: 'user_reset_after_manual_compaction_unknown',
        evidenceDigest: digestCanonicalJson({
          identity,
          manualCompactionId,
          action: 'reset',
          snapshot: 'manual_compaction_unknown',
        }),
        quarantinedAt,
      })
      if (current.codexThreadId) input.loadedThreads.delete(current.codexThreadId)
      return {
        ok: true,
        action: 'reset',
        aliasId: result.aliasId,
        retiredGeneration: result.retiredGeneration,
        newGeneration: result.nextAliasGeneration,
        transactionDigest: result.transactionDigest,
      }
    },
    async awaitProductCloseout(identity, readyRunId) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        try {
          if (readyRunId && input.repository.readProductLifecycleAction(readyRunId)) {
            const read = input.repository.readLifecycleActionCloseout(readyRunId)
            return {
              aliasId: read.aliasId,
              aliasGeneration: read.aliasGeneration,
              codexThreadId: read.codexThreadId,
              codexTurnId: read.codexTurnId,
              terminal: read.terminal,
              closeoutDigest: read.closeoutDigest,
              fenceReleaseRevision: read.fenceReleaseRevision,
              lifecycleAction: read.action,
              lifecycleActionEvidenceDigest: read.lifecycleActionEvidenceDigest,
              ...(read.retiredGeneration === null
                ? {} : { retiredGeneration: read.retiredGeneration }),
              ...(read.retirementTransactionDigest === null
                ? {} : { retirementTransactionDigest: read.retirementTransactionDigest }),
              ...(read.archiveIntentDigest === null
                ? {} : { archiveIntentDigest: read.archiveIntentDigest }),
              scopeClosureEvidenceDigest: read.scopeClosureEvidenceDigest,
              newGeneration: read.newGeneration,
              newThreadBindingId: read.newThreadBindingId,
            }
          }
          const read = input.repository.readLatestLifecycleCloseout({ ...identity, readyRunId })
          return {
            aliasId: read.aliasId,
            aliasGeneration: read.aliasGeneration,
            codexThreadId: read.codexThreadId,
            codexTurnId: read.codexTurnId,
            terminal: read.terminal,
            closeoutDigest: read.closeoutDigest,
            fenceReleaseRevision: read.fenceReleaseRevision,
          }
        } catch {
          // silent-catch: closeout not readable yet; poll again until the deadline, then interrupt_state_unknown is thrown
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    },
    settleEngineTerminalUserStop(identity, action) {
      return input.settleEngineTerminalUserStop(identity, action)
    },
    settleReadbackTerminalUserStop(value, action) {
      return input.settleReadbackTerminalUserStop(value, action)
    },
    retryEngineTerminalUserStopFinalization(identity) {
      return input.retryEngineTerminalUserStopFinalization(identity)
    },
    async settleHostFailureCloseout(identity) {
      await input.settleHostFailureCloseout(identity)
    },
    retireAliasForClose({ identity, snapshot }) {
      return retireCodexAliasForClose({
        repository: input.repository,
        nativeRuntime: input.nativeRuntime,
        loadedThreads: input.loadedThreads,
        identity,
        snapshot,
        retiredAt: isoNow(),
        scheduleThreadArchiveCleanup: input.scheduleThreadArchiveCleanup,
        sealClosedConversationInOpenTransaction: input.sealClosedConversationInOpenTransaction,
      })
    },
    beginManualCompaction(identity) {
      return input.manualCompactionController.begin(identity)
    },
    awaitManualCompaction(value) {
      return input.manualCompactionController.awaitCompletion(value)
    },
    consumeManualCompaction(value) {
      return input.manualCompactionController.consume(value)
    },
    settleRejectedManualCompaction(value) {
      return input.manualCompactionController.settleRejected(value)
    },
    async markManualCompactionUnknown(value) {
      input.manualCompactionController.markUnknown(value)
    },
    digestThreadRead(thread) { return digestCanonicalJson(thread) },
  }
}

export function terminalEvent(input: {
  scope: ConversationScope
  product: {
    readyRunId: string
    readyTaskId: string
    ingress?: PreparedCodexProductRun['ingress']
  }
  execution: ExecutionHostResult
  terminalAt: string
}): ReadyClosedCodexProductRun['committedTerminalEvent'] {
  const reason = input.execution.terminalReason || 'persistence_failed'
  return {
    type: 'updated',
    scopeId: input.scope.id,
    aliasGeneration: input.scope.aliasGeneration,
    messageVisibilityEpoch: input.scope.messageVisibilityEpoch,
    visibilityOwnerKind: 'product_alias',
    agent: input.scope.agent,
    ownerAgentId: input.scope.activeAgentId || input.scope.agent,
    taskOrigin: 'user_root',
    handoffGeneration: input.scope.handoffGeneration,
    runId: input.product.readyRunId,
    taskId: input.product.readyTaskId,
    phase: input.execution.success ? 'done' : input.execution.cancelled ? 'cancelled' : 'error',
    terminalReason: reason,
    productTurnReceipt: input.execution.productTurnReceipt,
    latestText: input.execution.finalText,
    module: 'system',
    taskProjectionId: input.product.readyTaskId,
    timestamp: input.terminalAt,
  }
}
