import type { AgentInputItem } from '@openai/agents'
import type { BrowserResearchAssessment } from '../../browser-engine/browser-workflow-evidence'
import {
  createSystemReminderRegistry,
  type SystemReminderRegistry,
} from './system-reminder-registry'

export const BROWSER_RESEARCH_INCOMPLETE_REMINDER_TOPIC = 'browser-research-incomplete'

export function registerBrowserResearchIncompleteReminder(
  registry: SystemReminderRegistry,
  assessment: BrowserResearchAssessment,
): void {
  if (assessment.satisfied || assessment.missingWorkItemIds.length === 0) return
  const missing = assessment.missingWorkItemIds.slice(0, 64)
  const completed = assessment.workItems.filter((item) => (
    item.required && item.evidenceRefIds.length > 0
  )).length
  registry.register({
    topic: BROWSER_RESEARCH_INCOMPLETE_REMINDER_TOPIC,
    priority: 95,
    conflictsWith: [],
    text: [
      '系统补充：当前回复只是未完成的候选，不能作为最终结果发布。',
      `持久研究进度：${JSON.stringify({
        required: assessment.workItems.filter((item) => item.required).length,
        completed,
        missingWorkItemIds: missing,
        omittedMissingCount: Math.max(0, assessment.missingWorkItemIds.length - missing.length),
      })}`,
      '继续当前任务并使用本轮已有工具补齐缺失工作项；不要把阶段性总结当成最终答复。',
      '每个证据只证明它实际覆盖的工作项与内容；全部必需项满足后再结束。',
    ].join('\n'),
  })
}

export function buildBrowserResearchIncompleteInput(
  assessment: BrowserResearchAssessment,
): AgentInputItem[] {
  const registry = createSystemReminderRegistry()
  registerBrowserResearchIncompleteReminder(registry, assessment)
  const text = registry.compose()
  if (!text) throw new Error('browser_research_incomplete_reminder_missing')
  return [{ role: 'system', content: text } as AgentInputItem]
}
