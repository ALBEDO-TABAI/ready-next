import type {
  CodexBindingRecoveryMember,
  CodexBindingRepository,
  CodexProductLifecycleActionRead,
  CodexProductFenceRecovery,
  CodexProductTurnRuntimeRead,
} from './codex-binding-repository'
import type { CodexNativeRuntime, CodexTurn } from './codex-native-runtime'
import type { CodexThread } from './codex-native-runtime'
import type { CodexStartIdentityRegistry } from './codex-start-identity-registry'
import { CodexTurnCollector, type CoreTurnCandidate } from './codex-turn-collector'
import { CodexTurnInputBuilder } from './codex-turn-input-builder'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import type { CodexNativeModelSettings } from './codex-model-gateway-contract'
import type { CodexAutomaticCompactionEvidence } from './codex-automatic-compaction-evidence'

const DEFAULT_POLL_INTERVAL_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecoveryLifecycleCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'codex_product_recovery_stopped'
    || message === 'codex_product_recovery_generation_advanced'
}

function stableRecoveryCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[a-z0-9_:-]{1,160}$/i.test(message) ? message : fallback
}

function isRunLocalModelSettingsError(code: string): boolean {
  return code === 'upstream_profile_snapshot_unavailable'
    || code === 'upstream_profile_snapshot_invalid'
    || code === 'gateway_context_window_invalid'
}

function isRunLocalAutomaticCompactionError(code: string): boolean {
  return code === 'codex_recovered_automatic_compaction_identity_mismatch'
    || code.startsWith('automatic_compaction_')
}

function isExplicitRunLocalRecoveryCode(code: string): boolean {
  return isRunLocalModelSettingsError(code)
    || isRunLocalAutomaticCompactionError(code)
    || code.startsWith('codex_recovered_turn_input_')
    || code === 'codex_recovered_instruction_contract_drift'
}

export class CodexRunLocalRecoveryError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'CodexRunLocalRecoveryError'
  }
}

export type CodexProductRecoveryFailureClassification =
  | { kind: 'run_local'; code: string }
  | { kind: 'transient'; code: string }
  | { kind: 'global'; code: string }

export function classifyCodexProductRecoveryFailure(
  error: unknown,
): CodexProductRecoveryFailureClassification {
  if (error instanceof CodexRunLocalRecoveryError) {
    return isExplicitRunLocalRecoveryCode(error.code)
      ? { kind: 'run_local', code: error.code }
      : { kind: 'global', code: error.code }
  }
  const code = stableRecoveryCode(error, 'product_recovery_failed')
  if (
    code === 'codex_browser_workflow_observation_required'
    || code === 'codex_browser_workflow_research_incomplete'
    || code === 'codex_browser_workflow_projection_missing'
    || isRunLocalAutomaticCompactionError(code)
  ) return { kind: 'run_local', code }
  if (
    code === 'codex_product_closeout_in_flight'
    || code === 'codex_product_closeout_already_committed'
    || code === 'codex_browser_workflow_action_in_flight'
    || code.startsWith('codex_tool_publication_incomplete:')
    || code.startsWith('codex_tool_publication_indeterminate:')
  ) return { kind: 'transient', code }
  return { kind: 'global', code }
}

export async function routeCodexBootRecoveryFailure(input: {
  error: unknown
  settleRunLocal: (code: string) => Promise<void>
  failGlobal: (code: string) => void
}): Promise<'run_local_settled' | 'held' | 'global_failed'> {
  const classification = classifyCodexProductRecoveryFailure(input.error)
  if (classification.kind === 'transient') return 'held'
  if (classification.kind === 'global') {
    input.failGlobal(classification.code)
    return 'global_failed'
  }
  try {
    await input.settleRunLocal(classification.code)
    return 'run_local_settled'
  } catch (error) {
    input.failGlobal(stableRecoveryCode(error, 'product_recovery_settlement_failed'))
    return 'global_failed'
  }
}

