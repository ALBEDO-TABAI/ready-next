import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { logAgentMetric } from '../../agent-control/metrics'

/**
 * D4 — 模型声明验收标准的结构化通道（合同：2026-07-05-p3-backlog-closeout §1）。
 *
 * 声明只落 task projection 行的 `modelCriteria` 字段（整组替换、幂等），
 * finalizer 终态经 `appendModelCriteria` 并入裁决（m1/m2 命名空间，模板
 * 不可覆盖）。校验全部在代码侧：条数/长度/空串；漂移账本
 * `model_criteria_declared` 每次声明必发。
 */

export const DECLARE_CRITERIA_MAX_ITEMS = 8
export const DECLARE_CRITERIA_MAX_ITEM_CHARS = 120

export interface DeclareCompletionCriteriaDeps {
  taskId: string | null
  sessionId?: string | null
  updateTaskModelCriteria: (taskId: string, criteria: string[]) => void
}

export function executeDeclareCompletionCriteria(
  args: Record<string, unknown>,
  deps: DeclareCompletionCriteriaDeps,
): ToolExecutionOutput {
  const raw = Array.isArray(args.criteria) ? args.criteria : null
  if (!raw || raw.length === 0) {
    return createToolExecutionOutput('未登记：criteria 必须是非空字符串数组。', {
      shape: 'json',
      data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
    })
  }
  if (raw.length > DECLARE_CRITERIA_MAX_ITEMS) {
    return createToolExecutionOutput(`未登记：最多 ${DECLARE_CRITERIA_MAX_ITEMS} 条验收标准（收到 ${raw.length} 条），请合并同类项。`, {
      shape: 'json',
      data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
    })
  }
  const criteria: string[] = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (!text) {
      return createToolExecutionOutput('未登记：存在空白条目，请移除后重试。', {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    if (text.length > DECLARE_CRITERIA_MAX_ITEM_CHARS) {
      return createToolExecutionOutput(`未登记：单条上限 ${DECLARE_CRITERIA_MAX_ITEM_CHARS} 字符（有一条 ${text.length} 字符），请精简为可验证的一句话。`, {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    criteria.push(text)
  }

  if (!deps.taskId) {
    // task_context_missing 走 envelope 模式表（/missing/→not_found），无需注册新 kind
    return createToolExecutionOutput('未登记：当前回合没有关联任务，验收标准无处挂靠。', {
      shape: 'json',
      data: { errorKind: 'task_context_missing', toolName: 'declare_completion_criteria' },
    })
  }

  deps.updateTaskModelCriteria(deps.taskId, criteria)
  logAgentMetric('model_criteria_declared', {
    taskId: deps.taskId,
    sessionId: deps.sessionId || null,
    count: criteria.length,
  })
  return createToolExecutionOutput(
    `已登记 ${criteria.length} 条补充验收标准（整组替换）。终态裁决时会与系统模板标准合并核对；模板标准不可被覆盖。`,
    {
      shape: 'json',
      data: { ok: true, count: criteria.length, criteria },
    },
  )
}
