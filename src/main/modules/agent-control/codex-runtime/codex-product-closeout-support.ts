import type {
  CodexBindingRepository,
  CodexLifecycleAction,
  CodexProductTurnRuntimeRead,
} from './codex-binding-repository'
import type { CodexPendingInteractionRestartPlan } from './codex-pending-interaction-restart'
import type { CodexRuntimeHostPort } from './codex-runtime-composition'
import { ReadyCodexLifecyclePortError } from './ready-codex-lifecycle-adapter'

export type CodexProductCloseoutMode = 'product' | 'verifier_accepted' | 'verifier_rejected' | 'publication_diverged' | 'recovery_failure' | 'lifecycle_stop' | 'lifecycle_close' | 'lifecycle_reset'

export class CodexProductCloseoutExpectationGuard {
  private readonly expected = new Map<string, {
    mode: CodexProductCloseoutMode
    token: symbol
    recoveryFailure: null | {
      code: string
      evidenceDigest: string
      pendingInteractionRestart: CodexPendingInteractionRestartPlan | null
    }
  }>()

  acquire(readyRunId: string, mode: CodexProductCloseoutMode): symbol {
    if (this.expected.has(readyRunId)) {
      throw new Error('codex_product_closeout_in_flight')
    }
    const token = Symbol(readyRunId)
    this.expected.set(readyRunId, { mode, token, recoveryFailure: null })
    return token
  }

  acquireRecoveryFailure(
    readyRunId: string,
    input: {
      code: string
      evidenceDigest: string
      pendingInteractionRestart?: CodexPendingInteractionRestartPlan | null
    },
  ): symbol {
    const token = this.acquire(readyRunId, 'recovery_failure')
    const expected = this.expected.get(readyRunId)
    if (!expected || expected.token !== token) throw new Error('codex_product_closeout_in_flight')
    expected.recoveryFailure = {
      ...input,
      pendingInteractionRestart: input.pendingInteractionRestart || null,
    }
    return token
  }

  release(readyRunId: string, token: symbol): void {
    if (this.expected.get(readyRunId)?.token === token) this.expected.delete(readyRunId)
  }

  readMode(readyRunId: string): CodexProductCloseoutMode | null {
    return this.expected.get(readyRunId)?.mode ?? null
  }

  readRecoveryFailure(readyRunId: string): {
    code: string
    evidenceDigest: string
    pendingInteractionRestart: CodexPendingInteractionRestartPlan | null
  } | null {
    const expected = this.expected.get(readyRunId)
    return expected?.mode === 'recovery_failure' ? expected.recoveryFailure : null
  }
}

export class CodexCloseCandidateInFlightOwner<T> {
  private readonly inFlight = new Map<string, {
    candidateIdentityDigest: string
    promise: Promise<T>
  }>()

  run(input: {
    readyRunId: string
    candidateIdentityDigest: string
    close: () => Promise<T>
  }): Promise<T> {
    const existing = this.inFlight.get(input.readyRunId)
    if (existing) {
      if (existing.candidateIdentityDigest !== input.candidateIdentityDigest) {
        return Promise.reject(new Error('codex_closeout_in_flight_candidate_conflict'))
      }
      return existing.promise
    }
    const promise = input.close()
    this.inFlight.set(input.readyRunId, {
      candidateIdentityDigest: input.candidateIdentityDigest,
      promise,
    })
    const release = () => {
      if (this.inFlight.get(input.readyRunId)?.promise === promise) {
        this.inFlight.delete(input.readyRunId)
      }
    }
    void promise.then(release, release)
    return promise
  }
}

export function runCodexEngineTerminalFinalization(input: {
  deliver: () => void
  cleanup: () => void
  onDeliveryFailure?: (error: unknown) => void
}): void {
  let deliveryError: unknown = null
  try {
    input.deliver()
  } catch (error) {
    deliveryError = error
  }
  input.cleanup()
  if (!deliveryError) return
  if (input.onDeliveryFailure) {
    input.onDeliveryFailure(deliveryError)
    return
  }
  throw deliveryError
}

export function buildCodexEngineTerminalFinalizationKey(input: {
  aliasId: string
  aliasGeneration: number
  readyRunId: string
}): string {
  return `${input.aliasId}\u0000${input.aliasGeneration}\u0000${input.readyRunId}`
}

export function requestCodexEngineTerminalLifecycleActionBeforeCloseout(input: {
  repository: Pick<CodexBindingRepository, 'requestProductInterrupt'>
  host: Pick<CodexRuntimeHostPort, 'abortActiveProductRun'>
  product: Pick<
    CodexProductTurnRuntimeRead,
    | 'readyRunId'
    | 'readyScopeId'
    | 'readyAliasId'
    | 'aliasGeneration'
    | 'codexThreadId'
    | 'codexTurnId'
  >
  action: CodexLifecycleAction
  requestedAt: string
}): void {
  if (!input.product.codexThreadId || !input.product.codexTurnId) {
    throw new ReadyCodexLifecyclePortError('persistence_failed')
  }
  input.repository.requestProductInterrupt({
    action: input.action,
    aliasId: input.product.readyAliasId,
    aliasGeneration: input.product.aliasGeneration,
    readyRunId: input.product.readyRunId,
    codexThreadId: input.product.codexThreadId,
    codexTurnId: input.product.codexTurnId,
    requestedAt: input.requestedAt,
  })
  const aborted = input.host.abortActiveProductRun({
    readyRunId: input.product.readyRunId,
    readyScopeId: input.product.readyScopeId,
    readyAliasId: input.product.readyAliasId,
  })
  if (!aborted) throw new ReadyCodexLifecyclePortError('persistence_failed')
}

export function requestCodexEngineTerminalUserStopBeforeCloseout(input: Omit<
  Parameters<typeof requestCodexEngineTerminalLifecycleActionBeforeCloseout>[0],
  'action'
>): void {
  requestCodexEngineTerminalLifecycleActionBeforeCloseout({ ...input, action: 'stop' })
}
