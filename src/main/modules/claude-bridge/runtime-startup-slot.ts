export interface StartableRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

export async function startRendererBeforeRuntimeReady(input: {
  startRuntime(): Promise<void>
  startRenderer(): void
}): Promise<void> {
  let runtimeReady: Promise<void>
  try {
    runtimeReady = input.startRuntime()
  } catch (error) {
    input.startRenderer()
    throw error
  }
  input.startRenderer()
  await runtimeReady
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
      if (this.cancelled) throw new Error('agent_runtime_start_cancelled')
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
