export type CodexSidecarRecoveryTrigger =
  | 'initial_start'
  | 'unexpected_close'
  | 'explicit_user_retry'

export type CodexSidecarRecoverySnapshot = {
  state: 'idle' | 'recovering' | 'ready' | 'exhausted' | 'blocked' | 'stopped'
  trigger: CodexSidecarRecoveryTrigger | null
  attempt: number
  failureCode: string | null
}

export class CodexSidecarRecoveryExhaustedError extends Error {
  readonly code = 'sidecar_recovery_exhausted'

  constructor(readonly lastFailure: unknown) {
    super('sidecar_recovery_exhausted', { cause: lastFailure })
    this.name = 'CodexSidecarRecoveryExhaustedError'
  }
}

function stableFailureCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : error instanceof Error ? error.message : String(error || '')
  return /^[a-z0-9_:-]{1,160}$/i.test(code) ? code : 'sidecar_boot_failed'
}

/**
 * The only owner allowed to launch a replacement Codex sidecar sequence.
 * Attempt pacing and the crash budget remain owned by CodexSidecarSupervisor;
 * this owner only serializes boot attempts and settles each failed lease.
 */
export class CodexSidecarRecoveryOwner {
  private inFlight: Promise<boolean> | null = null
  private settlementPending = false
  private stopped = false
  private snapshot: CodexSidecarRecoverySnapshot = {
    state: 'idle',
    trigger: null,
    attempt: 0,
    failureCode: null,
  }

  constructor(private readonly deps: {
    maxAttempts: number
    bootOnce(): Promise<boolean>
    settleFailedAttempt(): Promise<void>
    resetAttemptBudget(): void
    shouldRetryFailure(error: unknown): boolean
    onSnapshot?(snapshot: CodexSidecarRecoverySnapshot): void
  }) {
    if (!Number.isSafeInteger(deps.maxAttempts) || deps.maxAttempts < 1) {
      throw new Error('sidecar_recovery_attempt_limit_invalid')
    }
  }

  recover(input: {
    trigger: CodexSidecarRecoveryTrigger
    prerequisite?: Promise<void>
  }): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.inFlight) return this.inFlight

    const run = this.run(input)
    this.inFlight = run
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null
    }).catch(() => undefined)
    return run
  }

  ensureReadyForUserIngress(): Promise<boolean> {
    if (this.inFlight) return this.inFlight
    if (this.snapshot.state === 'ready') return Promise.resolve(true)
    if (this.snapshot.state === 'blocked') {
      return Promise.reject(new Error(this.snapshot.failureCode || 'sidecar_recovery_blocked'))
    }
    return this.recover({
      trigger: this.snapshot.state === 'recovering'
        ? 'unexpected_close'
        : 'explicit_user_retry',
    })
  }

  stop(): void {
    this.stopped = true
    this.publish({
      state: 'stopped',
      trigger: this.snapshot.trigger,
      attempt: this.snapshot.attempt,
      failureCode: this.snapshot.failureCode,
    })
  }

  async drain(): Promise<void> {
    if (!this.inFlight) return
    await this.inFlight.then(() => undefined, () => undefined)
  }

  readSnapshot(): CodexSidecarRecoverySnapshot {
    return { ...this.snapshot }
  }

  private async run(input: {
    trigger: CodexSidecarRecoveryTrigger
    prerequisite?: Promise<void>
  }): Promise<boolean> {
    if (this.stopped) return false
    this.publish({ state: 'recovering', trigger: input.trigger, attempt: 0, failureCode: null })
    if (input.prerequisite) {
      this.settlementPending = true
      try {
        await input.prerequisite
        this.settlementPending = false
      } catch (error) {
        return this.failUnprovenSettlement(input.trigger, error)
      }
    } else if (this.settlementPending) {
      try {
        await this.deps.settleFailedAttempt()
        this.settlementPending = false
      } catch (settlementError) {
        return this.failUnprovenSettlement(input.trigger, settlementError)
      }
    }
    if (this.stopped) return false
    if (input.trigger === 'explicit_user_retry') this.deps.resetAttemptBudget()

    let lastFailure: unknown = new Error('sidecar_boot_failed')
    for (let attempt = 1; attempt <= this.deps.maxAttempts; attempt += 1) {
      if (this.stopped) return false
      this.publish({ state: 'recovering', trigger: input.trigger, attempt, failureCode: null })
      try {
        const committed = await this.deps.bootOnce()
        if (!committed || this.stopped) return false
        this.publish({ state: 'ready', trigger: input.trigger, attempt, failureCode: null })
        return true
      } catch (error) {
        lastFailure = error
        this.settlementPending = true
        try {
          await this.deps.settleFailedAttempt()
          this.settlementPending = false
        } catch (settlementError) {
          lastFailure = new AggregateError(
            [error, settlementError],
            'sidecar_failed_attempt_settlement_unproven',
          )
          break
        }
        if (!this.deps.shouldRetryFailure(error)) {
          this.publish({
            state: 'blocked',
            trigger: input.trigger,
            attempt,
            failureCode: stableFailureCode(error),
          })
          throw error
        }
        if (stableFailureCode(error) === 'sidecar_crash_loop_exhausted') break
      }
    }

    const failureCode = stableFailureCode(lastFailure)
    this.publish({
      state: 'exhausted',
      trigger: input.trigger,
      attempt: this.snapshot.attempt,
      failureCode,
    })
    throw new CodexSidecarRecoveryExhaustedError(lastFailure)
  }

  private failUnprovenSettlement(
    trigger: CodexSidecarRecoveryTrigger,
    ...errors: unknown[]
  ): never {
    const failure = new AggregateError(errors, 'sidecar_failed_attempt_settlement_unproven')
    this.publish({
      state: 'exhausted',
      trigger,
      attempt: this.snapshot.attempt,
      failureCode: stableFailureCode(failure),
    })
    throw new CodexSidecarRecoveryExhaustedError(failure)
  }

  private publish(snapshot: CodexSidecarRecoverySnapshot): void {
    this.snapshot = snapshot
    this.deps.onSnapshot?.({ ...snapshot })
  }
}
