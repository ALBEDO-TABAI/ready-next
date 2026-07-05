import type { AIModelConfig } from '../../../../shared/ai-providers'
import { getProviderDef, resolveAIConfigCapabilities } from '../../../../shared/ai-providers'
import type { AIConfigLoad } from '../../claude-bridge/direct-chat-ai-config'
import type { BeliefCardStore } from '../knowledge/belief-card-store'
import { logAgentMetric } from '../metrics'
import { extractResponsesText } from '../runtime-core/agent-sdk-utils'
import {
  runMaintenanceLlmRound,
  type MaintenanceRoundReport,
  type MaintenanceSignals,
} from './maintenance-llm-round'

/**
 * D7 生产驱动装配（合同：docs/superpowers/plans/2026-07-05-p3-backlog-closeout-implementation.md §2）。
 *
 * crystallize tick 捎带调用 `runMaintenanceLlmRoundTick`；三层代码预算闸全部在
 * 本模块（专项开关 / durable lastRunAt 进 EP2-C2 确定性门控 / 空信号跳过），
 * `runMaintenanceLlmRound` 自身合同（单调用、强制 staged 写、容器钉死）不变。
 */

export const MAINTENANCE_LLM_ROUND_ENABLED_KEY = 'maintenance.llmRound.enabled'
export const MAINTENANCE_LLM_ROUND_LAST_RUN_KEY = 'maintenance.llmRound.lastRunAt'

const STAGED_SIGNAL_CARD_CAP = 20
const MAINTENANCE_LLM_TIMEOUT_MS = 60_000

export interface MaintenanceSettingsAccess {
  getSetting(key: string): string | null | undefined
  setSetting(key: string, value: string): void
}

/** ⑤ kill switch 专项开关：缺省 ON，'false' 关闭；总开关（知识系统）由
 *  tick 入口 isKnowledgeSystemEnabled 先行裁决，两级 AND。 */
export function isMaintenanceLlmRoundEnabled(settings: MaintenanceSettingsAccess): boolean {
  try {
    return settings.getSetting(MAINTENANCE_LLM_ROUND_ENABLED_KEY) !== 'false'
  } catch {
    // silent-catch: unreadable setting keeps the default-ON semantics (master
    // knowledge switch still gates the whole tick upstream)
    return true
  }
}

/** v1 信号面＝staged 卡真值清单；learning/checkin 摘要留空到 learningDecision
 *  写入端落地（四痛诊断独立流）——不造假数据。 */
export function collectMaintenanceSignalsFromStore(
  store: Pick<BeliefCardStore, 'listCards'>,
): MaintenanceSignals {
  const stagedCards = store.listCards({ includeStaged: true })
    .filter((card) => card.frontmatter.status === 'staged')
    .slice(0, STAGED_SIGNAL_CARD_CAP)
    .map((card) => ({
      relPath: card.relPath,
      title: String(card.frontmatter.title || ''),
      description: String(card.frontmatter.description || ''),
    }))
  return { learningSummaries: [], checkinSummaries: [], stagedCards }
}

export function maintenanceSignalsAreEmpty(signals: MaintenanceSignals): boolean {
  return signals.learningSummaries.length === 0
    && signals.checkinSummaries.length === 0
    && signals.stagedCards.length === 0
}

/** 单发文本完成调用：按共享能力层解析协议（anthropic / responses / chat 完成），
 *  非流式、温度 0.1、一轮一调用。provider 缺配置抛错→容器把它面包屑化。 */
