import { createHash } from 'node:crypto'

import type {
  IngressAdmittedEvent,
  PersistedIngress,
  SendScopedRequest,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { ConversationScope } from '../contracts/types'
import type { ScopeRunEventPayload } from '../contracts/types'
import type { ExecutionHostResult } from '../contracts/run-contracts'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { IngressPersistenceError } from '../send-scoped-confirmation'
import type { PrePersistenceDispatchResult } from '../send-scoped-confirmation'
import type {
  StartIdentityReservationMethods,
  StartIdentityReservationResult,
  StartIdentityReservationSet,
} from '../send-scoped-confirmation'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import {
  CodexTurnCollector,
} from './codex-turn-collector'
import { CodexTurnInputBuilder } from './codex-turn-input-builder'
import type {
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThreadListParams,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from './codex-native-runtime'
import {
  ReadyCodexLifecycleAdapter,
  type CodexPreparedRunContext,
  type ReadyCodexLifecycleStore,
} from './ready-codex-lifecycle-adapter'
import type {
  CanonicalCoreCloseoutTransactionParticipant,
  CanonicalCoreCloseoutInput,
  CodexFailureCoreCloseoutInput,
} from '../../repositories/agent-session-checkpoint-repository'
import type { TaskExecutionBinding } from '../../../../shared/agent-execution-profile'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import type { RunMessage } from '../contracts/run-contracts'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type {
  ReadyToolSurface,
  ReadyToolTurnSnapshot,
} from './codex-tool-surface'
import type { AgentControlRuntime } from '../runtime-core/runtime'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type {
  CodexExternalReadSliceRequest,
  PreparedCodexExternalReadSlice,
} from './codex-external-read-slice'
import type {
  CodexNativeSkillInput,
  CodexSelectedSkillMethodology,
} from './codex-thread-instructions'
import type { LifecycleOperationProjection } from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'

export interface CodexRuntimeHostPort {
  runtime: AgentControlRuntime
  browserController: BrowserController | null
  sidecarManager: SidecarManager
  getScope(scopeId: string): ConversationScope | null
  createLocalScope(agent: string, id?: string): ConversationScope
  getTaskProjectionStore(): {
    create(record: TaskProjectionRecord, options?: { silent?: boolean; reasonHint?: 'create' }): void
    get(taskId: string): TaskProjectionRecord | null
    update(
      taskId: string,
      patch: Partial<TaskProjectionRecord>,
      options?: { silent?: boolean; reasonHint?: string },
    ): void
  }
  createCodexActiveRunMetaInOpenTransaction(input: {
    runId: string
    taskId: string
    scopeId: string
    messageVisibilityEpoch: number
    agentId: string
    executionBinding: TaskExecutionBinding
    taskType: 'direct_answer'
  }): void
  createInitialExecutionBinding(input: {
    runId: string
    ownerAgentIdAtStart: string
  }): Promise<TaskExecutionBinding>
  resolveToolTurnSnapshot(input: {
    surfaceId: string
    authorizationId: string
    authorization: SkillToolAuthorization
    message: RunMessage
    sessionId: string
    scopeId: string
    config: AIModelConfig
    requestEnvelope?: unknown
    frozenToolSurface?: ReadyToolSurface
  }): ReadyToolTurnSnapshot
  resolveSkillAuthorizationForTurn(input: {
    message: RunMessage
    sessionId: string
    messageVisibilityEpoch: number
    requestEnvelope?: unknown
  }): SkillToolAuthorization
  resolveSelectedSkillMethodology(skillId: string): CodexSelectedSkillMethodology | null
  resolveNativeSkillInput?(input: { skillId?: string; path?: string }): CodexNativeSkillInput | null
  resolveExternalReadSlice(
    request: CodexExternalReadSliceRequest,
  ): Promise<PreparedCodexExternalReadSlice>
  commitCanonicalCoreCloseout(
    input: Omit<CanonicalCoreCloseoutInput, 'repairDerivedState'>,
  ): Promise<{
    canonicalMessage: NonNullable<ExecutionHostResult['canonicalMessage']>
    canonicalMessageDigest: string
  }>
  commitCodexFailureCoreCloseout(
    input: CodexFailureCoreCloseoutInput,
  ): Promise<{ productTerminalDigest: string; closeoutAt: string }>
  getActiveRunAbortSignal(input: {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
  }): AbortSignal | null
  abortActiveProductRun(input: {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
  }): boolean
  restoreActiveProductRun(input: {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    requestId: string
  }): void
  finishActiveProductRun(input: {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    requestId: string
  }): void
  emitProvisionalDelta(input: {
    scopeId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
    agent: string
    ownerAgentId: string
    handoffGeneration: number
    runId: string
    taskId: string
    delta: string
  }): void
  publishCommittedTerminalEvent(event: ScopeRunEventPayload): void
}

export interface CodexStartIdentityPort {
  resolveMethods(scopeId: string): StartIdentityReservationMethods
  reserve(input: {
    scopeId: string
    methods: StartIdentityReservationMethods
  }): Promise<StartIdentityReservationResult>
  reconcileReservationContractFailure(input: {
    scopeId: string
    methods: StartIdentityReservationMethods
    reservationResult: unknown
    evidenceDigest: string
  }): Promise<void>
  releaseAfterIngressFailure(input: {
    reservation: StartIdentityReservationSet
    failure: IngressPersistenceError
  }): Promise<void>
  releaseAfterPrePersistenceRejection(input: {
    reservation: StartIdentityReservationSet
    rejection: Extract<PrePersistenceDispatchResult<PreparedCodexProductRun>, { ok: false }>
  }): Promise<void>
}

export interface CodexIngressPort {
  prepareIngress(input: {
    scope: ConversationScope
    request: SendScopedRequest
    reservation: StartIdentityReservationSet
  }): Promise<PrePersistenceDispatchResult<PreparedCodexProductRun>>
  persistIngressAtomic(input: {
    scope: ConversationScope
    request: SendScopedRequest
    reservation: StartIdentityReservationSet
    /** Prepared and validated before this transaction is allowed to begin. */
    prepared: PreparedCodexProductRun
  }): Promise<{
    persistence: PersistedIngress
    event: IngressAdmittedEvent
  }>
}

export interface CodexAliasBindingPort {
  readAliasGeneration(aliasId: string): number | null
  readActiveProductRunVisibilityIdentity(readyRunId: string): {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
  } | null
  readCommittedProductRunVisibilityIdentity(readyRunId: string): {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
  } | null
  readLifecycleSnapshot(input: {
    aliasId: string
    aliasGeneration: number
  }): LifecycleOperationProjection
}

export type ReadyClosedCodexProductRun = {
  execution: ExecutionHostResult
  productOutcomeDigest: string
  candidateBodyDigest: string | null
  committedTerminalEvent: ScopeRunEventPayload
}

export interface CodexPreparedRunContextPort {
  resolve(input: {
    prepared: PreparedCodexProductRun
    scope: ConversationScope
  }): Promise<CodexPreparedRunContext>
}

export interface CodexRuntimeComposition {
  nativeRuntime: CodexNativeRuntime
  collector: CodexTurnCollector
  lifecycleAdapter: ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>
  startIdentityPort: CodexStartIdentityPort
  ingressPort: CodexIngressPort
  aliasBindingPort: CodexAliasBindingPort
  preparedRunContextPort: CodexPreparedRunContextPort
  canonicalCloseoutTransactionParticipant: CanonicalCoreCloseoutTransactionParticipant
  bindHost(host: CodexRuntimeHostPort): void
  sealIngress(reason: string): void
  ensureReadyForUserIngress(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

class UnavailableCodexNativeRuntime implements CodexNativeRuntime {
  private unavailable(): never {
    throw new Error('codex_app_server_not_initialized')
  }

  async initialize(): Promise<never> { return this.unavailable() }
  async threadStart(_params: CodexThreadStartParams): Promise<never> { return this.unavailable() }
  async threadRead(_params: { threadId: string; includeTurns: true }): Promise<never> { return this.unavailable() }
  async threadList(_params: CodexThreadListParams): Promise<never> { return this.unavailable() }
  async threadResume(_params: { threadId: string }): Promise<never> { return this.unavailable() }
  async threadArchive(_params: { threadId: string }): Promise<never> { return this.unavailable() }
  async turnStart(_params: CodexTurnStartParams): Promise<never> { return this.unavailable() }
  async turnInterrupt(_params: { threadId: string; turnId: string }): Promise<never> { return this.unavailable() }
  async threadCompactStart(_params: { threadId: string }): Promise<never> { return this.unavailable() }
  subscribe(_listener: (notification: CodexNativeNotification) => void): () => void { return () => undefined }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

class UnavailableCodexLifecycleStore implements ReadyCodexLifecycleStore {
  private unavailable(): never {
    throw new Error('codex_lifecycle_repository_unavailable')
  }

  async createAlias(): Promise<never> { return this.unavailable() }
  async readAliasIdentity(): Promise<never> { return this.unavailable() }
  async resolveThreadBinding(): Promise<never> { return this.unavailable() }
  async bindStartedThread(): Promise<never> { return this.unavailable() }
  async markThreadResumed(): Promise<never> { return this.unavailable() }
  async readLifecycleOperation(): Promise<never> { return this.unavailable() }
  async requestProductInterrupt(): Promise<never> { return this.unavailable() }
  async acknowledgeProductInterrupt(): Promise<never> { return this.unavailable() }
  async markProductInterruptUnknown(): Promise<never> { return this.unavailable() }
  failureEvidenceDigest(): string { return digest('e1-native-unavailable:lifecycle') }
  async resetIdleAlias(): Promise<never> { return this.unavailable() }
  async quarantineUnknownManualCompaction(): Promise<never> { return this.unavailable() }
  async awaitProductCloseout(): Promise<never> { return this.unavailable() }
  async settleEngineTerminalUserStop(): Promise<never> { return this.unavailable() }
  async settleReadbackTerminalUserStop(): Promise<never> { return this.unavailable() }
  async retryEngineTerminalUserStopFinalization(): Promise<null> { return null }
  async settleHostFailureCloseout(): Promise<never> { return this.unavailable() }
  async retireAliasForClose(): Promise<never> { return this.unavailable() }
  async beginManualCompaction(): Promise<never> { return this.unavailable() }
  async awaitManualCompaction(): Promise<never> { return this.unavailable() }
  async consumeManualCompaction(): Promise<never> { return this.unavailable() }
  async markManualCompactionUnknown(): Promise<never> { return this.unavailable() }
  digestThreadRead(): string { return digest('e1-native-unavailable:thread-read') }
}

export function createE2UnavailableCodexRuntimeComposition(): CodexRuntimeComposition {
  const nativeRuntime = new UnavailableCodexNativeRuntime()
  const collector = new CodexTurnCollector(nativeRuntime)
  const lifecycleAdapter = new ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>({
    nativeRuntime,
    threadResumePort: {
      async readThenResume() { throw new Error('codex_app_server_not_initialized') },
    },
    collector,
    inputBuilder: new CodexTurnInputBuilder(),
    lifecycleStore: new UnavailableCodexLifecycleStore(),
    closeout: {
      async closeCandidate() {
        throw new Error('codex_ready_closeout_unavailable')
      },
      recoverRejectedCandidate() {
        throw new Error('codex_ready_closeout_recovery_unavailable')
      },
      observeCandidateReadback() { return () => undefined },
    },
  })

  return {
    nativeRuntime,
    collector,
    lifecycleAdapter,
    startIdentityPort: {
      resolveMethods() { return ['thread/start', 'turn/start'] },
      async reserve(input) {
        return {
          ok: false,
          code: 'host_unavailable',
          retryableByUser: true,
          error: 'codex_app_server_not_initialized',
          admissionEvidenceDigest: digest(`e1-native-unavailable:reserve:${input.scopeId}`),
        }
      },
      async reconcileReservationContractFailure() {},
      async releaseAfterIngressFailure() {},
      async releaseAfterPrePersistenceRejection() {},
    },
    ingressPort: {
      async prepareIngress(input) {
        return {
          ok: false,
          code: 'host_unavailable',
          retryableByUser: true,
          error: 'codex_ingress_repository_unavailable',
          admissionEvidenceDigest: digest(`e1-native-unavailable:prepare:${input.scope.id}`),
        }
      },
      async persistIngressAtomic(input) {
        throw new IngressPersistenceError(
          'ingress_transaction_failed',
          digest(`e1-native-unavailable:ingress:${input.scope.id}`),
          'codex_ingress_repository_unavailable',
        )
      },
    },
    aliasBindingPort: {
      readAliasGeneration() { return null },
      readActiveProductRunVisibilityIdentity() { return null },
      readCommittedProductRunVisibilityIdentity() { return null },
      readLifecycleSnapshot() { throw new Error('codex_lifecycle_repository_unavailable') },
    },
    preparedRunContextPort: {
      async resolve() {
        throw new Error('codex_prepared_run_context_unavailable')
      },
    },
    canonicalCloseoutTransactionParticipant: {
      complete() {},
    },
    bindHost() {},
    sealIngress() {},
    async ensureReadyForUserIngress() {},
    async start() {},
    async stop() {},
  }
}

export { createCodexRuntimeComposition } from './codex-runtime-production-composition'
