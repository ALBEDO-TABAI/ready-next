/**
 * D2（2026-07-03 梯队三）— 验收标准事中自检 reminder。
 *
 * 裁决从"事后打回"变"事中自检"：把 run-finalizer 终态裁决使用的同一套
 * criteria 模板（`resolveCriteria`）在每次模型调用前注入，模型宣布完成前
 * 可对照自检。确定性、零 LLM：
 *
 *  - 只对结果型任务注入（multi_step_task / research / media_task /
 *    browser_transaction）；direct_answer / short_task / continuation 注入
 *    只会稀释上下文，跳过。
 *  - module 映射是保守近似：orchestrator 作用域没有 module 信号，
 *    browser_transaction → 'browser'（吃 transaction 专用模板），其余 →
 *    'system'（基线模板）。document/design 叠加层缺失只意味着自检清单少
 *    几条叠加项，终态裁决仍用完整 resolveCriteria(facts.module)。
 *  - 文案脱内部术语：criteria text 的括号尾注（如"（对接 C4.2a
 *    steps_json）"）是维护者注记，注入前截断到括号前主句（D2 工单方案）。
 *
 * D4（模型声明补充标准回传）仍缓办：现无类型化回传通道（steps 走
 * projectionPatch，非模型工具），见 deferred-work-register D4。
 */
import { resolveCriteria } from '../quality/criteria-templates'
import { logAgentMetric } from '../metrics'
import type { TaskType } from '../../../../shared/task-types'
import type { SystemReminderRegistry } from './system-reminder-registry'

const INJECTABLE_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  'artifact_task',
  'transaction_task',
  'research_artifact_task',
  'multi_step_task',
  'research',
  'media_task',
  'browser_transaction',
] as TaskType[])

/** 截到第一个全角括号前 — 括号内是维护者注记，不是给模型的验收语义。 */
function sanitizeCriterionText(text: string): string {
  return text.split('（')[0].trim()
}

export function buildCriteriaSelfCheckText(taskType: TaskType | null | undefined): string | null {
  if (!taskType || !INJECTABLE_TASK_TYPES.has(taskType)) return null
  const module = taskType === 'browser_transaction' ? 'browser' : 'system'
  const resolved = resolveCriteria(taskType, module)
  const lines = resolved.items
    .filter((item) => !item.notApplicable)
    .map((item) => `- ${sanitizeCriterionText(item.text)}`)
    .filter((line) => line.length > 2)
  if (lines.length === 0) return null
  return [
    '本轮任务的验收标准（宣布完成前逐条自检）：',
    ...lines,
    '任务承诺多份文件交付时，先用 declare_completion_criteria.expected_outputs 声明每份最终文件路径。',
    '暂时无法满足的项，说明原因并继续推进或如实汇报，不要在未满足时宣称完成。',
  ].join('\n')
}

/**
 * 注入成功返回 true。criteria 是 run 级静态清单——调用方（orchestrator）
 * 以此实现"每 run 首次模型调用注入一次"，后续迭代不重复占 token，也不
 * 改变 text-bridge 等后续迭代的输入形状。
 */
export function registerCriteriaSelfCheckReminder(
  registry: SystemReminderRegistry,
  taskType: TaskType | null | undefined,
): boolean {
  const text = buildCriteriaSelfCheckText(taskType)
  if (!text) return false
  registry.register({
    topic: 'criteria-self-check',
    // 在普通运行提醒之后注入整体验收标准。
    priority: 70,
    conflictsWith: [],
    text,
  })
  // 可观测账本：真机验证与回归排查都以此为准（metrics log）。
  logAgentMetric('criteria_self_check_injected', { taskType })
  return true
}