export function buildMaintenanceLlmCall(
  loadAIConfig: () => AIConfigLoad,
): (prompt: string, abortSignal: AbortSignal) => Promise<string> {
  return async (prompt, abortSignal) => {
    const loaded = loadAIConfig()
    if (!loaded.ok || !loaded.config) throw new Error(`ai_config_unavailable:${loaded.reason || 'missing'}`)
    const config = loaded.config as AIModelConfig
    const capabilities = resolveAIConfigCapabilities(config)
    const baseUrl = (capabilities?.baseUrl || config.baseUrl || '').replace(/\/+$/, '')
    const provider = capabilities?.provider || getProviderDef(config.provider, baseUrl)
    const timeoutSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(MAINTENANCE_LLM_TIMEOUT_MS)])

    if (capabilities?.agentProtocol === 'anthropic') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      }
      if (provider?.id === 'anthropic' && !config.agentProtocol) {
        headers['x-api-key'] = config.apiKey
      } else {
        const authHeader = provider?.authHeader || 'Authorization'
        const authPrefix = provider?.authPrefix ?? 'Bearer '
        headers[authHeader] = `${authPrefix}${config.apiKey}`
        if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
      }
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1200,
          temperature: 0.1,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
        signal: timeoutSignal,
      })
      if (!resp.ok) throw new Error(`maintenance_llm_http_${resp.status}`)
      const payload = await resp.json() as { content?: Array<{ type?: string; text?: string }> }
      return (payload.content || [])
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text || '')
        .join('\n')
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`
    if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)

    const wireApi = capabilities?.wireApi || config.wireApi || provider?.wireApi || 'chat/completions'
    if (wireApi === 'responses') {
      const resp = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        }),
        signal: timeoutSignal,
      })
      if (!resp.ok) throw new Error(`maintenance_llm_http_${resp.status}`)
      return extractResponsesText(await resp.json() as Record<string, unknown>)
    }

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: timeoutSignal,
    })
    if (!resp.ok) throw new Error(`maintenance_llm_http_${resp.status}`)
    const payload = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    return String(payload.choices?.[0]?.message?.content || '')
  }
}

export interface MaintenanceLlmTickDeps {
  settings: MaintenanceSettingsAccess
  store: BeliefCardStore
  loadAIConfig: () => AIConfigLoad
  now?: () => Date
  /** 测试注入；生产缺省经 buildMaintenanceLlmCall 走真 provider。 */
  llm?: (prompt: string, abortSignal: AbortSignal) => Promise<string>
}

/**
 * crystallize tick 的捎带入口。skip 与 run 全部经 `maintenance_audit` 指标
 * 可观测；成功 run（非 runner_error）才写回 durable lastRunAt——失败轮不占
 * 节奏窗口。
 */
export async function runMaintenanceLlmRoundTick(
  deps: MaintenanceLlmTickDeps,
): Promise<MaintenanceRoundReport | null> {
  const now = deps.now ? deps.now() : new Date()
  if (!isMaintenanceLlmRoundEnabled(deps.settings)) {
    logAgentMetric('maintenance_audit', {
      round: 'llm', decision: 'skip', reason: 'switch_off', llmCalls: 0, applied: 0, rejected: 0,
    })
    return null
  }
  const signals = collectMaintenanceSignalsFromStore(deps.store)
  if (maintenanceSignalsAreEmpty(signals)) {
    logAgentMetric('maintenance_audit', {
      round: 'llm', decision: 'skip', reason: 'no_signals', llmCalls: 0, applied: 0, rejected: 0,
    })
    return null
  }
  let lastRunAt: string | null = null
  try {
    lastRunAt = deps.settings.getSetting(MAINTENANCE_LLM_ROUND_LAST_RUN_KEY) || null
  } catch {
    // silent-catch: unreadable lastRunAt degrades to never_ran — the gate still
    // caps the round to one call, and a successful run rewrites the row
    lastRunAt = null
  }
  const report = await runMaintenanceLlmRound({
    signals: {
      lastRunAt,
      newCheckInsWithLearning: 0,
      newConversationTurns: 0,
      cardWritesSinceLast: 0,
      memoryFileMtimeChanged: false,
      forced: false,
    },
    now,
    store: deps.store,
    collect: () => signals,
    llm: deps.llm ?? buildMaintenanceLlmCall(deps.loadAIConfig),
  })
  // 白名单写回：容器把生成器抛错折叠成 'failed'、迭代器崩溃是 'runner_error:*'，
  // 只有 'completed' 才占节奏窗口——失败轮下个 tick 立刻重试。
  if (report.decision === 'run' && report.terminal === 'completed') {
    deps.settings.setSetting(MAINTENANCE_LLM_ROUND_LAST_RUN_KEY, now.toISOString())
  }
  return report
}
