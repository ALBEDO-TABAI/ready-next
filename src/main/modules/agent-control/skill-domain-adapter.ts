import {
  filterAllowedToolNamesByPrefixes,
  readExecutedToolPayload,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'

const TOOL_PREFIXES = ['skill_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走 skill 执行路径。优先使用 skill_* 工具推进，不要退回无关的通用工具。'
const SKILL_TASK_TITLE_PREFIX = '技能执行 · '

type SkillWaitingFor = 'none' | 'input' | 'confirmation' | 'agent_result' | 'background'
type SkillResumableAction = 'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'

interface SkillAdapterState {
  skillId: string | null
  taskTitle: string | null
  taskSummary: string | null
  executionId: string | null
  currentStepId: string | null
  blocker: {
    type: string | null
    message: string | null
  } | null
  steps: Array<Record<string, unknown>>
  recentArtifacts: Array<Record<string, unknown>>
  waitingFor: SkillWaitingFor
  resumableActions: SkillResumableAction[]
  status: 'idle' | 'running' | 'blocked' | 'done'
}

function createInitialSkillState(): SkillAdapterState {
  return {
    skillId: null,
    taskTitle: null,
    taskSummary: null,
    executionId: null,
    currentStepId: null,
    blocker: null,
    steps: [],
    recentArtifacts: [],
    waitingFor: 'none',
    resumableActions: ['cancel'],
    status: 'idle',
  }
}

function normalizeWaitingFor(value: unknown): SkillWaitingFor {
  if (value === 'input' || value === 'confirmation' || value === 'agent_result' || value === 'background') {
    return value
  }
  return 'none'
}

function normalizeResumableActions(value: unknown, waitingFor: SkillWaitingFor): SkillResumableAction[] {
  const allowed: SkillResumableAction[] = ['continue', 'retry', 'open_artifact', 'cancel', 'none']
  const normalized = Array.isArray(value)
    ? value
      .map((item) => String(item || '').trim())
      .filter((item): item is SkillResumableAction => allowed.includes(item as SkillResumableAction))
    : []
  if (normalized.length > 0) {
    return normalized
  }
  return waitingFor === 'none' ? ['none'] : ['continue', 'cancel']
}

function deriveSkillId(taskTitle: string | null): string | null {
  if (!taskTitle || !taskTitle.startsWith(SKILL_TASK_TITLE_PREFIX)) return null
  const suffix = taskTitle.slice(SKILL_TASK_TITLE_PREFIX.length).trim()
  return suffix || null
}

function deriveSkillStatus(state: {
  waitingFor: SkillWaitingFor
  steps: Array<Record<string, unknown>>
  blockedReason: string | null
}): SkillAdapterState['status'] {
  if (state.waitingFor !== 'none' || state.blockedReason) return 'blocked'
  const stepStatuses = state.steps
    .map((step) => String(step.status || '').trim().toLowerCase())
    .filter(Boolean)
  if (stepStatuses.some((status) => status === 'running' || status === 'pending')) return 'running'
  if (stepStatuses.some((status) => status === 'done' || status === 'completed' || status === 'success')) return 'done'
  return 'running'
}

function toInteractionState(waitingFor: SkillWaitingFor) {
  if (waitingFor === 'confirmation') return 'awaiting_confirmation' as const
  if (waitingFor === 'input' || waitingFor === 'agent_result') return 'awaiting_clarification' as const
  return null
}

function toSkillProjection(state: SkillAdapterState) {
  if (!state.taskTitle || !state.taskSummary) return null
  const phase: 'blocked' | 'done' = state.waitingFor === 'none' ? 'done' : 'blocked'
  return {
    phase,
    summary: state.taskSummary,
    waitingFor: state.waitingFor,
    resumableActions: state.resumableActions,
    blockedReason: state.blocker?.message || null,
  }
}

export class SkillDomainAdapter implements DomainAdapter {
  readonly id = 'skill'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'skill'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    return {
      allowedToolNames: filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES),
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createInitialSkillState(),
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: params.domainState }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): ReturnType<DomainAdapter['applyResult']> {
    const previousState = (params.domainState as SkillAdapterState | null) || createInitialSkillState()
    if (params.phase !== 'tool_batch') {
      return { domainState: previousState }
    }

    const latestSkillTool = [...(params.toolBatch?.executedTools || [])]
      .reverse()
      .find((executedTool) => executedTool.toolName.startsWith('skill_'))
    if (!latestSkillTool) {
      return { domainState: previousState }
    }

    const payload = readExecutedToolPayload(latestSkillTool)
    const taskTitle = typeof payload?.taskTitle === 'string'
      ? payload.taskTitle
      : previousState.taskTitle
    const taskSummary = typeof payload?.taskSummary === 'string'
      ? payload.taskSummary
      : typeof payload?.message === 'string'
        ? payload.message
        : latestSkillTool.resultText || previousState.taskSummary
    const waitingFor = normalizeWaitingFor(payload?.waitingFor)
    const taskContinuation = payload?.taskContinuation && typeof payload.taskContinuation === 'object'
      ? payload.taskContinuation as Record<string, unknown>
      : null
    const blockerType = typeof taskContinuation?.blockerType === 'string'
      ? taskContinuation.blockerType
      : waitingFor === 'none'
        ? null
        : waitingFor
    const blockedReason = typeof payload?.blockedReason === 'string'
      ? payload.blockedReason
      : waitingFor !== 'none'
        ? taskSummary
        : null
    const nextState: SkillAdapterState = {
      skillId: deriveSkillId(taskTitle),
      taskTitle,
      taskSummary,
      executionId: typeof taskContinuation?.executionId === 'string'
        ? taskContinuation.executionId
        : previousState.executionId,
      currentStepId:
        typeof payload?.currentStepId === 'string'
          ? payload.currentStepId
          : previousState.currentStepId,
      blocker: {
        type: blockerType,
        message: blockedReason,
      },
      steps: Array.isArray(payload?.steps)
        ? payload.steps.map((step) => ({ ...(step as Record<string, unknown>) }))
        : previousState.steps,
      recentArtifacts: Array.isArray((payload as Record<string, unknown> | null)?.recentArtifacts)
        ? ((payload as Record<string, unknown>).recentArtifacts as Array<Record<string, unknown>>).map((artifact) => ({ ...artifact }))
        : previousState.recentArtifacts,
      waitingFor,
      resumableActions: normalizeResumableActions(payload?.resumableActions, waitingFor),
      status: deriveSkillStatus({
        waitingFor,
        steps: Array.isArray(payload?.steps)
          ? payload.steps as Array<Record<string, unknown>>
          : previousState.steps,
        blockedReason,
      }),
    }
    const projection = toSkillProjection(nextState)

    return {
      domainState: nextState,
      interactionState: toInteractionState(waitingFor),
      projection,
    }
  }

  buildProjectionPatch(params: Parameters<DomainAdapter['buildProjectionPatch']>[0]): Record<string, unknown> | null {
    const state = (params.domainState as SkillAdapterState | null) || createInitialSkillState()
    if (!state.taskTitle || !state.taskSummary) {
      return null
    }

    return {
      module: 'skill',
      message: params.projection.summary,
      taskTitle: state.taskTitle,
      taskSummary: state.taskSummary,
      steps: state.steps,
      currentStepId: state.currentStepId,
      waitingFor: state.waitingFor,
      resumableActions: state.resumableActions,
      blockedReason: state.blocker?.message || params.projection.blockedReason || null,
      taskContinuation: state.executionId
        ? {
          executionId: state.executionId,
          stepId: state.currentStepId,
          blockerType: state.blocker?.type || null,
        }
        : null,
      recentArtifacts: state.recentArtifacts,
    }
  }
}