function runLocalRecoveryError(code: string, cause?: unknown): CodexRunLocalRecoveryError {
  return new CodexRunLocalRecoveryError(code, cause)
}

export function proveCodexStableStartAbsence(input: {
  repository: Pick<CodexBindingRepository, 'readProcessLeaseByConnectionEpoch'>
  ownerMainBootId: string
  member: CodexBindingRecoveryMember
  stableReadbackEvidenceDigest: string
}): { proven: false } | { proven: true; evidenceDigest: string } {
  if (!input.member.connectionEpoch) return { proven: false }
  const lease = input.repository.readProcessLeaseByConnectionEpoch(input.member.connectionEpoch)
  if (!lease?.treeZeroAt || !lease.treeZeroEvidenceDigest
    || !lease.stableZeroSampleTranscriptDigest
    || (!lease.ownerMainDeadAt && lease.ownerMainBootId !== input.ownerMainBootId)) {
    return { proven: false }
  }
  return {
    proven: true,
    evidenceDigest: digestCanonicalJson({
      connectionEpoch: input.member.connectionEpoch,
      stableReadbackEvidenceDigest: input.stableReadbackEvidenceDigest,
      processLeaseId: lease.processLeaseId,
      ownerMainBootId: lease.ownerMainBootId,
      ownerMainDeadAt: lease.ownerMainDeadAt,
      ownerMainDeathEvidenceDigest: lease.ownerMainDeathEvidenceDigest,
      treeZeroAt: lease.treeZeroAt,
      treeZeroEvidenceDigest: lease.treeZeroEvidenceDigest,
      stableZeroSampleTranscriptDigest: lease.stableZeroSampleTranscriptDigest,
    }),
  }
}

export function buildCodexProductReadbackCandidate(input: {
  collector: CodexTurnCollector
  product: CodexProductTurnRuntimeRead
  turn: CodexTurn
  recovery: string
  sourceCandidate?: CoreTurnCandidate
  automaticCompactionEvidence?: CodexAutomaticCompactionEvidence | null
}): CoreTurnCandidate {
  const source = input.sourceCandidate
  return input.collector.buildReadbackCandidate({
    readyTaskId: input.product.readyTaskId,
    readyRunId: input.product.readyRunId,
    scopeId: input.product.readyScopeId,
    codexThreadId: input.product.codexThreadId as string,
    actionReceiptRefs: source?.actionReceiptRefs || [],
    interactionState: source?.interactionState || null,
    waitingFor: source?.waitingFor || null,
    terminalReasonCandidate: input.turn.status === 'completed'
      ? 'done'
      : source?.terminalReasonCandidate || 'done',
    abortInitiator: input.turn.status === 'completed' ? null : source?.abortInitiator || null,
    budgetState: source?.budgetState || { ...input.product.prepared.productBudgetSeed },
    contextState: {
      ...(source?.contextState || {
        resourceAnchorDigest: input.product.prepared.resourceAnchorDigest,
      }),
      automaticCompactionExchanges: input.automaticCompactionEvidence
        ? [input.automaticCompactionEvidence]
        : [],
    },
    providerDiagnostics: {
      ...(source?.providerDiagnostics || {
        provider: 'ready_gateway',
        agentProtocol: 'openai',
        wireApi: 'responses',
      }),
      recovery: input.recovery,
    },
    recoveryCheckpointRef: source?.recoveryCheckpointRef || null,
    browserContinuationRef: source?.browserContinuationRef || null,
    browserProofRefs: source?.browserProofRefs || [],
    otherProofRefs: source?.otherProofRefs || [],
    projectionPatchRefs: source?.projectionPatchRefs || [],
    allowNullPhaseFallback: false,
  }, input.turn)
}

export class CodexProductBootRecovery {
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly inputBuilder = new CodexTurnInputBuilder()
  private stopping = false
  private resolveStop: (() => void) | null = null
  private readonly stopSignal = new Promise<void>((resolve) => { this.resolveStop = resolve })
  private resolveGenerationStop: (() => void) | null = null
  private generationStopSignal: Promise<void>

