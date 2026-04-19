import type { DocumentWidgetTaskKind } from '../claude-bridge/tool-policy-heuristics'
import type { RunBudgetHint } from './run-contracts'
import {
  accumulateDocumentToolProgress,
  buildDocumentToolCompletionText,
  shouldPreferDocumentInspectionResult,
  type DocumentToolInspection,
  type DocumentToolProgressState,
} from '../claude-bridge/document-tool-flow'
import { buildUserFacingInspectionSummary } from '../../../shared/document-widget-parse'
import { logAgentMetric } from './metrics'

export type DocumentToolLoopOrchestratorDeps = {
  logMetric?: (name: string, payload: Record<string, unknown>) => void
}

export interface DocumentToolLoopState {
  forceDocNudges: number
  forceDocMutationNudges: number
  forceDocSaveNudges: number
  forceDocInspectionResultNudges: number
  forceDocWidgetRecoveryNudges: number
  documentToolTaskCompleted: boolean
  documentToolProgress: DocumentToolProgressState | null
  lastDocumentInspectionResult: string | null
  lastWidgetValidationError: string | null
}

export interface DocumentNoToolCallDecision {
  state: DocumentToolLoopState
  nextUserMessage?: string
  finalText?: string
  preserveAssistantText?: boolean
  finish?: boolean
}

export interface DocumentIterationDecision {
  state: DocumentToolLoopState
  nextUserMessage?: string
  completionText?: string
  finish?: boolean
}

export interface DocumentStructuredTaskPayload {
  module: 'document'
  message: string
  taskTitle: string
  taskSummary: string
  steps: Array<{
    id: string
    title: string
    status: 'running' | 'blocked' | 'done'
    updatedAt: string
  }>
  currentStepId: string
  waitingFor: 'none'
  resumableActions: ['cancel'] | ['retry', 'cancel']
  blockedReason?: string | null
}

export class DocumentToolLoopOrchestrator {
  private readonly logMetric: (name: string, payload: Record<string, unknown>) => void

  constructor(deps: DocumentToolLoopOrchestratorDeps = {}) {
    this.logMetric = deps.logMetric ?? logAgentMetric
  }

  createState(initial?: Partial<DocumentToolLoopState>): DocumentToolLoopState {
    return {
      forceDocNudges: initial?.forceDocNudges || 0,
      forceDocMutationNudges: initial?.forceDocMutationNudges || 0,
      forceDocSaveNudges: initial?.forceDocSaveNudges || 0,
      forceDocInspectionResultNudges: initial?.forceDocInspectionResultNudges || 0,
      forceDocWidgetRecoveryNudges: initial?.forceDocWidgetRecoveryNudges || 0,
      documentToolTaskCompleted: initial?.documentToolTaskCompleted || false,
      documentToolProgress: initial?.documentToolProgress || null,
      lastDocumentInspectionResult: initial?.lastDocumentInspectionResult || null,
      lastWidgetValidationError: initial?.lastWidgetValidationError || null,
    }
  }

  applyToolInspection(
    state: DocumentToolLoopState,
    inspection: DocumentToolInspection,
  ): DocumentToolLoopState {
    if (!inspection.isDocumentTool) return state
    let nextState = state
    if (inspection.clearInspectionResult) {
      nextState = {
        ...nextState,
        lastDocumentInspectionResult: null,
        lastWidgetValidationError: inspection.widgetValidationError,
      }
    }
    if (inspection.inspectionResult) {
      nextState = {
        ...nextState,
        lastDocumentInspectionResult: inspection.inspectionResult,
      }
    }
    return nextState
  }

  handleNoToolCall(params: {
    state: DocumentToolLoopState
    forceDocumentTool: boolean
    responseText?: string
    toolTransport?: 'native' | 'text'
  }): DocumentNoToolCallDecision {
    if (!params.forceDocumentTool) {
      return { state: params.state }
    }

    if (
      params.state.lastDocumentInspectionResult &&
      shouldPreferDocumentInspectionResult(
        params.responseText,
        params.state.lastDocumentInspectionResult,
        params.toolTransport,
      )
    ) {
      if (params.state.forceDocInspectionResultNudges < 1) {
        return {
          state: {
            ...params.state,
            forceDocInspectionResultNudges: params.state.forceDocInspectionResultNudges + 1,
          },
          nextUserMessage: '系统检查：你刚执行了 document_list_widgets。请直接把工具返回的列表结果交付给用户，不要解释过程，也不要只描述你调用了工具。',
          preserveAssistantText: params.toolTransport !== 'text',
        }
      }
      const sanitized = buildUserFacingInspectionSummary(params.state.lastDocumentInspectionResult)
      this.logMetric('tool_resolution_violation_post_arbitration', {
        stage: 'document_tool_loop_orchestrator',
        reason: 'inspection_result_used_as_final_text',
        toolTransport: params.toolTransport || 'unknown',
        forceDocInspectionResultNudges: params.state.forceDocInspectionResultNudges,
        responseTextLen: (params.responseText || '').length,
        responseTextSample: (params.responseText || '').slice(0, 80),
      })
      return {
        state: params.state,
        finalText: sanitized,
        finish: true,
      }
    }

    if (!params.state.documentToolTaskCompleted && params.state.forceDocNudges < 2) {
      return {
        state: {
          ...params.state,
          forceDocNudges: params.state.forceDocNudges + 1,
        },
        nextUserMessage: '系统检查：你还没有执行真实文档修改。请按你自己的计划调用 document_* 工具完成编辑，而不是仅给文字说明。',
        preserveAssistantText: params.toolTransport !== 'text',
      }
    }

    return { state: params.state }
  }

