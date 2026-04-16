import { EventEmitter } from 'events'
import { DirectChatEngine, type MultimodalBlock } from '../claude-bridge/direct-chat'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from './sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ExecutionHostRequest, ExecutionHostResult } from './run-contracts'
import type { IntentClassification } from './intent-classifier'
import type { RequestEnvelope } from './request-envelope'
import { AgentSessionManager } from './session-manager'
import { createScopedRunCollector, type SendAndCollectResult } from './run-collector'

interface SessionDescriptor {
  agent: string
  sessionId?: string
}

export class ClaudeSdkOrchestrator extends EventEmitter {
  private readonly engine: DirectChatEngine
  private readonly sessions: AgentSessionManager
  private readonly descriptors = new Map<string, SessionDescriptor>()

  constructor(options?: { browserController?: BrowserController; sidecarManager?: SidecarManager }) {
    super()
    this.engine = new DirectChatEngine()
    this.sessions = new AgentSessionManager()

    if (options?.browserController) {
      this.engine.setBrowserController(options.browserController)
    }

    if (options?.sidecarManager) {
      this.engine.setSidecarManager(options.sidecarManager)
    }

    this.engine.on('output', (payload) => {
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

    this.engine.on('status', (payload) => {
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

    this.engine.on('error', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      this.sessions.setState(taskKey, 'failed', payload.error)
      this.emit('error', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    this.engine.on('toolAction', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      this.emit('toolAction', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })
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
    this.engine.setBrowserController(controller)
  }

  hasBrowserController(): boolean {
    return this.engine.hasBrowserController()
  }

  setSidecarManager(manager: SidecarManager): void {
    this.engine.setSidecarManager(manager)
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.engine.setRuntime(runtime)
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
    this.engine.setRendererToolActionRequester(requester)
  }

  async send(
    agent: string,
    message: string | MultimodalBlock[],
    sessionId?: string,
    requestId?: string,
    systemPrompt?: string,
    requestEnvelope?: RequestEnvelope,
    intentClassification?: IntentClassification,
    budget?: ExecutionHostRequest['budget'],
    budgetState?: ExecutionHostRequest['budgetState'],
  ): Promise<{
    success: boolean
    error?: string
    taskType?: ExecutionHostResult['taskType']
    interactionState?: ExecutionHostResult['interactionState']
    taskProjectionId?: ExecutionHostResult['taskProjectionId']
    executionDiagnostics?: ExecutionHostResult['executionDiagnostics']
  }> {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    const taskKey = this.toTaskKey(agent, sessionId)
    this.descriptors.set(internalKey, { agent, sessionId })
    this.sessions.setState(taskKey, 'queued')
    if (systemPrompt) {
      this.engine.setSystemPrompt(internalKey, systemPrompt)
    }
    const result = await this.engine.sendMessage(internalKey, message, requestId, {
      requestEnvelope,
      intentClassification,
      budget,
      budgetState,
    })
    if (!result.success) {
      this.sessions.setState(taskKey, 'failed', result.error)
    }
    return result
  }

  async sendAndCollect(
    agent: string,
    message: string | MultimodalBlock[],
    sessionId?: string,
    requestId?: string,
    systemPrompt?: string,
    requestEnvelope?: RequestEnvelope,
    intentClassification?: IntentClassification,
    budget?: ExecutionHostRequest['budget'],
    budgetState?: ExecutionHostRequest['budgetState'],
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
    let taskType: ExecutionHostResult['taskType']
    let interactionState: ExecutionHostResult['interactionState']
    let taskProjectionId: ExecutionHostResult['taskProjectionId']
    void this.send(
      agent,
      message,
      sessionId,
      requestId,
      systemPrompt,
      requestEnvelope,
      intentClassification,
      budget,
      budgetState,
    ).then((result) => {
      executionDiagnostics = result.executionDiagnostics || null
      taskType = result.taskType
      interactionState = result.interactionState
      taskProjectionId = result.taskProjectionId
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
    })

    try {
      const result = await collector.result
      return {
        ...result,
        taskType,
        interactionState,
        taskProjectionId,
        executionDiagnostics,
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
      request.systemPrompt,
      request.requestEnvelope,
      request.intentClassification,
      request.budget,
      request.budgetState,
    )
    return {
      success: result.success,
      finalText: result.finalText,
      cancelled: result.cancelled,
      usedTools: result.usedTools,
      error: result.error,
      budgetState: request.budgetState,
      taskType: result.taskType,
      interactionState: result.interactionState,
      taskProjectionId: result.taskProjectionId,
      executionDiagnostics: result.executionDiagnostics || null,
    }
  }

  newSession(agent: string, sessionId?: string): void {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.descriptors.set(internalKey, { agent, sessionId })
    this.engine.newSession(internalKey)
    this.sessions.setState(this.toTaskKey(agent, sessionId), 'done')
  }

  kill(agent: string, sessionId?: string): void {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.engine.stopGeneration(internalKey)
    this.sessions.setState(this.toTaskKey(agent, sessionId), 'cancelled')
  }

  getSessionManager(): AgentSessionManager {
    return this.sessions
  }
}