  constructor(private readonly deps: {
    repository: CodexBindingRepository
    runtime: () => CodexNativeRuntime
    collector: CodexTurnCollector
    closeCandidate: (candidate: CoreTurnCandidate) => Promise<unknown>
    publishRecoveredCloseout: (readyRunId: string, result: unknown) => void
    onRecoveryFailure: (readyRunId: string, error: unknown) => void | Promise<void>
    settleHostFailure: (
      readyRunId: string,
      registry: CodexStartIdentityRegistry,
    ) => Promise<void>
    restoreActiveProductRun: (product: CodexProductTurnRuntimeRead) => void
    abortActiveProductRun?: (product: CodexProductTurnRuntimeRead) => boolean
    finishActiveProductRun: (product: CodexProductTurnRuntimeRead) => void
    ownerMainBootId: string
    resolveDeveloperInstructions: (product: CodexProductTurnRuntimeRead) => string
    resolveNativeModelSettings: (
      product: CodexProductTurnRuntimeRead,
    ) => CodexNativeModelSettings
    verifyAutomaticCompaction?: (input: {
      product: CodexProductTurnRuntimeRead
      thread: CodexThread
      turn: CodexTurn
    }) => CodexAutomaticCompactionEvidence | null
    nowMs?: () => number
    wait?: (ms: number) => Promise<void>
    pollIntervalMs?: number
  }) {
    this.generationStopSignal = this.createGenerationStopSignal()
  }

  async beginBootGeneration(): Promise<boolean> {
    if (this.stopping) return false
    this.cancelBootGeneration()
    await Promise.all([...this.jobs.values()])
    if (this.stopping) return false
    this.generationStopSignal = this.createGenerationStopSignal()
    return true
  }

  cancelBootGeneration(): void {
    this.resolveGenerationStop?.()
  }

  dispatchHeldStart(input: {
    member: CodexBindingRecoveryMember
    registry: CodexStartIdentityRegistry
  }): 'pending' {
    if (this.stopping) return 'pending'
    const readyRunId = input.member.method === 'turn/start'
      ? input.member.bindingId
      : this.deps.repository.readProductRunForThreadBinding(input.member.bindingId)
    this.track(readyRunId, async () => {
      let restoredProduct: CodexProductTurnRuntimeRead | null = null
      try {
        let product = this.deps.repository.readProductTurnRuntime(readyRunId)
        const lifecycleAction = this.deps.repository.readProductLifecycleAction(readyRunId)
        const fence = this.deps.repository.readRecoverySnapshot(() => false)
          .productFences.find((entry) => entry.readyRunId === readyRunId)
        if (!fence) return
        this.deps.repository.claimProductFenceForBoot({
          threadBindingId: fence.threadBindingId,
          readyRunId,
          expectedOwnerMainBootId: fence.ownerMainBootId,
          newOwnerMainBootId: this.deps.ownerMainBootId,
          claimedAt: new Date((this.deps.nowMs || Date.now)()).toISOString(),
        })
        product = this.deps.repository.readProductTurnRuntime(readyRunId)
        this.deps.restoreActiveProductRun(product)
        restoredProduct = product
        if (lifecycleAction) {
          if (!this.deps.abortActiveProductRun?.(product)) {
            throw new Error('codex_lifecycle_action_host_abort_failed')
          }
          const turn = await this.interruptLifecycleActionTurn(product, lifecycleAction)
          await this.monitorTerminal(product, turn)
          return
        }
        if (product.codexThreadId && product.codexTurnId) {
          const turn = await this.readExactTurn(product)
          await this.monitorTerminal(product, turn)
          return
        }
        let nativeModelSettings: CodexNativeModelSettings
        try {
          nativeModelSettings = this.deps.resolveNativeModelSettings(product)
        } catch (error) {
          const code = stableRecoveryCode(error, 'codex_recovered_model_settings_invalid')
          if (!isRunLocalModelSettingsError(code)) throw error
          throw runLocalRecoveryError(code, error)
        }
        if (!product.codexThreadId) {
          const started = await this.awaitActive(this.deps.runtime().threadStart({
            model: product.codexModel,
            modelProvider: 'ready_gateway',
            allowProviderModelFallback: false,
            cwd: product.isolatedThreadCwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            runtimeWorkspaceRoots: [],
            environments: [],
            config: nativeModelSettings.threadConfig,
            dynamicTools: product.prepared.readyToolSurface.dynamicTools,
            developerInstructions: this.resolveDeveloperInstructions(product),
          }))
          if (started.thread.cwd !== product.isolatedThreadCwd) {
            throw new Error('codex_recovered_thread_cwd_mismatch')
          }
          product = this.deps.repository.readProductTurnRuntime(readyRunId)
        }
        if (!product.codexThreadId) {
          throw new Error('codex_recovered_thread_identity_missing')
        }
        let turn: CodexTurn
        if (product.codexTurnId) {
          turn = await this.readExactTurn(product)
        } else {
          const turnInput = this.inputBuilder.build(product.ingress, {
            threadId: product.codexThreadId,
            turnRequestId: product.turnRequestId,
            reasoningEffort: nativeModelSettings.reasoningEffort,
            readyRunId: product.readyRunId,
            toolSurfaceDigest: product.toolSurfaceDigest,
            turnContractDigest: product.turnContractDigest,
            upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
          })
          if (!turnInput.ok) {
            throw runLocalRecoveryError(`codex_recovered_turn_input_${turnInput.code}`)
          }
          turn = (await this.awaitActive(this.deps.runtime().turnStart(turnInput.params))).turn
          product = this.deps.repository.readProductTurnRuntime(readyRunId)
        }
        await this.monitorTerminal(product, turn)
      } catch (error) {
        const start = this.deps.repository.readProductStartState(readyRunId)
        if (start.hostFailureKind && !start.productCloseoutCommitted) {
          await this.deps.settleHostFailure(readyRunId, input.registry)
          return
        }
        throw error
      } finally {
        if (restoredProduct) this.deps.finishActiveProductRun(restoredProduct)
      }
    })
    return 'pending'
  }

