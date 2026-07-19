import {
  filterAllowedToolNamesByPrefixes,
  logPrefixNarrowing,
  readStructuredToolResultRecord,
  type CoordinatorCapabilityArbitration,
  type CoordinatorPromptFragment,
  type CoordinatorTextDecorationPhase,
  type DomainAdapter,
  type DomainAdapterApplyParams,
  type DomainAdapterApplyResult,
  type DomainAdapterDispatchParams,
  type DomainAdapterDispatchResult,
  type DomainAdapterPrepareParams,
  type DomainAdapterPrepareResult,
  type DomainAdapterProjectionParams,
  type DomainAdapterSelectionContext,
} from './domain-adapters/domain-adapter'
import { isMapSemanticIntentActive } from './map-semantic-intent'
import type { ScopeRunTaskStep } from './contracts/types'

const BASE_TOOL_PREFIXES = ['map_', 'ask_user_questions', 'use_browser']
const DOCUMENT_TOOL_PREFIXES = ['document_', 'present_file']
const RESEARCH_TOOL_PREFIXES = ['web_search', 'web_fetch', 'web_clip_url', 'present_file']
const INSTRUCTION = [
  '系统执行器：本轮走地图路线规划路径。',
  '优先使用 map_plan_route 获取路线、顺路地点、耗时和 artifact。',
  '不要暴露高德 key 或高德静态地图 URL；地址歧义时使用 ask_user_questions 反问用户。',
].join('\n')

interface MapAdapterState {
  steps: ScopeRunTaskStep[]
  currentStepId: string | null
  taskSummary: string | null
}

function createState(domainState: unknown): MapAdapterState {
  if (
    domainState
    && typeof domainState === 'object'
    && Array.isArray((domainState as MapAdapterState).steps)
  ) {
    const state = domainState as MapAdapterState
    return {
      steps: state.steps,
      currentStepId: state.currentStepId ?? null,
      taskSummary: state.taskSummary ?? null,
    }
  }
  return {
    steps: [],
    currentStepId: null,
    taskSummary: null,
  }
}

function hasMapTool(allowedToolNames: string[] | null | undefined): boolean {
  return Boolean(allowedToolNames?.some((name) => name === 'map_plan_route'))
}

function buildStepId(existingSteps: ScopeRunTaskStep[], toolName: string): string {
  const repeats = existingSteps.filter((step) => step.id === toolName || step.id.startsWith(`${toolName}#`)).length
  return repeats === 0 ? toolName : `${toolName}#${repeats + 1}`
}

function buildToolSummary(record: Record<string, unknown> | null): string {
  if (record?.ok === false) {
    return typeof record.message === 'string' && record.message.trim()
      ? record.message.trim()
      : '地图规划未完成'
  }
  const selectedRoute = record?.selectedRoute
  if (selectedRoute && typeof selectedRoute === 'object') {
    const route = selectedRoute as Record<string, unknown>
    const duration = typeof route.durationText === 'string' ? route.durationText : null
    const distance = typeof route.distanceText === 'string' ? route.distanceText : null
    return [duration, distance].filter(Boolean).join('，') || '地图路线已规划'
  }
  return '地图路线已规划'
}

function hasNegatedLookupSignal(text: string): boolean {
  return /(不要|不用|无需|无需再|别|别再|不必).{0,6}(查|搜索|搜|网页|网上|资料|评价)/.test(text)
    || /(不查|别查|不要查)(网页|网上|资料|评价)?/.test(text)
}

function hasExplicitResearchSignal(text: string): boolean {
  if (hasNegatedLookupSignal(text)) return false
  return /(查|搜索|搜一下|评价|口碑|小红书|大众点评|攻略|网上|网页|资料|评分)/.test(text)
}

function buildPrefixes(params: DomainAdapterPrepareParams): string[] {
  const signals = new Set(params.executionIntentContext.mapSemanticIntent?.secondarySignals || [])
  return [
    ...BASE_TOOL_PREFIXES,
    ...(signals.has('document_output') ? DOCUMENT_TOOL_PREFIXES : []),
    ...(signals.has('research_lookup') && hasExplicitResearchSignal(params.userText) ? RESEARCH_TOOL_PREFIXES : []),
  ]
}

function readTextField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const minutes = Math.max(1, Math.round(value / 60))
  return `${minutes} 分钟`
}

