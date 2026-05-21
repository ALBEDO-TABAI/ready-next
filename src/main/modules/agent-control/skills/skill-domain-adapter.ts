import {
  filterAllowedToolNamesByPrefixes,
  logPrefixNarrowing,
  readToolProjectionPatch,
  type DomainAdapter,
  type DomainAdapterProjection,
  type DomainAdapterPrepareResult,
} from '../domain-adapters/domain-adapter'
import type { RunProjectionPatch } from '../contracts/run-contracts'

// R2: Domain adapter prefix narrowing is a SECOND allowedToolNames gate on top
// of run-capability-controller's bundle. When route.executor === 'skill', this
// adapter narrows allowedToolNames to the prefixes below; any tool outside the
// list is stripped even if it made it into preparedRunCapabilities.allowedToolNames.
//
// The skill executor must keep memory_* and session_* tools available so the
// model can read cross-session context before deciding which skill action to
// call. Everything else (document_/browser_/calendar_/rss_/feishu_) is stripped
// — that's intentional domain isolation, not a bug.
//
// filterAllowedToolNamesByPrefixes returns null (= unrestricted) when the
// filtered list is empty, so an allowedToolNames input that happens to contain
// zero skill_*/memory_*/session_* tools falls through to passthrough rather
// than locking the adapter into an empty list.
//
// D3 retry widening: when isRetryOnlyTurn === true (bare "继续/重试" intent),
// we widen the prefix list to also keep file_*/document_* so the agent can
// rediscover what was happening before re-attempting. Without this, retry
// turns drop those tools and the agent has no way to inspect prior state.
const BASE_TOOL_PREFIXES = ['skill_', 'memory_', 'session_'] as const
const RETRY_INTENT_TOOL_PREFIXES = [
  ...BASE_TOOL_PREFIXES,
  'file_',
  'document_',
] as const
const INSTRUCTION = '系统执行器：本轮走 skill 执行路径。优先使用 skill_* 工具推进，不要退回无关的通用工具。'

/**
 * skill-resume D2 — when the prefix narrowing actually drops tools, append a
 * note to the system instruction so the LLM knows which tools are unavailable
 * this turn (instead of trying them and getting silent rejections).
 *
 * Returns the original INSTRUCTION when nothing was dropped, OR a
 * concatenated INSTRUCTION + addendum listing up to 5 dropped names.
 */
export function buildSkillDomainInstruction(
  inputAllowed: ReadonlyArray<string> | null | undefined,
  outputAllowed: ReadonlyArray<string> | null | undefined,
  frameSteering?: {
    preferredToolNames?: string[] | null
    systemReminder?: string | null
  } | null,
): string {
  const sections = [INSTRUCTION]
  const preferredTypedAction = (frameSteering?.preferredToolNames || [])
    .find((name) => name.startsWith('skill_') && name !== 'skill_run_shell')
  if (frameSteering?.systemReminder || preferredTypedAction) {
    sections.push([
      frameSteering?.systemReminder || `系统补充：当前 TurnFrame 已确认应优先调用 typed skill action ${preferredTypedAction}。`,
      preferredTypedAction ? `优先工具：${preferredTypedAction}` : '',
      'skill_run_shell 只用于必要诊断，不要用 shell 反复读取同一份状态来替代 typed skill action。',
    ].filter(Boolean).join('\n'))
  }
  if (!inputAllowed || inputAllowed.length === 0) return sections.join('\n\n')
  const kept = new Set(outputAllowed || [])
  const dropped = inputAllowed.filter((name) => !kept.has(name))
  if (dropped.length === 0) return sections.join('\n\n')
  const sample = dropped.slice(0, 5).join('、')
  const more = dropped.length > 5 ? `（共 ${dropped.length} 个）` : ''
  sections.push(`⚠️ 本回合限定 skill domain，已暂停 ${dropped.length} 个工具${more}：${sample}。如确实需要 file_search/document_* 等通用工具，请用普通指令（不带"继续/重试"等关键词）让系统切回通用域。`)
  return sections.join('\n\n')
}

interface SkillAdapterState {
  latestProjectionPatch: Record<string, unknown> | null
  dispatchedAt: string | null
}

function createState(domainState: unknown): SkillAdapterState {
  if (domainState && typeof domainState === 'object' && 'latestProjectionPatch' in domainState) {
    const record = domainState as SkillAdapterState
    return {
      latestProjectionPatch: record.latestProjectionPatch ?? null,
      dispatchedAt: record.dispatchedAt ?? null,
    }
  }
  return { latestProjectionPatch: null, dispatchedAt: null }
}

function hasAnyDomainTool(allowedToolNames: string[] | null | undefined): boolean {
  if (!allowedToolNames || allowedToolNames.length === 0) return false
  return allowedToolNames.some((name) => name.startsWith('skill_'))
}

function normalizeWaitingFor(value: unknown): RunProjectionPatch['waitingFor'] {
  return value === 'input'
    || value === 'confirmation'
    || value === 'agent_result'
    || value === 'clarification'
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

  contributePromptFragment(): ReturnType<DomainAdapter['contributePromptFragment']> {
    return null
  }

  arbitrateRunCapabilities(
    _params: Parameters<DomainAdapter['arbitrateRunCapabilities']>[0],
  ): ReturnType<DomainAdapter['arbitrateRunCapabilities']> {
    return null
  }

  decorateUserText(
    text: string,
    _params: Parameters<DomainAdapter['decorateUserText']>[1],
  ): string {
    return text
  }

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    if (params.route.executor !== 'skill') return false
    const intent = params.executionIntentContext?.intentClassification
    return !(intent?.primaryDomain === 'document' && !intent.mentionedDomains.includes('skill'))
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    const prefixes = params.isRetryOnlyTurn ? RETRY_INTENT_TOOL_PREFIXES : BASE_TOOL_PREFIXES
    const narrowed = filterAllowedToolNamesByPrefixes(params.allowedToolNames, prefixes as unknown as string[])
    if (params.host?.log) {
      logPrefixNarrowing(params.host.log, 'skill', params.allowedToolNames, narrowed, prefixes as unknown as string[])
    }
    // skill-resume D2: dynamic instruction tells LLM which tools were dropped
    // this turn, so it doesn't blindly retry them and waste iterations.
    const instruction = buildSkillDomainInstruction(params.allowedToolNames, narrowed, params.turnFrameSteering)
    return {
      allowedToolNames: narrowed,
      sessionMessages: params.hasTools ? [{ role: 'user', content: instruction }] : [],
      domainState: { latestProjectionPatch: null, dispatchedAt: null } satisfies SkillAdapterState,
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    const state = createState(params.domainState)
    if (params.hasTools && !hasAnyDomainTool(params.allowedToolNames)) {
      return {
        domainState: state,
        projection: {
          phase: 'done',
          summary: '本轮没有可用的 skill 工具',
          waitingFor: 'none',
          resumableActions: ['none'],
          blockedReason: null,
        },
        finish: { status: 'done', success: true },
      }
    }
    return {
      domainState: {
        ...state,
        dispatchedAt: state.dispatchedAt || new Date().toISOString(),
      },
    }
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
    if (!state.latestProjectionPatch) {
      if (!params.projection) return null
      return {
        module: 'skill',
        taskTitle: 'Skill 任务',
        taskSummary: params.projection.summary,
        waitingFor: params.projection.waitingFor ?? 'none',
        resumableActions: params.projection.resumableActions ?? [],
        blockedReason: params.projection.blockedReason ?? null,
      }
    }
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
