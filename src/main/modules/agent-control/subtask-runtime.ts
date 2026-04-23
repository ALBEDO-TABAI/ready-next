import type { ProjectionTruthSnapshot, SubtaskRunRequest, SubtaskRunResult, TurnTranscriptEvent } from './run-contracts'
import { createWorkerSessionIdentity } from './worker-session'
import { buildWorkerChildProjectionPatch } from './worker-projection'
import type { ScopeRunEventPayload } from './types'

interface SubtaskRuntimeDeps {
  publishScopeRunEvent: (payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null) => void | Promise<void>
}

function buildProjectionTruthSnapshot(events: TurnTranscriptEvent[]): ProjectionTruthSnapshot | null {
  let projectionPatch: Record<string, unknown> | null = null
  for (const event of events) {
    if (event.kind !== 'structured_payload' || !event.projectionPatch) continue
    projectionPatch = {
      ...(projectionPatch || {}),
      ...event.projectionPatch,
    }
  }
  if (!projectionPatch && events.length === 0) return null
  return {
    projectionPatch,
    transcriptEvents: events,
  }
}

export class SubtaskRuntime {
  constructor(private readonly deps: SubtaskRuntimeDeps) {}

  async runInlineWorker(request: SubtaskRunRequest): Promise<SubtaskRunResult> {
    if (!request.runInlineWorker) {
      throw new Error('runInlineWorker requires an inline worker callback')
    }

    const identity = createWorkerSessionIdentity({
      scopeId: request.scope.id,
      parentTaskId: request.parentTaskId,
      parentStepId: request.parentStepId,
    })
    const truthEvents: TurnTranscriptEvent[] = []
    const pendingPublishes: Promise<void>[] = []
    const pushProjectionTruth = (projectionPatch: Record<string, unknown> | null) => {
      if (!projectionPatch) return
      truthEvents.push({
        kind: 'structured_payload',
        projectionPatch,
      })
    }
    const publish = async (params: {
      phase: ScopeRunEventPayload['phase']
      taskSummary: string
      steps?: ScopeRunEventPayload['steps']
      currentStepId?: string | null
      waitingFor?: ScopeRunEventPayload['waitingFor']
      resumableActions?: ScopeRunEventPayload['resumableActions']
      blockedReason?: string | null
      interactionState?: ScopeRunEventPayload['interactionState']
      recentArtifacts?: ScopeRunEventPayload['artifactRefs']
      error?: string | null
    }): Promise<void> => {
      const projectionPatch = buildWorkerChildProjectionPatch({
        module: request.module || 'system',
        taskTitle: request.taskTitle,
        taskSummary: params.taskSummary,
        steps: params.steps || [],
        currentStepId: params.currentStepId || null,
        waitingFor: params.waitingFor || 'none',
        resumableActions: params.resumableActions || ['cancel'],
        blockedReason: params.blockedReason || null,
        interactionState: params.interactionState || 'running',
        recentArtifacts: params.recentArtifacts || [],
      })
      pushProjectionTruth(projectionPatch)
      await this.deps.publishScopeRunEvent({
        type: params.phase === 'planning' ? 'started' : 'updated',
        scopeId: request.scope.id,
        agent: request.scope.agent,
        runId: identity.workerSessionId,
        taskId: identity.taskId,
        parentTaskId: request.parentTaskId,
        parentStepId: request.parentStepId,
        phase: params.phase,
        module: request.module,
        taskTitle: request.taskTitle,
        taskSummary: params.taskSummary,
        taskType: request.taskType,
        interactionState: params.interactionState || 'running',
        steps: params.steps,
        currentStepId: params.currentStepId || null,
        waitingFor: params.waitingFor || 'none',
        resumableActions: params.resumableActions || ['cancel'],
        blockedReason: params.blockedReason || null,
        error: params.error || undefined,
        recentArtifacts: params.recentArtifacts || [],
        taskProjectionId: identity.taskId,
        timestamp: new Date().toISOString(),
      }, buildProjectionTruthSnapshot(truthEvents))
    }

    await publish({
      phase: 'planning',
      taskSummary: request.initialSummary || `准备执行 ${request.taskTitle}`,
      steps: request.initialSteps || [],
      currentStepId: request.initialSteps?.[0]?.id || null,
      resumableActions: ['cancel'],
    })

    try {
      const result = await request.runInlineWorker({
        identity,
        emitUpdate: (payload) => {
          const publishPromise = publish({
            phase: payload.phase || 'tool_running',
            taskSummary: payload.taskSummary || request.initialSummary || `正在执行 ${request.taskTitle}`,
            steps: payload.steps,
            currentStepId: payload.currentStepId || null,
            waitingFor: payload.waitingFor || 'none',
            resumableActions: payload.resumableActions || ['cancel'],
            blockedReason: payload.blockedReason || null,
            interactionState: payload.interactionState || 'running',
            recentArtifacts: payload.recentArtifacts,
            error: payload.error || null,
          })
          pendingPublishes.push(publishPromise)
        },
      })

      await Promise.all(pendingPublishes.splice(0))
      await publish({
        phase: 'done',
        taskSummary: result.taskSummary || result.finalText || `${request.taskTitle}已完成`,
        steps: result.steps || request.initialSteps || [],
        currentStepId: result.currentStepId || null,
        waitingFor: result.waitingFor || 'none',
        resumableActions: result.resumableActions || ['none'],
        blockedReason: result.blockedReason || null,
        interactionState: result.interactionState || 'running',
        recentArtifacts: result.recentArtifacts || [],
      })
      const finalProjectionTruth = result.projectionTruth || buildProjectionTruthSnapshot(truthEvents)
      return {
        taskId: identity.taskId,
        status: 'done',
        finalText: result.finalText || '',
        projectionTruth: finalProjectionTruth,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await Promise.all(pendingPublishes.splice(0))
      await publish({
        phase: 'error',
        taskSummary: message,
        steps: request.initialSteps || [],
        waitingFor: 'none',
        resumableActions: ['cancel'],
        blockedReason: message,
        interactionState: 'running',
        error: message,
      })
      return {
        taskId: identity.taskId,
        status: 'error',
        finalText: '',
        error: message,
        projectionTruth: buildProjectionTruthSnapshot(truthEvents),
      }
    }
  }
}