function formatDistance(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} 公里` : `${Math.round(value)} 米`
}

function buildMapFinalText(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  if (record.ok === false) {
    return readTextField(record, 'message') || '地图规划没有完成。'
  }
  const origin = record.origin && typeof record.origin === 'object'
    ? readTextField(record.origin as Record<string, unknown>, 'name')
    : null
  const destination = record.destination && typeof record.destination === 'object'
    ? readTextField(record.destination as Record<string, unknown>, 'name')
    : null
  const selectedRoute = record.selectedRoute && typeof record.selectedRoute === 'object'
    ? record.selectedRoute as Record<string, unknown>
    : null
  const duration = selectedRoute ? formatSeconds(selectedRoute.durationSec) : null
  const distance = selectedRoute ? formatDistance(selectedRoute.distanceM) : null
  const lines = ['地图路线已经规划好。']
  const routeLabel = [origin, destination].filter(Boolean).join(' → ')
  if (routeLabel) lines.push(`路线：${routeLabel}`)
  if (duration || distance) lines.push(`预计：${[duration, distance].filter(Boolean).join('，')}`)
  if (Array.isArray(record.waypointOrder) && record.waypointOrder.length > 0) {
    lines.push(`途经点顺序：${record.waypointOrder.map((item) => `输入第 ${Number(item) + 1} 个`).join(' → ')}`)
  }
  const recommendations = Array.isArray(record.recommendations) ? record.recommendations : []
  if (recommendations.length > 0) {
    lines.push('顺路推荐：')
    for (const item of recommendations.slice(0, 3)) {
      if (!item || typeof item !== 'object') continue
      const recommendation = item as Record<string, unknown>
      const place = recommendation.place && typeof recommendation.place === 'object'
        ? recommendation.place as Record<string, unknown>
        : null
      const name = place ? readTextField(place, 'name') : null
      const detour = formatSeconds(recommendation.detourDurationSec)
      if (name) lines.push(`- ${name}${detour ? `，绕路约 ${detour}` : ''}`)
    }
  }
  const artifacts = record.artifacts && typeof record.artifacts === 'object'
    ? record.artifacts as Record<string, unknown>
    : null
  const markdownPath = artifacts ? readTextField(artifacts, 'markdownPath') : null
  if (markdownPath) lines.push(`Markdown 方案已生成：${markdownPath}`)
  return lines.join('\n')
}

export class MapDomainAdapter implements DomainAdapter {
  readonly id = 'map'

  shouldHandle(params: DomainAdapterSelectionContext): boolean {
    // Map semantic intent is precomputed in TurnEngine before adapter selection,
    // so this method stays synchronous like every other DomainAdapter.
    return isMapSemanticIntentActive(params.executionIntentContext.mapSemanticIntent)
  }

  contributePromptFragment(): CoordinatorPromptFragment[] | null {
    return null
  }

  arbitrateRunCapabilities(
    _params: DomainAdapterPrepareParams,
  ): CoordinatorCapabilityArbitration | null {
    return null
  }

  decorateUserText(
    text: string,
    _params: { phase: CoordinatorTextDecorationPhase },
  ): string {
    return text
  }

  prepare(params: DomainAdapterPrepareParams): DomainAdapterPrepareResult {
    const prefixes = buildPrefixes(params)
    const narrowed = filterAllowedToolNamesByPrefixes(params.allowedToolNames, prefixes)
    if (params.host?.log) {
      logPrefixNarrowing(params.host.log, 'map', params.allowedToolNames, narrowed, prefixes)
    }
    return {
      allowedToolNames: narrowed ?? [],
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createState(null),
    }
  }

  dispatch(params: DomainAdapterDispatchParams): DomainAdapterDispatchResult {
    const state = createState(params.domainState)
    if (params.hasTools && !hasMapTool(params.allowedToolNames)) {
      return {
        domainState: state,
        projection: {
          phase: 'blocked',
          summary: '本轮没有可用的地图规划工具',
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: '未解析到可用的 map_plan_route 工具',
        },
        finish: { status: 'done', success: false },
      }
    }
    return { domainState: state }
  }

  applyResult(params: DomainAdapterApplyParams): DomainAdapterApplyResult {
    const state = createState(params.domainState)
    if (params.phase === 'tool_batch') {
      let nextState = state
      let finalText: string | null = null
      const signals = new Set(params.executionIntentContext.mapSemanticIntent?.secondarySignals || [])
      const shouldContinueForDocument = signals.has('document_output')
      const shouldContinueForResearch = signals.has('research_lookup') && hasExplicitResearchSignal(params.userText)
      for (const executedTool of params.toolBatch?.executedTools || []) {
        if (executedTool.name !== 'map_plan_route') continue
        const record = readStructuredToolResultRecord(executedTool.result)
        const stepId = buildStepId(nextState.steps, executedTool.name)
        const summary = buildToolSummary(record)
        if (!shouldContinueForDocument && !shouldContinueForResearch) {
          finalText = buildMapFinalText(record)
        } else if (record?.ok === false && record.errorKind !== 'place_ambiguous') {
          finalText = buildMapFinalText(record)
        }
        nextState = {
          steps: [
            ...nextState.steps,
            {
              id: stepId,
              title: executedTool.name,
              status: record?.ok === false ? 'blocked' : 'done',
              detail: summary,
              updatedAt: new Date().toISOString(),
            },
          ],
          currentStepId: stepId,
          taskSummary: summary,
        }
      }
      if (finalText) {
        return {
          domainState: nextState,
          finalText,
          projection: {
            phase: finalText.includes('没有完成') ? 'blocked' : 'done',
            summary: nextState.taskSummary || finalText,
            waitingFor: 'none',
            resumableActions: ['cancel', 'open_artifact'],
            blockedReason: finalText.includes('没有完成') ? nextState.taskSummary : null,
          },
        }
      }
      return { domainState: nextState }
    }
    if (params.phase === 'no_tool_call' && state.currentStepId) {
      return {
        domainState: state,
        projection: {
          phase: 'done',
          summary: state.taskSummary || '地图路线已规划',
          waitingFor: 'none',
          resumableActions: ['cancel', 'open_artifact'],
          blockedReason: null,
        },
      }
    }
    if (params.phase === 'budget_limit' && state.currentStepId) {
      return {
        domainState: state,
        projection: {
          phase: 'blocked',
          summary: state.taskSummary || '地图路线规划达到本轮执行上限',
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: '已达到本轮执行上限',
        },
      }
    }
    return { domainState: state }
  }

  buildProjectionPatch(params: DomainAdapterProjectionParams): Record<string, unknown> | null {
    const state = createState(params.domainState)
    if (!state.currentStepId) return null
    return {
      module: 'map',
      taskTitle: '地图路线规划',
      taskSummary: params.projection.summary,
      steps: state.steps,
      currentStepId: state.currentStepId,
      waitingFor: params.projection.waitingFor ?? 'none',
      resumableActions: params.projection.resumableActions ?? ['cancel', 'open_artifact'],
      blockedReason: typeof params.projection.blockedReason === 'undefined' ? null : params.projection.blockedReason,
    }
  }
}
