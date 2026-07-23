import type { BrowserResearchAssessment } from '../../browser-engine/browser-workflow-evidence'
import { browserWorkflowStableDigest } from '../../browser-engine/browser-workflow-evidence'
import type { SystemReminderRegistry } from './system-reminder-registry'

export const BROWSER_RESEARCH_PROGRESS_REMINDER_TOPIC = 'browser-research-progress'

/**
 * 2026-07-23 失忆回归的修复面之一：研究进度的 durable 真值（work item +
 * evidence 账本）此前只在收尾候选被拦截时（browser-research-incomplete）
 * 才回灌模型。上下文压缩把"已完成哪些工作项"从模型视野里抹掉后，模型会
 * 退回第一个关键词重做并反复重注册计划。这里提供一个进度态提醒：无论
 * 账本是否 satisfied 都能注入，让压缩后的模型第一时间对齐持久进度。
 */
export function browserResearchProgressDigest(assessment: BrowserResearchAssessment): string {
  const required = assessment.workItems.filter((item) => item.required)
  return browserWorkflowStableDigest({
    required: required.length,
    completed: required.filter((item) => item.evidenceRefIds.length > 0).length,
    missingWorkItemIds: [...assessment.missingWorkItemIds].sort(),
  })
}

export function registerBrowserResearchProgressReminder(
  registry: SystemReminderRegistry,
  assessment: BrowserResearchAssessment,
): void {
  if (assessment.workItems.length === 0) return
  const required = assessment.workItems.filter((item) => item.required)
  const completed = required.filter((item) => item.evidenceRefIds.length > 0)
  const missing = assessment.missingWorkItemIds.slice(0, 32)
  registry.register({
    topic: BROWSER_RESEARCH_PROGRESS_REMINDER_TOPIC,
    priority: 88,
    conflictsWith: [],
    text: [
      '系统补充：浏览器研究进度账本（代码维护的持久真值，跨上下文压缩存活）：',
      JSON.stringify({
        required: required.length,
        completed: completed.length,
        completedWorkItemIds: completed.slice(0, 32).map((item) => item.workItemId),
        missingWorkItemIds: missing,
        omittedMissingCount: Math.max(0, assessment.missingWorkItemIds.length - missing.length),
      }),
      '进度以该账本为准，与你记忆冲突时以账本为准：已有证据的工作项不要重新采集；不要重新注册重复的研究计划（重复注册会污染必做清单）；缺失项补齐后按正常流程收尾。',
    ].join('\n'),
  })
}
