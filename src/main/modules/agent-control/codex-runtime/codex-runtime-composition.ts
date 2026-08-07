import { createHash } from 'node:crypto'

import type {
  IngressAdmittedEvent,
  PersistedIngress,
  SendScopedRequest,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { ConversationScope } from '../contracts/types'
import type { ScopeRunEventPayload } from '../contracts/types'
import type { ExecutionHostResult } from '../contracts/run-contracts'
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
} from '../../repositories/agent-session-checkpoint-repository'

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
  failureEvidenceDigest(): string { return digest('e1-native-unavailable:lifecycle') }
  async resetIdleAlias(): Promise<never> { return this.unavailable() }
  async awaitProductCloseout(): Promise<never> { return this.unavailable() }
  async settleHostFailureCloseout(): Promise<never> { return this.unavailable() }
  async retireAliasForClose(): Promise<never> { return this.unavailable() }
  async beginManualCompaction(): Promise<never> { return this.unavailable() }
  async awaitManualCompaction(): Promise<never> { return this.unavailable() }
  async consumeManualCompaction(): Promise<never> { return this.unavailable() }
  digestThreadRead(): string { return digest('e1-native-unavailable:thread-read') }
}

export function createE2UnavailableCodexRuntimeComposition(): CodexRuntimeComposition {
  const nativeRuntime = new UnavailableCodexNativeRuntime()
  const collector = new CodexTurnCollector(nativeRuntime)
  const lifecycleAdapter = new ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>({
    nativeRuntime,
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
    },
    preparedRunContextPort: {
      async resolve() {
        throw new Error('codex_prepared_run_context_unavailable')
      },
    },
    canonicalCloseoutTransactionParticipant: {
      complete() {},
    },
  }
}
