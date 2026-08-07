import { EventEmitter } from 'events'

import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { AgentRuntimeKernel } from '../contracts/types'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import { DomainAdapterHost } from '../domain-adapters/domain-adapter-host'
import type { AgentControlRuntime } from './runtime'
import { getEphemeralExecutionStore } from '../../tools/skill-primitives/ephemeral-execution-store'
import { getAskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'

export interface CodexHostSessionSummary {
  agent: string
  sessionId: string | null
  state: 'idle' | 'planning' | 'tool_running' | 'responding' | 'done' | 'failed' | 'cancelled' | 'closed'
  lastTurnAt: string
  error?: string
}

export type CodexActiveRunInspection =
  | { state: 'active'; runId: string }
  | { state: 'stale'; runId: null; activeRunId: string }
  | { state: 'not_found'; runId: null }

type CodexActiveProductRun = {
  agent: string
  scopeId: string
  requestId: string
  runId: string
  lastTurnAt: string
}

function activeRunKey(agent: string, scopeId: string): string {
  return `${agent}\u0000${scopeId}`
}

export class CodexHostOrchestrator extends EventEmitter {
  private readonly domainAdapterHost = new DomainAdapterHost()
  private readonly activeProductRuns = new Map<string, CodexActiveProductRun>()

  constructor(options: { browserController?: BrowserController }) {
    super()
    if (options.browserController) this.setBrowserController(options.browserController)
  }

  getRuntimeKernel(): AgentRuntimeKernel {
    return 'codex-native'
  }

  setBrowserController(controller: BrowserController): void {
    this.domainAdapterHost.setBrowserController(controller)
  }

  hasBrowserController(): boolean {
    return this.domainAdapterHost.hasBrowserController()
  }

  getActiveBrowserUrl(): string | null {
    return this.domainAdapterHost.getActiveBrowserUrl()
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapterHost.getDomainAdapters()
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.domainAdapterHost.setRuntime(runtime)
  }

  beginActiveProductRun(input: {
    agent: string
    scopeId: string
    requestId: string
    runId: string
  }): void {
    const record: CodexActiveProductRun = {
      ...input,
      lastTurnAt: new Date().toISOString(),
    }
    this.activeProductRuns.set(activeRunKey(input.agent, input.scopeId), record)
  }

  finishActiveProductRun(input: {
    agent: string
    scopeId: string
    requestId: string
  }): void {
    const key = activeRunKey(input.agent, input.scopeId)
    const active = this.activeProductRuns.get(key)
    if (active?.requestId === input.requestId) this.activeProductRuns.delete(key)
  }

  refreshActiveRunProgress(
    agent: string,
    sessionId: string | undefined,
    requestId?: string,
  ): boolean {
    if (!sessionId) return false
    const key = activeRunKey(agent, sessionId)
    const active = this.activeProductRuns.get(key)
    if (!active || (requestId && active.requestId !== requestId)) return false
    this.activeProductRuns.set(key, {
      ...active,
      lastTurnAt: new Date().toISOString(),
    })
    return true
  }

  inspectActiveRunIfMatches(
    agent: string,
    sessionId: string | undefined,
    requestId: string,
  ): CodexActiveRunInspection {
    if (!sessionId) return { state: 'not_found', runId: null }
    const active = this.activeProductRuns.get(activeRunKey(agent, sessionId))
    if (!active) return { state: 'not_found', runId: null }
    if (active.requestId !== requestId) {
      return { state: 'stale', runId: null, activeRunId: active.requestId }
    }
    return { state: 'active', runId: active.requestId }
  }

  isActiveRunAwaitingUserInput(
    agent: string,
    sessionId: string | undefined,
    requestId: string,
  ): boolean {
    if (this.inspectActiveRunIfMatches(agent, sessionId, requestId).state !== 'active') return false
    return getEphemeralExecutionStore().hasPendingForRun(agent, sessionId ?? null, requestId)
      || getAskUserQuestionsStore().hasPendingForRun(agent, sessionId ?? null, requestId)
  }

  isScopeLive(agent: string, scopeId: string): boolean {
    return this.activeProductRuns.has(activeRunKey(agent, scopeId))
  }

  getActiveRunCount(): number {
    return this.activeProductRuns.size
  }

  listAllSessions(): CodexHostSessionSummary[] {
    return [...this.activeProductRuns.values()].map((active) => ({
      agent: active.agent,
      sessionId: active.scopeId,
      state: 'responding',
      lastTurnAt: active.lastTurnAt,
    }))
  }

}
