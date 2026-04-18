import {
  filterAllowedToolNamesByPrefixes,
  readToolProjectionPatch,
  type DomainAdapter,
  type DomainAdapterProjection,
  type DomainAdapterPrepareResult,
} from './domain-adapter'
import type { RunProjectionPatch } from './run-contracts'

const TOOL_PREFIXES = ['skill_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走 skill 执行路径。优先使用 skill_* 工具推进，不要退回无关的通用工具。'

interface SkillAdapterState {
  latestProjectionPatch: Record<string, unknown> | null
}

function createState(domainState: unknown): SkillAdapterState {
  if (domainState && typeof domainState === 'object' && 'latestProjectionPatch' in domainState) {
    return domainState as SkillAdapterState
  }
  return { latestProjectionPatch: null }
}

function normalizeWaitingFor(value: unknown): RunProjectionPatch['waitingFor'] {
  return value === 'input'
    || value === 'confirmation'
    || value === 'agent_result'
    || value === 'background'
    || value === 'none'
    ? value
    : 'none'
}

function normalizeResumableActions(value: unknown): Array<'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is 'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none' =>
    item === 'continue'
    || item === 'retry'
    || item === 'open_artifact'
    || item === 'cancel'
    || item === 'none',
  )
}

function buildProjectionFromPatch(latestProjectionPatch: Record<string, unknown>): DomainAdapterProjection {
  const waitingFor = normalizeWaitingFor(latestProjectionPatch.waitingFor)
  const blockedReason = typeof latestProjectionPatch.blockedReason === 'string'
    ? latestProjectionPatch.blockedReason
    : latestProjectionPatch.blockedReason === null
      ? null
      : null
  const summary =
    typeof latestProjectionPatch.taskSummary === 'string' && latestProjectionPatch.taskSummary.trim()
      ? latestProjectionPatch.taskSummary
      : typeof latestProjectionPatch.message === 'string' && latestProjectionPatch.message.trim()
        ? latestProjectionPatch.message
        : blockedReason || '技能执行进行中'
  const resumableActions = normalizeResumableActions(latestProjectionPatch.resumableActions)
  return {
    phase: waitingFor === 'none' && !blockedReason ? 'done' : 'blocked',
    summary,
    waitingFor,
    resumableActions,
    blockedReason,
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
      domainState: { latestProjectionPatch: null } satisfies SkillAdapterState,
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: params.domainState }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): ReturnType<DomainAdapter['applyResult']> {
    const state = createState(params.domainState)
    if (params.phase === 'tool_batch') {
      for (const executedTool of params.toolBatch?.executedTools || []) {
        if (!executedTool.name.startsWith('skill_')) continue
        const projectionPatch = readToolProjectionPatch(executedTool.result)
        if (!projectionPatch) continue
        state.latestProjectionPatch = {
          ...(state.latestProjectionPatch || {}),
          ...projectionPatch,
        }
      }
      return { domainState: state }
    }

    if (
      (params.phase === 'no_tool_call' || params.phase === 'budget_limit')
      && state.latestProjectionPatch
    ) {
      return {
        domainState: state,
        projection: buildProjectionFromPatch(state.latestProjectionPatch),
      }
    }

    return { domainState: state }
  }

  buildProjectionPatch(params: Parameters<DomainAdapter['buildProjectionPatch']>[0]): Record<string, unknown> | null {
    const state = createState(params.domainState)
    if (!state.latestProjectionPatch) return null
    return {
      ...state.latestProjectionPatch,
      module: 'skill',
      taskSummary: params.projection.summary,
      waitingFor: params.projection.waitingFor ?? normalizeWaitingFor(state.latestProjectionPatch.waitingFor),
      resumableActions: params.projection.resumableActions ?? normalizeResumableActions(state.latestProjectionPatch.resumableActions),
      blockedReason:
        typeof params.projection.blockedReason === 'string'
          ? params.projection.blockedReason
          : params.projection.blockedReason === null
            ? null
            : state.latestProjectionPatch.blockedReason ?? null,
    }
  }
}
