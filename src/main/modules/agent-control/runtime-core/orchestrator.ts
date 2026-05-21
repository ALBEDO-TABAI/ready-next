import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { DirectChatEngine, type MultimodalBlock } from '../../claude-bridge/direct-chat'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ExecutionHostRequest, ExecutionHostResult } from '../contracts/run-contracts'
import type { IntentClassification } from '../intent-classifier'
import type { RequestEnvelope } from '../contracts/request-envelope'
import type { ContinuationIntent, ContinuationState } from '../contracts/continuation-state'
import { AgentSessionManager } from '../session-manager'
import { createScopedRunCollector, type SendAndCollectResult } from '../task-projection/run-collector'
import { RunCleanupRegistry, type RunCleanupCallback } from '../task-projection/run-cleanup-registry'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type { AgentRuntimeKernel } from '../contracts/types'
import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from './agent-sdk-runtime'

interface SessionDescriptor {
  agent: string
  sessionId?: string
}

interface ReadyAgentOrchestratorOptions {
  browserController?: BrowserController
  sidecarManager?: SidecarManager
  agentSdkRuntimeDeps?: AgentSdkRuntimeDeps
}

export class ReadyAgentOrchestrator extends EventEmitter {
  private readonly domainAdapterEngine: DirectChatEngine
  private readonly sdkEngine: AgentSdkRuntime
  private readonly sessions: AgentSessionManager
  private readonly descriptors = new Map<string, SessionDescriptor>()
  private readonly runCleanupRegistry = new RunCleanupRegistry()
  private readonly activeRunIds = new Map<string, string>()

  constructor(options?: ReadyAgentOrchestratorOptions) {
    super()
    this.domainAdapterEngine = new DirectChatEngine()
    this.sdkEngine = new AgentSdkRuntime({
      domainAdapters: this.domainAdapterEngine.getDomainAdapters(),
      skillContextOrchestrator: this.domainAdapterEngine.getSkillContextOrchestrator(),
      ...options?.agentSdkRuntimeDeps,
    })
    this.sessions = new AgentSessionManager()
    this.domainAdapterEngine.setRunCleanupRegistry({
      registerRunCleanup: (runId, cleanup) => {
        this.registerRunCleanup(runId, cleanup)
      },
    })
    this.sdkEngine.setRunCleanupRegistry({
      registerRunCleanup: (runId, cleanup) => {
        this.registerRunCleanup(runId, cleanup)
      },
    })

    // Stage U PR U1.3 — DirectChatEngine no longer participates in event
    // emission. It survives as a DomainAdapter / SkillContextOrchestrator
    // provider only (read-only consumer of `getDomainAdapters()` /
    // `getSkillContextOrchestrator()`). Binding its EventEmitter here used
    // to mean any code path that touched the legacy engine could surface
    // events on `agent:stream` / `agent:status` / `agent:error` alongside
    // the SDK runtime — exactly the dual-shape pollution U1.2 / U1.3 are
    // closing. SDK runtime is the single emission producer now.
    this.bindEngineEvents(this.sdkEngine)

    if (options?.browserController) {
      this.setBrowserController(options.browserController)
    }

    if (options?.sidecarManager) {
      this.setSidecarManager(options.sidecarManager)
    }
  }

