import type { AIModelConfig } from '../../../../shared/ai-providers'
import type { ExecutionTurnResult } from '../contracts/run-contracts'
import type { RequestedCapabilityConflict } from '../domain-adapters/capability-resolver'
import { logAgentMetric } from '../metrics'
import {
  getAskUserQuestionsCardEmitter,
  getAskUserQuestionsCardPersistor
} from '../ask-user/ask-user-questions-bridge'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import {
  executeAskUserQuestions,
  type AskUserQuestionsHandlerDeps
} from '../../tools/builtins/ask-user-questions'
import { ToolDomainError } from '../../tools/tool-errors'
import type { TurnTerminalReason } from './turn-frame'
import {
  fingerprintAIConfig,
  type ActiveToolUseModeUpdateRequest,
  type ActiveToolUseModeUpdateResult
} from './tool-use-mode-config-update'

export const TOOL_CALLING_CONSENT_QUESTION_ID = 'tool_calling_consent'
export const TOOL_CALLING_ENABLE_OPTION = '开启工具调用'
export const TOOL_CALLING_KEEP_CLOSED_OPTION = '保持关闭'

const TOOL_TARGET_PATTERN = /(?:工具调用|工具|浏览器|网页|文档|function\s+calling|\btools?\b|\bbrowser\b)/i
const EXPLICIT_PERMISSION_PATTERN = /(?:允许|授权|同意.{0,8}使用|enable|allow|authori[sz]e|turn\s+on)/i
const TOOL_MODE_TOGGLE_PATTERN = /(?:(?:开启|打开|启用).{0,8}(?:工具调用|工具权限|工具能力|工具功能|工具开关|工具总闸门)|(?:工具调用|工具权限|工具能力|工具功能|工具开关|工具总闸门).{0,8}(?:开启|打开|启用))/i
const NEGATION_PATTERN = /(?:不要|不用|不能|无法|不想|不允许|不授权|未授权|没(?:有)?授权|不同意|不开启|不代表|无权|别|禁止|拒绝|取消|撤销|\bdo\s+not\b|\bdon't\b|\bnot\b|\bnever\b|\bcannot\b|\bcan['’]t\b|\bwon['’]t\b|\bunable\b|\bunauthori[sz]ed\b|\bnot\s+authori[sz]ed\b|\bdeny\b|\brefuse\b|\bdisable\b|\bwithout\b)/i

export function isExplicitToolEnableConsentMessage(text: string): boolean {
  const normalized = String(text || '').trim()
  return normalized.length > 0
    && TOOL_TARGET_PATTERN.test(normalized)
    && (
      EXPLICIT_PERMISSION_PATTERN.test(normalized)
      || TOOL_MODE_TOGGLE_PATTERN.test(normalized)
    )
    && !NEGATION_PATTERN.test(normalized)
}

type FinalizeConsentTurn = (params: {
  status: 'done' | 'checkpoint' | 'error' | 'cancelled'
  terminalReason: TurnTerminalReason
  finalText: string
  error?: string
  initiator?: string
}) => Promise<ExecutionTurnResult>

export interface ToolCapabilityConsentContext {
  conflicts: readonly RequestedCapabilityConflict[]
  supportsToolCalls: boolean
  currentConfig: AIModelConfig
  activeProfileId?: string | null
  localSettingsConsentAllowed: boolean
  userText: string
  agentName: string
  sessionId?: string
  runId: string
  taskId: string
  signal: AbortSignal
  emitOutput: (chunk: string, type: string) => void
  finalizeEarlyReturn: FinalizeConsentTurn
  setActiveToolUseMode: (
    request: ActiveToolUseModeUpdateRequest
  ) => ActiveToolUseModeUpdateResult | Promise<ActiveToolUseModeUpdateResult>
}

export interface ToolCapabilityConsentDeps {
  askUserQuestions?: typeof executeAskUserQuestions
  askUserQuestionsDeps?: Partial<AskUserQuestionsHandlerDeps>
}

function emitAndFinalize(
  ctx: ToolCapabilityConsentContext,
  text: string,
  status: 'done' | 'error',
  terminalReason: TurnTerminalReason
): Promise<ExecutionTurnResult> {
  ctx.emitOutput(text, status === 'error' ? 'error' : 'text')
  return ctx.finalizeEarlyReturn({
    status,
    terminalReason,
    finalText: status === 'done' ? text : '',
    error: status === 'error' ? text : undefined,
    initiator: 'tool_calling_consent'
  })
}

export async function maybeHandleToolCapabilityConsent(
  ctx: ToolCapabilityConsentContext,
  deps: ToolCapabilityConsentDeps = {}
): Promise<ExecutionTurnResult | null> {
  const hasProviderConflict = ctx.conflicts.some(
    (conflict) => conflict.reason === 'provider_disabled_tools'
  )
  if (
    !hasProviderConflict
    || ctx.supportsToolCalls
    || !ctx.sessionId
    || !isExplicitToolEnableConsentMessage(ctx.userText)
  ) return null

  if (!ctx.localSettingsConsentAllowed) {
    return emitAndFinalize(
      ctx,
      '远程会话不能修改本机模型配置。请回到本机 Ready 的设置页开启工具调用。',
      'done',
      'done',
    )
  }

  const askUserQuestions = deps.askUserQuestions || executeAskUserQuestions
  let output: Awaited<ReturnType<typeof executeAskUserQuestions>>
  try {
    output = await askUserQuestions({
      questions: [{
        id: TOOL_CALLING_CONSENT_QUESTION_ID,
        question: '当前模型配置关闭了工具调用。确认仅为当前活跃模型配置开启工具调用吗？请只在该端点支持 function calling 时开启。',
        kind: 'single_choice',
        options: [TOOL_CALLING_ENABLE_OPTION, TOOL_CALLING_KEEP_CLOSED_OPTION],
        required: true
      }]
    }, {
      sessionId: ctx.sessionId,
      conversationId: ctx.sessionId,
      scopeId: ctx.sessionId,
      agent: ctx.agentName,
      requestId: ctx.runId,
      signal: ctx.signal,
      emitAskUserQuestionsCard: getAskUserQuestionsCardEmitter(),
      persistCardPending: getAskUserQuestionsCardPersistor(),
      responsePolicy: 'local_renderer_only',
      ...deps.askUserQuestionsDeps
    })
  } catch (error) {
    const reason = error instanceof ToolDomainError ? error.errorKind : 'card_failed'
    if (reason === 'aborted') {
      const abortError = new Error(error instanceof Error ? error.message : 'aborted')
      abortError.name = 'AbortError'
      throw abortError
    }
    if (reason === 'user_skipped' || reason === 'user_cancelled') {
      return ctx.finalizeEarlyReturn({
        status: 'cancelled',
        terminalReason: 'cancelled_user',
        finalText: '',
        initiator: `tool_calling_consent_${reason}`
      })
    }
    if (reason === 'timeout' || reason === 'overlapping_card') {
      const text = reason === 'timeout'
        ? '工具调用开启确认已过期，设置保持不变。需要时请重新发送开启请求。'
        : '当前已有一张待确认卡，工具调用设置保持不变。请先处理现有卡片。'
      return emitAndFinalize(ctx, text, 'done', 'done')
    }
    logAgentMetric('tool_calling_consent_failed', {
      scopeId: ctx.sessionId || null,
      runId: ctx.runId,
      taskId: ctx.taskId,
      reason,
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
    })
    const text = '无法保存工具调用确认，设置没有改变。请稍后重试。'
    return emitAndFinalize(ctx, text, 'error', reason === 'persistence_failed' ? 'persistence_failed' : 'blocked_external')
  }

  const answers = Array.isArray(output.data?.answers) ? output.data.answers : []
  const selected = answers.find(
    (answer) => answer && typeof answer === 'object'
      && (answer as Record<string, unknown>).id === TOOL_CALLING_CONSENT_QUESTION_ID
  ) as Record<string, unknown> | undefined
  const answer = typeof selected?.answer === 'string' ? selected.answer : ''
  if (answer !== TOOL_CALLING_ENABLE_OPTION) {
    return emitAndFinalize(ctx, '工具调用保持关闭，设置没有改变。', 'done', 'done')
  }
  const answeredVia = typeof output.data?.answeredVia === 'string'
    ? output.data.answeredVia
    : 'local_renderer'
  if (answeredVia !== 'local_renderer') {
    return emitAndFinalize(
      ctx,
      '这项设置只能在本机 Ready 中确认，设置没有改变。',
      'error',
      'blocked_config',
    )
  }

  let updateResult: ActiveToolUseModeUpdateResult
  try {
    updateResult = await ctx.setActiveToolUseMode({
      mode: 'on',
      expectedFingerprint: fingerprintAIConfig(
        ctx.currentConfig,
        ctx.activeProfileId ?? null,
      )
    })
  } catch (error) {
    logAgentMetric('tool_calling_consent_failed', {
      scopeId: ctx.sessionId || null,
      runId: ctx.runId,
      taskId: ctx.taskId,
      reason: 'settings_write_failed',
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
    })
    const message = '工具调用设置写入失败，原设置保持不变。请稍后重试。'
    return emitAndFinalize(ctx, message, 'error', 'persistence_failed')
  }
  if (!updateResult.applied) {
    const message = updateResult.reason === 'config_changed'
      ? '等待确认期间活跃模型配置已切换，为避免改错配置，本次没有开启工具调用。请在当前配置下重新发送开启请求。'
      : '当前没有可修改的活跃模型配置，工具调用设置未改变。'
    return emitAndFinalize(ctx, message, 'error', 'blocked_config')
  }

  const cardId = typeof output.data?.cardId === 'string' ? output.data.cardId : null
  const audit = {
    scopeId: ctx.sessionId || null,
    runId: ctx.runId,
    taskId: ctx.taskId,
    agent: ctx.agentName,
    cardId,
    previousMode: updateResult.previousMode,
    confirmedVia: 'ask_user_questions',
    confirmationSurface: answeredVia,
    actor: 'local_renderer_user'
  }
  logAgentMetric('tool_calling_consent_applied', audit)
  appendToolCapabilityLog(`[tool_capability] stage=tool_calling_consent_applied audit=${JSON.stringify(audit)}`)
  return emitAndFinalize(
    ctx,
    '已开启工具调用。当前这条消息是在旧工具面上启动的，请重发上一条任务。',
    'done',
    'done'
  )
}