  async reconcileProductFence(fence: CodexProductFenceRecovery): Promise<void> {
    if (this.stopping || this.jobs.has(fence.readyRunId)) return
    if (this.deps.repository.readProductCloseout(fence.readyRunId)) return
    this.deps.repository.claimProductFenceForBoot({
      threadBindingId: fence.threadBindingId,
      readyRunId: fence.readyRunId,
      expectedOwnerMainBootId: fence.ownerMainBootId,
      newOwnerMainBootId: this.deps.ownerMainBootId,
      claimedAt: new Date((this.deps.nowMs || Date.now)()).toISOString(),
    })
    const product = this.deps.repository.readProductTurnRuntime(fence.readyRunId)
    this.deps.restoreActiveProductRun(product)
    const lifecycleAction = this.deps.repository.readProductLifecycleAction(fence.readyRunId)
    if (lifecycleAction && !this.deps.abortActiveProductRun?.(product)) {
      this.deps.finishActiveProductRun(product)
      throw new Error('codex_lifecycle_action_host_abort_failed')
    }
    let backgroundOwnsHandle = false
    try {
      const terminal = this.deps.repository.readEngineTerminalCandidate(fence.readyRunId)
      if (terminal) {
        backgroundOwnsHandle = true
        await this.track(fence.readyRunId, () => (
          this.settleCandidate(terminal.candidate as CoreTurnCandidate)
        ), {
          returnAfterFirstTransient: true,
          onFinally: () => this.deps.finishActiveProductRun(product),
        })
        return
      }
      const start = this.deps.repository.readProductStartState(fence.readyRunId)
      if (start.hostFailureKind || !start.codexThreadId || !start.codexTurnId) return
      const turn = lifecycleAction
        ? await this.interruptLifecycleActionTurn(product, lifecycleAction)
        : await this.readExactTurn(product)
      if (turn.status !== 'inProgress') {
        backgroundOwnsHandle = true
        await this.track(
          fence.readyRunId,
          () => this.monitorTerminal(product, turn),
          {
            returnAfterFirstTransient: true,
            onFinally: () => this.deps.finishActiveProductRun(product),
          },
        )
        return
      }
      backgroundOwnsHandle = true
      void this.track(fence.readyRunId, () => this.monitorTerminal(product, turn), {
        onFinally: () => this.deps.finishActiveProductRun(product),
      })
    } finally {
      if (!backgroundOwnsHandle) this.deps.finishActiveProductRun(product)
    }
  }

