/**
 * EP3-A4 — `agent_propose_handoff` executor wrapper: snake_case tool args →
 * proposal input, registry/projection seams resolved from the runtime, and
 * the outcome mapped to a structured ToolExecutionOutput so the model gets
 * machine-readable adoption/rejection (a user rejection is a RESULT, not an
 * error). The flow itself lives in agent-control/agents/handoff-proposal.
 */

import {
  runHandoffProposal,
  type HandoffProposalDeps,
  type HandoffProposalOutcome,
} from '../../agent-control/agents/handoff-proposal'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'

export interface ProposeHandoffArgs {
  target_agent_id?: unknown
  reason?: unknown
  user_request_verbatim?: unknown
  context_refs?: unknown
  task_id?: unknown
}

function outcomeText(outcome: HandoffProposalOutcome): string {
  switch (outcome.kind) {
    case 'adopted':
      return [
        `用户已确认当前会话转给「${outcome.targetAgentName}」继续处理${outcome.taskId ? `（任务 ${outcome.taskId}）` : ''}。`,
        outcome.targetAgentCharter ? `目标 agent 职责：${outcome.targetAgentCharter}` : '',
        `用户原始请求：${outcome.userRequestVerbatim}`,
        '现在请以该专项 agent 的职责继续完成用户原始请求。不要只说明“已转交”，也不要结束本轮；除非必须补充信息，否则直接交付结果。',
      ].filter(Boolean).join('\n')
    case 'adopted_new_session':
      return `用户选择新会话接手：目标 ${outcome.targetAgentId}，原话已预填，等待用户在新会话发起。`
    case 'rejected_by_user':
      return '用户拒绝了转办建议，请继续以当前身份处理任务，本轮不要再次提议。'
    case 'invalid':
      return `转办提议无效：${outcome.reason}`
    case 'card_failed':
      return `转办建议卡未完成：${outcome.reason}`
  }
}

export async function executeProposeHandoff(
  args: ProposeHandoffArgs,
  deps: Omit<HandoffProposalDeps, 'getAgent' | 'updateTaskOwner'> & {
    getAgent: HandoffProposalDeps['getAgent']
    updateTaskOwner: HandoffProposalDeps['updateTaskOwner']
    taskId?: string | null
  },
): Promise<ToolExecutionOutput> {
  const outcome = await runHandoffProposal(
    {
      targetAgentId: typeof args.target_agent_id === 'string' ? args.target_agent_id : '',
      reason: typeof args.reason === 'string' ? args.reason : '',
      userRequestVerbatim: typeof args.user_request_verbatim === 'string' ? args.user_request_verbatim : '',
      contextRefs: Array.isArray(args.context_refs) ? args.context_refs.map(String) : [],
      taskId: typeof args.task_id === 'string' && args.task_id.trim()
        ? args.task_id
        : deps.taskId ?? null,
    },
    deps,
  )
  return createToolExecutionOutput(outcomeText(outcome), {
    shape: 'json',
    data: { outcome },
  })
}