  handleIterationResult(params: {
    state: DocumentToolLoopState
    forceDocumentTool: boolean
    documentWidgetTaskKind?: DocumentWidgetTaskKind | null
    executedDocActionCount: number
    executedMutatingDocActionCount: number
    executedInspectionDocActionCount: number
    executedSaveDocActionCount: number
    documentToolResultsThisIteration: string[]
  }): DocumentIterationDecision {
    if (!params.forceDocumentTool) {
      return { state: params.state }
    }

    const nextState: DocumentToolLoopState = {
      ...params.state,
      documentToolTaskCompleted:
        params.state.documentToolTaskCompleted ||
        params.executedMutatingDocActionCount > 0 ||
        params.executedInspectionDocActionCount > 0,
      documentToolProgress: accumulateDocumentToolProgress(params.state.documentToolProgress, {
        executedMutatingDocActionCount: params.executedMutatingDocActionCount,
        executedSaveDocActionCount: params.executedSaveDocActionCount,
        toolResults: params.documentToolResultsThisIteration,
      }),
    }

    const cumulativeMutatingDocActionCount = nextState.documentToolProgress?.executedMutatingDocActionCount || 0
    const cumulativeSaveDocActionCount = nextState.documentToolProgress?.executedSaveDocActionCount || 0

    if (
      params.documentWidgetTaskKind &&
      nextState.lastWidgetValidationError &&
      nextState.forceDocWidgetRecoveryNudges < 1
    ) {
      return {
        state: {
          ...nextState,
          forceDocWidgetRecoveryNudges: nextState.forceDocWidgetRecoveryNudges + 1,
        },
        nextUserMessage: `系统检查：你刚生成的 widget 结果不合格：${nextState.lastWidgetValidationError}。请不要结束，改用更稳妥的实现方式重新生成并再次调用正确的 widget 工具。优先保留简洁结构，避免继续使用 document_append_content。`,
      }
    }

    if (
      params.executedDocActionCount > 0 &&
      params.executedMutatingDocActionCount === 0 &&
      params.executedInspectionDocActionCount === 0 &&
      params.executedSaveDocActionCount === 0 &&
      cumulativeMutatingDocActionCount === 0 &&
      nextState.forceDocMutationNudges < 2
    ) {
      return {
        state: {
          ...nextState,
          forceDocMutationNudges: nextState.forceDocMutationNudges + 1,
        },
        nextUserMessage: '系统检查：你目前只完成了文档定位/切换，还没有执行内容修改。请继续调用合适的 document_* 编辑工具落实你的方案。',
      }
    }

    if (
      cumulativeMutatingDocActionCount > 0 &&
      cumulativeSaveDocActionCount === 0 &&
      params.executedSaveDocActionCount === 0 &&
      nextState.forceDocSaveNudges < 2
    ) {
      return {
        state: {
          ...nextState,
          forceDocSaveNudges: nextState.forceDocSaveNudges + 1,
        },
        nextUserMessage: '系统检查：你已执行内容修改但尚未保存。请调用 document_save_tab 完成保存，再给出最终结论。',
      }
    }

    const completionText = buildDocumentToolCompletionText({
      forceDocumentTool: params.forceDocumentTool,
      executedMutatingDocActionCount: cumulativeMutatingDocActionCount,
      executedSaveDocActionCount: cumulativeSaveDocActionCount,
      lastWidgetValidationError: nextState.lastWidgetValidationError,
      toolResults: nextState.documentToolProgress?.toolResults || [],
    })

    if (completionText) {
      return {
        state: nextState,
        completionText,
        finish: true,
      }
    }

    return { state: nextState }
  }

  buildStructuredTaskPayload(params: {
    taskTitle: string
    taskSummary: string
    state: DocumentToolLoopState
    phase: 'blocked' | 'done'
  }): DocumentStructuredTaskPayload {
    const timestamp = new Date().toISOString()
    const status = params.phase === 'done' ? 'done' : 'blocked'
    return {
      module: 'document',
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
    forceDocumentTool: boolean
    state: DocumentToolLoopState
  }): RunBudgetHint | null {
    if (!params.forceDocumentTool) {
      return null
    }
    return {
      reserveToolCalls: params.state.documentToolTaskCompleted ? 1 : 2,
    }
  }
}