  private track(
    readyRunId: string,
    task: () => Promise<void>,
    options: { returnAfterFirstTransient?: boolean; onFinally?: () => void } = {},
  ): Promise<void> {
    if (this.stopping) return Promise.resolve()
    const active = this.jobs.get(readyRunId)
    if (active) return active
    let firstAttemptSettled = false
    let resolveFirstAttempt!: (disposition: 'completed' | 'transient') => void
    const firstAttempt = new Promise<'completed' | 'transient'>((resolve) => {
      resolveFirstAttempt = resolve
    })
    const settleFirstAttempt = (disposition: 'completed' | 'transient'): void => {
      if (firstAttemptSettled) return
      firstAttemptSettled = true
      resolveFirstAttempt(disposition)
    }
    const wait = this.deps.wait || delay
    const job = (async () => {
      for (;;) {
        try {
          await task()
          settleFirstAttempt('completed')
          return
        } catch (error) {
          if (isRecoveryLifecycleCancellation(error)) {
            settleFirstAttempt('completed')
            return
          }
          const classification = classifyCodexProductRecoveryFailure(error)
          if (classification.kind !== 'transient') {
            settleFirstAttempt('completed')
            await this.deps.onRecoveryFailure(readyRunId, error)
            return
          }
          if (
            classification.code === 'codex_product_closeout_already_committed'
            && this.deps.repository.readProductCloseout(readyRunId)
          ) {
            settleFirstAttempt('completed')
            return
          }
          settleFirstAttempt('transient')
          try {
            await this.awaitActive(wait(this.deps.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS))
          } catch (waitError) {
            if (!isRecoveryLifecycleCancellation(waitError)) {
              await this.deps.onRecoveryFailure(readyRunId, waitError)
            }
            return
          }
        }
      }
    })()
      .finally(() => {
        this.jobs.delete(readyRunId)
        options.onFinally?.()
      })
    this.jobs.set(readyRunId, job)
    return options.returnAfterFirstTransient
      ? firstAttempt.then((disposition) => disposition === 'transient' ? undefined : job)
      : job
  }

  private async readExactTurn(product: CodexProductTurnRuntimeRead): Promise<CodexTurn> {
    return (await this.readExactTurnReadback(product)).turn
  }

  private async interruptLifecycleActionTurn(
    product: CodexProductTurnRuntimeRead,
    lifecycleAction: CodexProductLifecycleActionRead,
  ): Promise<CodexTurn> {
    if (product.readyRunId !== lifecycleAction.readyRunId
      || product.readyTaskId !== lifecycleAction.readyTaskId
      || product.readyScopeId !== lifecycleAction.readyScopeId
      || product.readyAliasId !== lifecycleAction.readyAliasId
      || product.aliasGeneration !== lifecycleAction.aliasGeneration
      || product.threadBindingId !== lifecycleAction.threadBindingId
      || product.codexThreadId !== lifecycleAction.codexThreadId
      || product.codexTurnId !== lifecycleAction.codexTurnId) {
      throw new Error('codex_lifecycle_action_recovery_identity_mismatch')
    }
    let turn = await this.readExactTurn(product)
    if (turn.status !== 'inProgress') return turn
    try {
      await this.awaitActive(this.deps.runtime().turnInterrupt({
        threadId: lifecycleAction.codexThreadId,
        turnId: lifecycleAction.codexTurnId,
      }))
      this.deps.repository.acknowledgeProductInterrupt({
        readyRunId: product.readyRunId,
        acknowledgedAt: new Date((this.deps.nowMs || Date.now)()).toISOString(),
      })
    } catch {
      turn = await this.readExactTurn(product)
      if (turn.status === 'inProgress') {
        this.deps.repository.markProductInterruptUnknown({
          readyRunId: product.readyRunId,
          unknownAt: new Date((this.deps.nowMs || Date.now)()).toISOString(),
        })
      }
    }
    return turn
  }

