import { agentBrowserError, type AgentBrowserStructuredError, type AgentBrowserSurface } from './agent-browser-errors'

export type BrowserWorkflowSessionStatus = 'running' | 'closed'

export interface BrowserWorkflowSession {
  runId: string
  taskId: string
  lane: AgentBrowserSurface
  boundTabId: string
  sourceUserTabId: string | null
  targetFrameId: string | null
  frameUrl: string | null
  startedAt: number
  updatedAt: number
  status: BrowserWorkflowSessionStatus
  closeReason: string | null
}

export type BrowserWorkflowSessionStartResult =
  | { ok: true; session: BrowserWorkflowSession }
  | { ok: false; error: AgentBrowserStructuredError }

export class BrowserWorkflowSessionStore {
  private readonly sessions = new Map<string, BrowserWorkflowSession>()
  private foregroundRunId: string | null = null

  startForeground(params: {
    runId: string
    taskId: string
    lane: AgentBrowserSurface
    boundTabId: string
    sourceUserTabId?: string | null
    targetFrameId?: string | null
    frameUrl?: string | null
  }): BrowserWorkflowSessionStartResult {
    const active = this.getActiveForeground()
    if (active && active.runId !== params.runId) {
      return {
        ok: false,
        error: agentBrowserError(
          'lease_held',
          `Foreground agent browser lane is already locked by task ${active.taskId}.`,
          {
            surface: 'agent-view',
            heldBy: active.taskId,
            runId: active.runId,
            tabId: active.boundTabId,
          },
        ),
      }
    }

    const now = Date.now()
    const existing = this.sessions.get(params.runId)
    const session: BrowserWorkflowSession = {
      runId: params.runId,
      taskId: params.taskId,
      lane: params.lane,
      boundTabId: params.boundTabId,
      sourceUserTabId: params.sourceUserTabId ?? null,
      targetFrameId: params.targetFrameId ?? existing?.targetFrameId ?? null,
      frameUrl: params.frameUrl ?? existing?.frameUrl ?? null,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      status: 'running',
      closeReason: null,
    }
    this.sessions.set(params.runId, session)
    if (params.lane === 'agent-view') {
      this.foregroundRunId = params.runId
    }
    return { ok: true, session }
  }

  updateBoundTab(runId: string, boundTabId: string, reason?: string): BrowserWorkflowSession | null {
    const session = this.sessions.get(runId)
    if (!session || session.status !== 'running') return null
    const next: BrowserWorkflowSession = {
      ...session,
      boundTabId,
      closeReason: reason ?? session.closeReason,
      updatedAt: Date.now(),
    }
    this.sessions.set(runId, next)
    return next
  }

  close(runId: string, reason?: string): BrowserWorkflowSession | null {
    const session = this.sessions.get(runId)
    if (!session) return null
    const next: BrowserWorkflowSession = {
      ...session,
      status: 'closed',
      closeReason: reason ?? session.closeReason,
      updatedAt: Date.now(),
    }
    this.sessions.set(runId, next)
    if (this.foregroundRunId === runId) {
      this.foregroundRunId = null
    }
    return next
  }

  get(runId: string | null | undefined): BrowserWorkflowSession | null {
    if (!runId) return null
    return this.sessions.get(runId) ?? null
  }

  getActiveForeground(): BrowserWorkflowSession | null {
    const session = this.foregroundRunId ? this.sessions.get(this.foregroundRunId) ?? null : null
    return session?.status === 'running' ? session : null
  }
}
