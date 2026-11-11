export interface StartableRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

const AGENT_RUNTIME_START_CANCELLED = 'agent_runtime_start_cancelled'

/** Shutdown cancels a runtime that is still starting; the start then fails with this error. */
export function agentRuntimeStartCancelled(): Error {
  return new Error(AGENT_RUNTIME_START_CANCELLED)
}

export function isAgentRuntimeStartCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === AGENT_RUNTIME_START_CANCELLED
}

/**
 * Starts the renderer while the runtime is still starting. A start cancelled by shutdown resolves to `'cancelled'`
 * (quitting during startup is a quit, not a failure); any other failure still rejects.
 */
export async function startRendererBeforeRuntimeReady(input: {
  startRuntime(): Promise<void>
  startRenderer(): void
}): Promise<'ready' | 'cancelled'> {
  let runtimeReady: Promise<void>
  try {
    runtimeReady = input.startRuntime()
  } catch (error) {
    input.startRenderer()
    throw error
  }
  input.startRenderer()
  try {
    await runtimeReady
    return 'ready'
  } catch (error) {
    if (isAgentRuntimeStartCancelled(error)) return 'cancelled'
    throw error
  }
}

export class RuntimeStartupSlot<T extends StartableRuntime> {
  readonly startPromise: Promise<void>
  private cancelled = false
  private settled = false

  constructor(readonly candidate: T) {
    this.startPromise = candidate.start()
  }

  async promote(): Promise<T> {
    try {
      await this.startPromise
      if (this.cancelled) throw agentRuntimeStartCancelled()
      return this.candidate
    } catch (error) {
      await this.candidate.stop()
      throw error
    } finally {
      this.settled = true
    }
  }

  async cancelAndDrain(): Promise<void> {
    this.cancelled = true
    const earlyStop = this.candidate.stop()
    await Promise.allSettled([this.startPromise, earlyStop])
    await this.candidate.stop()
    this.settled = true
  }

  snapshot(): { cancelled: boolean; settled: boolean } {
    return { cancelled: this.cancelled, settled: this.settled }
  }
}