  private async readExactTurnReadback(product: CodexProductTurnRuntimeRead): Promise<{
    thread: CodexThread
    turn: CodexTurn
  }> {
    if (!product.codexThreadId || !product.codexTurnId) {
      throw new Error('codex_recovered_turn_identity_missing')
    }
    const read = await this.awaitActive(this.deps.runtime().threadRead({
      threadId: product.codexThreadId,
      includeTurns: true,
    }))
    if (read.thread.id !== product.codexThreadId) {
      throw new Error('codex_recovered_thread_readback_mismatch')
    }
    const turns = read.thread.turns.filter((turn) => turn.id === product.codexTurnId)
    if (turns.length !== 1) {
      throw new Error('codex_recovered_turn_readback_ambiguous')
    }
    return { thread: read.thread, turn: turns[0] }
  }

  private async monitorTerminal(
    product: CodexProductTurnRuntimeRead,
    initial: CodexTurn,
  ): Promise<void> {
    let turn = initial
    const wait = this.deps.wait || delay
    while (turn.status === 'inProgress') {
      await this.awaitActive(wait(this.deps.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS))
      turn = await this.readExactTurn(product)
    }
    const readback = await this.readExactTurnReadback(product)
    if (readback.turn.status === 'inProgress') return
    let automaticCompactionEvidence: CodexAutomaticCompactionEvidence | null = null
    if (!this.deps.repository.readProductLifecycleAction(product.readyRunId)) {
      try {
        automaticCompactionEvidence = this.deps.verifyAutomaticCompaction?.({
          product,
          thread: readback.thread,
          turn: readback.turn,
        }) || null
      } catch (error) {
        const code = stableRecoveryCode(error, 'codex_product_recovery_verifier_rejected')
        if (!isRunLocalAutomaticCompactionError(code)) throw error
        throw runLocalRecoveryError(code, error)
      }
    }
    const candidate = buildCodexProductReadbackCandidate({
      collector: this.deps.collector,
      product,
      turn: readback.turn,
      recovery: 'thread_read',
      automaticCompactionEvidence,
    })
    await this.settleCandidate(candidate)
  }

  private async settleCandidate(candidate: CoreTurnCandidate): Promise<void> {
    if (this.deps.collector.deliverRecoveredCandidate(candidate)) return
    const result = await this.deps.closeCandidate(candidate)
    this.deps.publishRecoveredCloseout(candidate.readyRunId, result)
  }

  private resolveDeveloperInstructions(product: CodexProductTurnRuntimeRead): string {
    try {
      return this.deps.resolveDeveloperInstructions(product)
    } catch (error) {
      const code = stableRecoveryCode(error, 'codex_recovered_instruction_contract_invalid')
      if (code !== 'codex_recovered_instruction_contract_drift') throw error
      throw runLocalRecoveryError(code, error)
    }
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true
      this.resolveStop?.()
      this.resolveGenerationStop?.()
    }
    await Promise.all([...this.jobs.values()])
  }

  private async awaitActive<T>(operation: Promise<T>): Promise<T> {
    const generationStopSignal = this.generationStopSignal
    return Promise.race([
      operation,
      this.stopSignal.then(() => { throw new Error('codex_product_recovery_stopped') }),
      generationStopSignal.then(() => { throw new Error('codex_product_recovery_generation_advanced') }),
    ])
  }

  private createGenerationStopSignal(): Promise<void> {
    return new Promise<void>((resolve) => { this.resolveGenerationStop = resolve })
  }
}
