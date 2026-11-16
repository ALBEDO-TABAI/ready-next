export type GracefulExitAction = 'close_window' | 'quit_app'
/** Where an exit stopped: `flush` — renderer state could not be saved; `cleanup` — it was saved, a background part did not stop. */
export type GracefulExitFailureStage = 'flush' | 'cleanup'

export interface PreventableExitEvent {
  preventDefault(): void
}

export interface GracefulExitLease {
  release(): void
}

interface GracefulWindowCloseCoordinatorDeps {
  flushRendererState(): Promise<GracefulExitLease>
  cleanupBeforeQuit(startedAt: number): Promise<void>
  requestWindowClose(): void
  requestAppQuit(): void
  onFailure(error: unknown, action: GracefulExitAction, stage: GracefulExitFailureStage): void
  now?(): number
}

type GracefulExitState = 'idle' | 'flushing' | 'allow_window_close' | 'allow_app_quit'

export class GracefulWindowCloseCoordinator {
  private state: GracefulExitState = 'idle'
  private requestedAction: GracefulExitAction | null = null
  private activeLease: GracefulExitLease | null = null

  constructor(private readonly deps: GracefulWindowCloseCoordinatorDeps) {}

  handleBeforeQuit(event: PreventableExitEvent): void {
    if (this.state === 'allow_app_quit') return
    event.preventDefault()
    this.request('quit_app')
  }

  handleWindowClose(event: PreventableExitEvent): void {
    if (this.state === 'allow_app_quit') return
    if (this.state === 'allow_window_close') {
      this.state = 'idle'
      this.requestedAction = null
      return
    }
    event.preventDefault()
    this.request('close_window')
  }

  handleWindowClosed(): void {
    if (this.state === 'allow_window_close') {
      this.state = 'idle'
      this.requestedAction = null
    }
    this.releaseActiveLease()
  }

  /**
   * The person chose to quit although a background part did not stop (only offered after a `cleanup` failure, when
   * renderer state is already saved). The caller finishes what cleanup is left; the next quit event passes.
   */
  allowAppQuitAfterFailedCleanup(): void {
    if (this.state !== 'idle') return
    this.state = 'allow_app_quit'
    this.deps.requestAppQuit()
  }

  getStateForTests(): GracefulExitState {
    return this.state
  }

  private request(action: GracefulExitAction): void {
    if (this.state === 'flushing') {
      if (action === 'quit_app') this.requestedAction = 'quit_app'
      return
    }
    if (this.state !== 'idle') return
    this.state = 'flushing'
    this.requestedAction = action
    const startedAt = (this.deps.now ?? Date.now)()
    void this.finish(startedAt)
  }

  private async finish(startedAt: number): Promise<void> {
    let lease: GracefulExitLease | null = null
    let stage: GracefulExitFailureStage = 'flush'
    try {
      lease = await this.deps.flushRendererState()
      this.activeLease = lease
      const action = this.requestedAction ?? 'close_window'
      if (action === 'quit_app') {
        stage = 'cleanup'
        await this.deps.cleanupBeforeQuit(startedAt)
        this.state = 'allow_app_quit'
        this.deps.requestAppQuit()
        return
      }
      this.state = 'allow_window_close'
      this.deps.requestWindowClose()
    } catch (error) {
      const action = this.requestedAction ?? 'close_window'
      if (this.activeLease === lease) this.activeLease = null
      this.releaseLease(lease)
      this.state = 'idle'
      this.requestedAction = null
      this.deps.onFailure(error, action, stage)
    }
  }

  private releaseActiveLease(): void {
    const lease = this.activeLease
    this.activeLease = null
    this.releaseLease(lease)
  }

  private releaseLease(lease: GracefulExitLease | null): void {
    try {
      lease?.release()
    } catch {
      // Renderer owns a bounded lease watchdog as the final recovery path.
    }
  }
}
