import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tool-result-types'
import type { SkillExecutionDetail } from '../../../shared/skill-execution-types'

export const EXECUTION_NOT_FOUND_RE = /execution not found/i

export type SkillCoordinatorOperation =
  | 'get_state'
  | 'submit_input'
  | 'submit_confirmation'
  | 'submit_agent_result'
  | 'restart_from_step'
  | 'cancel_execution'

export function buildSkillExecutionMissingOutput(params: {
  executionId: string
  operation: SkillCoordinatorOperation
  activeExecution: SkillExecutionDetail | null
  originalMessage?: string
}): ToolExecutionOutput {
  const targetId = params.executionId || '(missing id)'
  const lines: string[] = [`Skill execution ${targetId} not found.`]
  if (params.activeExecution) {
    const active = params.activeExecution
    const activeDesc = [
      `skill=${active.skillId}`,
      `status=${active.status}`,
      active.currentStepId ? `step=${active.currentStepId}` : '',
    ].filter(Boolean).join(', ')
    lines.push(
      `当前会话存在活跃 execution：${active.id}（${activeDesc}）。`,
      `请改用该 executionId 重新调用 skill_${params.operation}；如果已经没必要继续，再调用 skill_cancel_execution。`,
    )
  } else {
    lines.push(
      '当前会话没有任何活跃的 skill execution。请先用 skill_get_state（可不带参数）定位当前状态，再决定是继续已有 workflow 还是重新启动对应 skill。',
    )
  }
  return createToolExecutionOutput(lines.join('\n'), {
    shape: 'json',
    data: {
      errorKind: 'skill_execution_missing',
      operation: params.operation,
      executionId: params.executionId || null,
      activeExecutionId: params.activeExecution?.id || null,
      activeSkillId: params.activeExecution?.skillId || null,
      activeStatus: params.activeExecution?.status || null,
      originalMessage: params.originalMessage || null,
    },
  })
}
