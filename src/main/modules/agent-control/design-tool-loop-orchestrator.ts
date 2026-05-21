import type { ToolPolicy } from './tool-policy/execution-tool-config'
import type { RunBudgetHint } from './contracts/run-contracts'

interface ToolCallLike {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface DesignToolLoopState {
  primaryArtifactProduced: boolean
  lastPrimaryDesignToolPayload: Record<string, unknown> | null
  lastPrimaryDesignToolRawResult: string | null
}

export interface DesignStructuredTaskPayload {
  module: 'design'
  message: string
  taskTitle: string
  taskSummary: string
  steps: Array<{
    id: string
    title: string
    status: 'blocked' | 'done'
    updatedAt: string
  }>
  currentStepId: string
  waitingFor: 'none'
  resumableActions: ['cancel'] | ['retry', 'cancel']
  blockedReason?: string | null
}

const PREFERRED_DESIGN_REPEAT_MESSAGE =
  '系统检查：本轮已经生成过主版式，不要再次新建额外版面。请基于当前真实设计结果总结，或只调用 design_verify_layout / design_list_owned_nodes 这类复查工具。'

export class DesignToolLoopOrchestrator {
  createState(): DesignToolLoopState {
    return {
      primaryArtifactProduced: false,
      lastPrimaryDesignToolPayload: null,
      lastPrimaryDesignToolRawResult: null,
    }
  }

  applySourceInput(
    toolCall: ToolCallLike,
    policy: ToolPolicy,
  ): ToolCallLike {
    if (!policy.forceDesignTool) return toolCall
    if (!toolCall.name.startsWith('design_')) return toolCall
    if (!policy.primaryDesignInstruction) return toolCall

    return {
      ...toolCall,
      input: {
        ...toolCall.input,
        designDirectiveText: typeof toolCall.input.designDirectiveText === 'string' && toolCall.input.designDirectiveText.trim()
          ? toolCall.input.designDirectiveText
          : policy.primaryDesignInstruction,
      },
    }
  }

  filterToolCalls(params: {
    toolCalls: ToolCallLike[]
    policy: ToolPolicy
    primaryArtifactProduced: boolean
  }): {
    toolCalls: ToolCallLike[]
    droppedCount: number
    nextUserMessage?: string
  } {
    const firstPassFiltered = this.filterSingleArtifactToolCalls(params.toolCalls, params.policy)
    const repeatedPrimaryBlocked =
      params.policy.forceDesignTool &&
      !params.policy.allowMultipleDesignArtifacts &&
      params.primaryArtifactProduced &&
      params.policy.preferredDesignTool
        ? firstPassFiltered.filter((toolCall) => toolCall.name !== params.policy.preferredDesignTool)
        : firstPassFiltered

    return {
      toolCalls: repeatedPrimaryBlocked,
      droppedCount: params.toolCalls.length - firstPassFiltered.length,
      nextUserMessage:
        repeatedPrimaryBlocked.length === 0 && params.toolCalls.length > 0
          ? PREFERRED_DESIGN_REPEAT_MESSAGE
          : undefined,
    }
  }

  recordToolResult(params: {
    state: DesignToolLoopState
    toolName: string
    rawResult: string
    policy: ToolPolicy
  }): { state: DesignToolLoopState; isPrimaryArtifact: boolean } {
    if (!this.isPrimaryArtifactTool(params.toolName, params.policy)) {
      return { state: params.state, isPrimaryArtifact: false }
    }

    return {
      state: {
        primaryArtifactProduced: true,
        lastPrimaryDesignToolPayload: this.parseStructuredToolResult(params.rawResult),
        lastPrimaryDesignToolRawResult: params.rawResult,
      },
      isPrimaryArtifact: true,
    }
  }

  buildCompletionText(state: DesignToolLoopState): string | null {
    const payload = state.lastPrimaryDesignToolPayload
    const rawResult = state.lastPrimaryDesignToolRawResult
    const status = payload && typeof payload.status === 'string' ? payload.status : null
    const summary = payload && typeof payload.summary === 'string' && payload.summary.trim()
      ? payload.summary.trim()
      : payload && typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : ''
    const reviewSummary = payload && payload.review && typeof payload.review === 'object' && typeof (payload.review as { summary?: unknown }).summary === 'string'
      ? String((payload.review as { summary?: unknown }).summary)
      : ''
    const parts = [
      summary,
      reviewSummary && reviewSummary !== summary ? reviewSummary : null,
      status === 'failed' ? '本轮验收未通过，已停止继续自动重做；请根据当前结果继续修订。' : null,
      status === 'cancelled' ? '本轮设计已停止。' : null,
    ].filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
    if (rawResult && /\bcancel(?:led)?\b/i.test(rawResult)) return '本轮设计已停止。'
    if (rawResult) return '本轮设计已执行完成，请基于当前结果继续修订。'
    return null
  }

  buildStructuredTaskPayload(params: {
    taskTitle: string
    taskSummary: string
    state: DesignToolLoopState
    phase: 'blocked' | 'done'
  }): DesignStructuredTaskPayload {
    const timestamp = new Date().toISOString()
    const status = params.phase === 'done' ? 'done' : 'blocked'
    return {
      module: 'design',
      message: params.taskSummary,
      taskTitle: params.taskTitle,
      taskSummary: params.taskSummary,
      steps: [{
        id: 'execute',
        title: params.taskTitle,
        status,
        updatedAt: timestamp,
      }],
      currentStepId: 'execute',
      waitingFor: 'none',
      resumableActions: params.phase === 'done' ? ['cancel'] : ['retry', 'cancel'],
      blockedReason: params.phase === 'blocked' ? params.taskSummary : null,
    }
  }

  getBudgetHint(params: {
    forceDesignTool: boolean
    primaryArtifactProduced: boolean
  }): RunBudgetHint | null {
    if (!params.forceDesignTool) {
      return null
    }
    return {
      reserveToolCalls: params.primaryArtifactProduced ? 1 : 2,
    }
  }

  private isPrimaryArtifactTool(toolName: string, policy: ToolPolicy): boolean {
    if (!policy.forceDesignTool) return false
    if (!policy.preferredDesignTool) return false
    return toolName === policy.preferredDesignTool
  }

  private filterSingleArtifactToolCalls(
    toolCalls: ToolCallLike[],
    policy: ToolPolicy,
  ): ToolCallLike[] {
    if (!policy.forceDesignTool || policy.allowMultipleDesignArtifacts) return toolCalls
    if (!policy.preferredDesignTool) return toolCalls

    let keptPrimary = false
    const filtered: ToolCallLike[] = []
    for (const toolCall of toolCalls) {
      if (toolCall.name !== policy.preferredDesignTool) {
        filtered.push(toolCall)
        continue
      }
      if (!keptPrimary) {
        filtered.push(toolCall)
        keptPrimary = true
      }
    }
    return filtered
  }

  private parseStructuredToolResult(result: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(result) as unknown
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}