  private bindEngineEvents(engine: DirectChatEngine | AgentSdkRuntime): void {
    engine.on('output', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      if (payload.type === 'done') {
        this.sessions.setState(taskKey, 'done')
      } else if (payload.type === 'error') {
        this.sessions.setState(taskKey, 'failed', typeof payload.chunk === 'string' ? payload.chunk : undefined)
      } else if (payload.type === 'tool_use') {
        this.sessions.setState(taskKey, 'tool_running')
      } else {
        this.sessions.setState(taskKey, 'responding')
      }
      this.emit('output', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    engine.on('status', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      if (payload.status === 'working') {
        this.sessions.setState(taskKey, 'planning')
      } else if (payload.status === 'done') {
        this.sessions.setState(taskKey, 'done')
      } else if (payload.status === 'cancelled') {
        this.sessions.setState(taskKey, 'cancelled')
      } else if (payload.status === 'error') {
        this.sessions.setState(taskKey, 'failed')
      }
      this.emit('status', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    engine.on('error', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      this.sessions.setState(taskKey, 'failed', payload.error)
      this.emit('error', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    engine.on('toolAction', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      this.emit('toolAction', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })
  }

  getRuntimeKernel(): AgentRuntimeKernel {
    return 'ready-agent-sdk'
  }

  private toInternalSessionKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  private toTaskKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  private resolveDescriptor(internalKey: string): SessionDescriptor {
    const descriptor = this.descriptors.get(internalKey)
    if (descriptor) return descriptor
    const marker = internalKey.indexOf('::')
    if (marker === -1) {
      return { agent: internalKey }
    }
    return {
      agent: internalKey.slice(0, marker),
      sessionId: internalKey.slice(marker + 2),
    }
  }

  setBrowserController(controller: BrowserController): void {
    this.domainAdapterEngine.setBrowserController(controller)
    this.sdkEngine.setBrowserController(controller)
  }

  hasBrowserController(): boolean {
    return this.domainAdapterEngine.hasBrowserController()
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapterEngine.getDomainAdapters()
  }

  setSidecarManager(manager: SidecarManager): void {
    this.domainAdapterEngine.setSidecarManager(manager)
    this.sdkEngine.setSidecarManager(manager)
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.domainAdapterEngine.setRuntime(runtime)
    this.sdkEngine.setRuntime(runtime)
  }

  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.domainAdapterEngine.setRendererToolActionRequester(requester)
    this.sdkEngine.setRendererToolActionRequester(requester)
  }

  setCancelPendingToolActions(
    canceller: ((agent: string, sessionId?: string) => void) | null,
  ): void {
    this.domainAdapterEngine.setCancelPendingToolActions(canceller)
    this.sdkEngine.setCancelPendingToolActions(canceller)
  }

  async send(
    agent: string,
    message: string | MultimodalBlock[],
    sessionId?: string,
    requestId?: string,
    taskId?: string,
    systemPrompt?: string,
    requestEnvelope?: RequestEnvelope,
    intentClassification?: IntentClassification,
    budget?: ExecutionHostRequest['budget'],
    budgetState?: ExecutionHostRequest['budgetState'],
    taskBudgetRuntime?: ExecutionHostRequest['taskBudgetRuntime'],
    continuationIntent?: ContinuationIntent | null,
    continuationState?: ContinuationState | null,
    sessionIdOverride?: string,
  ): Promise<{
    success: boolean
    error?: string
    finalText?: string
    cancelled?: boolean
    taskId?: ExecutionHostResult['taskId']
    usedTools?: ExecutionHostResult['usedTools']
    taskType?: ExecutionHostResult['taskType']
    interactionState?: ExecutionHostResult['interactionState']
    taskProjectionId?: ExecutionHostResult['taskProjectionId']
    executionDiagnostics?: ExecutionHostResult['executionDiagnostics']
    projectionTruth?: ExecutionHostResult['projectionTruth']
    terminalReason?: ExecutionHostResult['terminalReason']
  }> {
    const effectiveRequestId = requestId || randomUUID()
    const effectiveSessionId = sessionIdOverride || sessionId
    const internalKey = this.toInternalSessionKey(agent, effectiveSessionId)
    const taskKey = this.toTaskKey(agent, effectiveSessionId)
    this.descriptors.set(internalKey, { agent, sessionId })
    this.sessions.setState(taskKey, 'queued')
    this.activeRunIds.set(taskKey, effectiveRequestId)
    if (systemPrompt) {
      this.sdkEngine.setSystemPrompt(internalKey, systemPrompt)
    }
    try {
      const result = await this.sdkEngine.sendMessage(internalKey, message, effectiveRequestId, {
        taskId,
        publicSessionId: sessionId,
        requestEnvelope,
        intentClassification,
        budget,
        budgetState,
        taskBudgetRuntime,
        continuationIntent,
        continuationState,
      })
      if (!result.success) {
        this.sessions.setState(taskKey, 'failed', result.error)
      }
      return result
    } finally {
      if (this.activeRunIds.get(taskKey) === effectiveRequestId) {
        this.activeRunIds.delete(taskKey)
      }
      await this.drainRunCleanup(effectiveRequestId)
    }
  }

  async sendAndCollect(
    agent: string,
    message: string | MultimodalBlock[],
    sessionId?: string,
    requestId?: string,
    taskId?: string,
    systemPrompt?: string,
    requestEnvelope?: RequestEnvelope,
    intentClassification?: IntentClassification,
    budget?: ExecutionHostRequest['budget'],
    budgetState?: ExecutionHostRequest['budgetState'],
    taskBudgetRuntime?: ExecutionHostRequest['taskBudgetRuntime'],
    continuationIntent?: ContinuationIntent | null,
    continuationState?: ContinuationState | null,
    sessionIdOverride?: string,
  ): Promise<SendAndCollectResult> {
    const collector = createScopedRunCollector({ agent, sessionId, requestId })
    const cleanupFns: Array<() => void> = []

    this.on('output', collector.handleOutput)
    this.on('status', collector.handleStatus)
    this.on('error', collector.handleError)
    cleanupFns.push(() => this.off('output', collector.handleOutput))
    cleanupFns.push(() => this.off('status', collector.handleStatus))
    cleanupFns.push(() => this.off('error', collector.handleError))

    let executionDiagnostics: ExecutionHostResult['executionDiagnostics'] | null = null
    let resolvedTaskId: ExecutionHostResult['taskId']
    let taskType: ExecutionHostResult['taskType']
    let interactionState: ExecutionHostResult['interactionState']
    let taskProjectionId: ExecutionHostResult['taskProjectionId']
    let projectionTruth: ExecutionHostResult['projectionTruth']
    let terminalReason: ExecutionHostResult['terminalReason']
    let usedToolsFromExecution: string[] | null = null
    const sendResultPromise = this.send(
      agent,
      message,
      sessionId,
      requestId,
      taskId,
      systemPrompt,
      requestEnvelope,
      intentClassification,
      budget,
      budgetState,
      taskBudgetRuntime,
      continuationIntent,
      continuationState,
      sessionIdOverride,
    ).then((result) => {
      executionDiagnostics = result.executionDiagnostics || null
      resolvedTaskId = result.taskId
      taskType = result.taskType
      interactionState = result.interactionState
      taskProjectionId = result.taskProjectionId
      projectionTruth = result.projectionTruth
      terminalReason = result.terminalReason
      usedToolsFromExecution = result.usedTools || null
      if (!result.success) {
        collector.handleError({
          agent,
          sessionId,
          runId: requestId,
          error: result.error || 'Agent execution failed',
        })
        collector.handleStatus({
          agent,
          sessionId,
          runId: requestId,
          status: 'error',
        })
      }
      return result
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      collector.handleError({
        agent,
        sessionId,
        runId: requestId,
        error: message || 'Agent execution failed',
      })
      collector.handleStatus({
        agent,
        sessionId,
        runId: requestId,
        status: 'error',
      })
      return null
    })

    try {
      const firstResult = await Promise.race([
        collector.result.then((result) => ({ source: 'collector' as const, result })),
        sendResultPromise.then((result) => ({ source: 'send' as const, result })),
      ])
      if (firstResult.source === 'send') {
        const executionResult = firstResult.result
        if (executionResult) {
          return {
            success: executionResult.success,
            finalText: executionResult.finalText || '',
            cancelled: Boolean(executionResult.cancelled),
            usedTools: usedToolsFromExecution || executionResult.usedTools || [],
            error: executionResult.error,
            taskId: resolvedTaskId || executionResult.taskId || undefined,
            taskType: taskType || executionResult.taskType,
            interactionState: interactionState || executionResult.interactionState,
            taskProjectionId: taskProjectionId || executionResult.taskProjectionId,
            executionDiagnostics: executionDiagnostics || executionResult.executionDiagnostics || null,
            projectionTruth: projectionTruth || executionResult.projectionTruth,
            terminalReason: terminalReason || executionResult.terminalReason || (executionResult.cancelled ? 'cancelled_runtime' : null),
          }
        }
        return {
          success: false,
          finalText: '',
          cancelled: false,
          usedTools: [],
          error: 'Agent execution failed',
        }
      }
      const result = firstResult.result
      await sendResultPromise
      return {
        ...result,
        usedTools: usedToolsFromExecution || result.usedTools,
        taskId: resolvedTaskId || undefined,
        taskType,
        interactionState,
        taskProjectionId,
        executionDiagnostics,
        projectionTruth,
        terminalReason,
      }
    } finally {
      while (cleanupFns.length > 0) {
        cleanupFns.pop()?.()
      }
    }
  }

  async executeAndCollect(request: ExecutionHostRequest): Promise<ExecutionHostResult> {
    const result = await this.sendAndCollect(
      request.agent,
      request.message as string | MultimodalBlock[],
      request.sessionId,
      request.requestId,
      request.taskId,
      request.systemPrompt,
      request.requestEnvelope,
      request.intentClassification,
      request.budget,
      request.budgetState,
      request.taskBudgetRuntime,
      request.continuationIntent,
      request.continuationState,
      request.sessionIdOverride,
    )
    return {
      success: result.success,
      finalText: result.finalText,
      cancelled: result.cancelled,
      usedTools: result.usedTools,
      error: result.error,
      taskId: result.taskId,
      budgetState: request.budgetState,
      taskBudgetRuntime: result.executionDiagnostics?.taskBudgetRuntime || request.taskBudgetRuntime,
      taskType: result.taskType,
      interactionState: result.interactionState,
      taskProjectionId: result.taskProjectionId,
      executionDiagnostics: result.executionDiagnostics || null,
      projectionTruth: result.projectionTruth || null,
      terminalReason: result.terminalReason || null,
    }
  }

  newSession(agent: string, sessionId?: string): void {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.descriptors.set(internalKey, { agent, sessionId })
    this.domainAdapterEngine.newSession(internalKey)
    this.sdkEngine.newSession(internalKey)
    this.sessions.setState(this.toTaskKey(agent, sessionId), 'done')
  }

  registerRunCleanup(runId: string, cleanup: RunCleanupCallback): void {
    this.runCleanupRegistry.register(runId, cleanup)
  }

  async drainRunCleanup(runId: string, timeoutMs = 1_500): Promise<void> {
    try {
      await this.runCleanupRegistry.drain(runId, timeoutMs)
    } catch (error) {
      console.warn('[ReadyAgentOrchestrator] Run cleanup failed:', error)
    }
  }

  kill(agent: string, sessionId?: string): void {
    const taskKey = this.toTaskKey(agent, sessionId)
    const runId = this.activeRunIds.get(taskKey)
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.domainAdapterEngine.stopGeneration(internalKey)
    this.sdkEngine.stopGeneration(internalKey)
    this.sessions.setState(taskKey, 'cancelled')
    if (runId) {
      this.activeRunIds.delete(taskKey)
      void this.drainRunCleanup(runId)
    }
  }

  getSessionManager(): AgentSessionManager {
    return this.sessions
  }
}
