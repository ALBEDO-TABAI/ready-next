import type { AgentSdkSession } from './agent-sdk-types'

/**
 * Owns the per-name session map and the session lock primitive, extracted from
 * AgentSdkRuntime (V3 Phase 2).
 *
 * Scope is deliberately narrow: this manager holds the session storage + locking
 * state and nothing else. Session construction and lifecycle operations
 * (newSession / stopGeneration / setSystemPrompt) stay in AgentSdkRuntime because
 * they depend on runtime collaborators (abort controllers, tool-action
 * cancellation, deps). Those methods read/write sessions through the accessors
 * here and serialize via {@link withSessionLock}.
 */
export class AgentSdkSessionManager {
  private readonly sessions = new Map<string, AgentSdkSession>()
  private readonly sessionLocks = new Map<string, Promise<void>>()
  private readonly sessionLockCounts = new Map<string, number>()

  get(name: string): AgentSdkSession | undefined {
    return this.sessions.get(name)
  }

  set(name: string, session: AgentSdkSession): void {
    this.sessions.set(name, session)
  }

  has(name: string): boolean {
    return this.sessions.has(name)
  }

  /** In-flight lock holders (incl. queued) for a session — used to decide run admission. */
  activeLockCount(name: string): number {
    return this.sessionLockCounts.get(name) ?? 0
  }

  async withSessionLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.sessionLocks.get(name) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.sessionLockCounts.set(name, (this.sessionLockCounts.get(name) ?? 0) + 1)
    this.sessionLocks.set(name, previous.catch(() => undefined).then(() => current))
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      const nextCount = (this.sessionLockCounts.get(name) ?? 1) - 1
      if (nextCount > 0) {
        this.sessionLockCounts.set(name, nextCount)
      } else {
        this.sessionLockCounts.delete(name)
      }
    }
  }

  extractSessionIdFromInternalName(name: string): string | undefined {
    const marker = name.indexOf('::')
    return marker === -1 ? undefined : name.slice(marker + 2)
  }
}
