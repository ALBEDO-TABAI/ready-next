import type { AgentInputItem } from '@openai/agents'
import type { ToolBridgeRuntimeContext } from '../runtime-core/agent-sdk-types'
import {
  createSystemReminderRegistry,
  type SystemReminderRegistry,
} from './system-reminder-registry'

export const BROWSER_OBSERVATION_REQUIRED_REMINDER_TOPIC = 'browser-observation-required'

export function registerBrowserObservationRequiredReminder(
  registry: SystemReminderRegistry,
  gaps: readonly ToolBridgeRuntimeContext['browserObservationGaps'][number][],
): void {
  if (gaps.length === 0) return
  const pendingActions = gaps.map((gap) => ({
    actionId: gap.actionId,
    actionSeq: gap.actionSeq,
    operationId: gap.operationId,
    successorIdentity: gap.outcome.successorIdentity,
    replayAllowed: false,
  }))
  registry.register({
    topic: BROWSER_OBSERVATION_REQUIRED_REMINDER_TOPIC,
    priority: 100,
    conflictsWith: [],
    text: [
      '系统补充：刚才的浏览器写动作已经送达，但持久日志中还缺少与该动作因果绑定的新观察。',
      `待观察动作：${JSON.stringify(pendingActions)}`,
      '先在当前绑定页面上选择合适的只读 Browser 观察工具，确认这些动作后的真实页面状态。',
      '在新观察成功绑定前，不要重放、替换或新增任何页面写动作，也不要结束任务。',
      '观察完成后，根据新的页面事实继续原任务。',
    ].join('\n'),
  })
}

export function buildBrowserObservationRequiredInput(
  gaps: readonly ToolBridgeRuntimeContext['browserObservationGaps'][number][],
): AgentInputItem[] {
  const registry = createSystemReminderRegistry()
  registerBrowserObservationRequiredReminder(registry, gaps)
  const text = registry.compose()
  if (!text) throw new Error('browser_observation_required_reminder_missing')
  return [{ role: 'system', content: text } as AgentInputItem]
}
