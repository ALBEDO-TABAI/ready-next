export type GracefulExitAction = 'close_window' | 'quit_app'

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
  onFailure(error: unknown, action: GracefulExitAction): void
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
    try {
      lease = await this.deps.flushRendererState()
      this.activeLease = lease
      const action = this.requestedAction ?? 'close_window'
      if (action === 'quit_app') {
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
      this.deps.onFailure(error, action)
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
