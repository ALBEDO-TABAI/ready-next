import type {
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThreadListParams,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from './codex-native-runtime'

export class StableNativeRuntime implements CodexNativeRuntime {
  private attached: CodexNativeRuntime | null = null
  private detach: (() => void) | null = null
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()

  constructor(private readonly client: () => CodexNativeRuntime) {}

  attach(runtime: CodexNativeRuntime): void {
    this.detach?.()
    this.attached = runtime
    this.detach = runtime.subscribe((notification) => {
      for (const listener of [...this.listeners]) {
        try {
          void Promise.resolve(listener(notification)).catch(() => undefined)
        } catch { /* observers do not own the native connection */ }
      }
    })
  }

  detachClient(): void {
    this.detach?.()
    this.detach = null
    this.attached = null
  }

  private current(): CodexNativeRuntime {
    return this.attached || this.client()
  }

  async initialize(): Promise<{ userAgent: string }> { throw new Error('codex_initialize_owned_by_boot') }
  serverDiagnostics() { return this.current().serverDiagnostics() }
  threadStart(params: CodexThreadStartParams) { return this.current().threadStart(params) }
  threadRead(params: { threadId: string; includeTurns: true }) { return this.current().threadRead(params) }
  threadList(params: CodexThreadListParams) { return this.current().threadList(params) }
  threadResume(params: { threadId: string }) { return this.current().threadResume(params) }
  threadArchive(params: { threadId: string }) { return this.current().threadArchive(params) }
  turnStart(params: CodexTurnStartParams) { return this.current().turnStart(params) }
  turnInterrupt(params: { threadId: string; turnId: string }) { return this.current().turnInterrupt(params) }
  threadCompactStart(params: { threadId: string }) { return this.current().threadCompactStart(params) }
  subscribe(listener: (notification: CodexNativeNotification) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
