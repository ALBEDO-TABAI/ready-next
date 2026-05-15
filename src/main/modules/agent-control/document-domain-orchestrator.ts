import type { AIModelConfig } from '../../../shared/ai-providers'
import type { ToolContext } from '../tools/tool-executor'
import {
  createToolExecutionOutput,
  serializeToolExecutionOutput,
  type ToolExecutionOutput,
} from './tool-result-types'
import {
  applyFormatSectionByPath,
  applyRewriteSectionByPath,
  buildSectionRewriteDraft,
  parseSectionRewritePlan,
  stripCodeFence,
  type DocumentChatSessionLike,
  type SectionRewritePlan,
} from './document-domain-helpers'

function hasToolErrorKind(result: ToolExecutionOutput): boolean {
  return Boolean(result.data && typeof result.data.errorKind === 'string')
}

function isDocumentActionFailureText(text: string): boolean {
  return /(?:^Error:|Document action failed|failed|失败|无法|没有可|未匹配到|未找到|缺少|已拒绝|被拒绝|已取消|被取消)/i.test(text)
}

function isDocumentNoMutationText(text: string): boolean {
  return /(?:内容未变化|无变化|未做改动|已跳过|已是目标格式)/i.test(text)
}

function isDocumentActionFailure(result: ToolExecutionOutput): boolean {
  return hasToolErrorKind(result) || isDocumentActionFailureText(result.text)
}

export class DocumentDomainOrchestrator {
  constructor(private readonly deps: {
    log: (message: string) => void
    executeToolCall: (name: string, input: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionOutput>
    emitOutput: (payload: {
      agent: string
      chunk: string
      type: 'text' | 'tool_use' | 'tool_result'
      projectionPatch?: Record<string, unknown> | null
    }) => void
    emitToolAction: (payload: { agent: string; tool: string; args: Record<string, unknown> }) => void
    extractPrimaryUserInstruction: (raw: string) => string
    extractSectionTitleFromUserText: (raw: string) => string | null
    extractDocumentPathFromUserText: (raw: string) => string | null
    callKimiCodingSimple: (
      session: DocumentChatSessionLike,
      config: AIModelConfig,
      baseUrl: string,
      signal: AbortSignal,
    ) => Promise<string>
    callAnthropicSimple: (
      session: DocumentChatSessionLike,
      config: AIModelConfig,
      baseUrl: string,
      signal: AbortSignal,
    ) => Promise<string>
    callOpenAISimple: (
      session: DocumentChatSessionLike,
      config: AIModelConfig,
      baseUrl: string,
      provider: unknown,
      signal: AbortSignal,
      isKimi?: boolean,
      enableKimiWebSearch?: boolean,
    ) => Promise<string>
  }) {}

  private emitStructuredTaskPatch(params: {
    agentName: string
    taskTitle: string
    taskSummary: string
    detailTitle: string
  }): void {
    const timestamp = new Date().toISOString()
    const result = createToolExecutionOutput(params.taskSummary, {
      projectionPatch: {
        module: 'document',
        message: params.taskSummary,
        taskTitle: params.taskTitle,
        taskSummary: params.taskSummary,
        steps: [{
          id: 'execute',
          title: params.detailTitle,
          status: 'done',
          updatedAt: timestamp,
        }],
        currentStepId: 'execute',
        waitingFor: 'none',
        resumableActions: ['cancel'],
      },
    })
    this.deps.emitOutput({
      agent: params.agentName,
      type: 'tool_result',
      chunk: serializeToolExecutionOutput(result),
      projectionPatch: result.projectionPatch,
    })
  }

  async tryDeterministicSectionFormatFlow(params: {
    agentName: string
    userText: string
    toolContext: ToolContext
    onAssistantSummary?: (summary: string) => void
  }): Promise<boolean> {
    const { agentName, userText, toolContext, onAssistantSummary } = params
    try {
      const instructionText = this.deps.extractPrimaryUserInstruction(userText)
      const sectionTitle = this.deps.extractSectionTitleFromUserText(instructionText)
      const targetScope = sectionTitle ? `章节 ${sectionTitle}` : '整篇文档'
      const targetPath = this.deps.extractDocumentPathFromUserText(userText)

      this.deps.log(`deterministic section format flow start, scope=${targetScope}, path=${targetPath || '(active-tab)'}`)

      if (targetPath && targetPath.startsWith('/')) {
        const directResult = await applyFormatSectionByPath(targetPath, sectionTitle)
        this.deps.log(`deterministic section format direct result=${directResult.message}`)
        if (directResult.success) {
          this.deps.emitToolAction({ agent: agentName, tool: 'document.openFile', args: { path: targetPath } })
          const summary = [
            `已执行格式优化：${targetScope}`,
            `- 文件: ${targetPath}`,
            `- ${directResult.message}`,
          ].join('\n')
          this.emitStructuredTaskPatch({
            agentName,
            taskTitle: '文档格式优化',
            taskSummary: `已完成：${targetScope}`,
            detailTitle: targetScope,
          })
          this.deps.emitOutput({ agent: agentName, chunk: summary, type: 'text' })
          onAssistantSummary?.(summary)
          return true
        }
        this.deps.log(`deterministic section format fallback to tool chain: ${directResult.message}`)
      }

      if (targetPath) {
        this.deps.emitOutput({
          agent: agentName,
          chunk: `document_open_tab(${JSON.stringify({ path: targetPath }).slice(0, 180)})`,
          type: 'tool_use',
        })
        const openResult = await this.deps.executeToolCall('document_open_tab', { path: targetPath }, toolContext)
        this.deps.emitOutput({ agent: agentName, chunk: openResult.text.slice(0, 200), type: 'tool_result' })
        this.deps.log(`deterministic section format open result=${openResult.text.slice(0, 180)}`)
        if (isDocumentActionFailure(openResult)) return false
      }

      const formatArgs = { sectionTitle: sectionTitle || '第一部分', style: 'readable' }
      this.deps.emitOutput({
        agent: agentName,
        chunk: `document_format_section(${JSON.stringify(formatArgs).slice(0, 180)})`,
        type: 'tool_use',
      })
      const formatResult = await this.deps.executeToolCall('document_format_section', formatArgs, toolContext)
      this.deps.emitOutput({ agent: agentName, chunk: formatResult.text.slice(0, 200), type: 'tool_result' })
      this.deps.log(`deterministic section format result=${formatResult.text.slice(0, 180)}`)
      if (isDocumentActionFailure(formatResult) || isDocumentNoMutationText(formatResult.text)) {
        return false
      }

      this.deps.emitOutput({
        agent: agentName,
        chunk: 'document_save_tab({})',
        type: 'tool_use',
      })
      const saveResult = await this.deps.executeToolCall('document_save_tab', {}, toolContext)
      this.deps.emitOutput({ agent: agentName, chunk: saveResult.text.slice(0, 200), type: 'tool_result' })
      this.deps.log(`deterministic section format save result=${saveResult.text.slice(0, 180)}`)
      if (isDocumentActionFailure(saveResult)) return false

      const summary = [
        `已执行格式优化：${targetScope}`,
        '- 已保持原意，仅调整排版结构',
        `- ${formatResult.text}`,
        `- ${saveResult.text}`,
      ].join('\n')
      this.emitStructuredTaskPatch({
        agentName,
        taskTitle: '文档格式优化',
        taskSummary: `已完成：${targetScope}`,
        detailTitle: targetScope,
      })
      this.deps.emitOutput({ agent: agentName, chunk: summary, type: 'text' })
      onAssistantSummary?.(summary)
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.log(`deterministic section format failed: ${msg}`)
      return false
    }
  }

  async tryDeterministicSectionRewriteFlow(params: {
    agentName: string
    session: DocumentChatSessionLike
    config: AIModelConfig
    baseUrl: string
    provider: unknown
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    userText: string
    toolContext: ToolContext
    onAssistantSummary: (summary: string) => void
  }): Promise<boolean> {
    const {
      agentName,
      session,
      config,
      baseUrl,
      provider,
      signal,
      isKimi,
      isKimiCoding,
      useAnthropicProtocol,
      userText,
      toolContext,
      onAssistantSummary,
    } = params

    try {
      this.deps.log('deterministic section rewrite flow start')
      const instructionText = this.deps.extractPrimaryUserInstruction(userText)
      const draft = await buildSectionRewriteDraft({
        session,
        config,
        baseUrl,
        provider,
        signal,
        isKimi,
        isKimiCoding,
        useAnthropicProtocol,
        callKimiCodingSimple: this.deps.callKimiCodingSimple,
        callAnthropicSimple: this.deps.callAnthropicSimple,
        callOpenAISimple: this.deps.callOpenAISimple,
      })
      this.deps.log(`deterministic section rewrite draft chars=${draft.length}`)

      const plan = parseSectionRewritePlan(draft)
      const fallbackTitle = this.deps.extractSectionTitleFromUserText(instructionText) || '第一部分'
      const finalPlan: SectionRewritePlan = plan || {
        sectionTitle: fallbackTitle,
        content: stripCodeFence(draft),
      }

      if (!finalPlan.content || finalPlan.content.length < 8) {
        this.deps.log('deterministic section rewrite skipped: empty draft content')
        return false
      }

      const targetPath = this.deps.extractDocumentPathFromUserText(userText)
      if (targetPath && targetPath.startsWith('/')) {
        const directResult = await applyRewriteSectionByPath(
          targetPath,
          finalPlan.sectionTitle,
          finalPlan.content,
        )
        this.deps.log(`deterministic section rewrite direct result=${directResult.message}`)
        if (directResult.success) {
          this.deps.emitToolAction({ agent: agentName, tool: 'document.openFile', args: { path: targetPath } })
          const summary = [
            `已执行章节改写：${finalPlan.sectionTitle}`,
            `- 文件: ${targetPath}`,
            `- ${directResult.message}`,
          ].join('\n')
          this.emitStructuredTaskPatch({
            agentName,
            taskTitle: '章节改写',
            taskSummary: `已完成：${finalPlan.sectionTitle}`,
            detailTitle: finalPlan.sectionTitle,
          })
          this.deps.emitOutput({ agent: agentName, chunk: summary, type: 'text' })
          onAssistantSummary(summary)
          return true
        }
        this.deps.log(`deterministic section rewrite fallback to tool chain: ${directResult.message}`)
      }

      if (targetPath) {
        this.deps.emitOutput({
          agent: agentName,
          chunk: `document_open_tab(${JSON.stringify({ path: targetPath }).slice(0, 180)})`,
          type: 'tool_use',
        })
        const openResult = await this.deps.executeToolCall('document_open_tab', { path: targetPath }, toolContext)
        this.deps.emitOutput({ agent: agentName, chunk: openResult.text.slice(0, 200), type: 'tool_result' })
        this.deps.log(`deterministic section rewrite open result=${openResult.text.slice(0, 180)}`)
        if (isDocumentActionFailure(openResult)) return false
      }

      const rewriteArgs: Record<string, unknown> = {
        sectionTitle: finalPlan.sectionTitle,
        content: finalPlan.content,
      }
      this.deps.emitOutput({
        agent: agentName,
        chunk: `document_rewrite_section(${JSON.stringify(rewriteArgs).slice(0, 180)})`,
        type: 'tool_use',
      })
      const rewriteResult = await this.deps.executeToolCall('document_rewrite_section', rewriteArgs, toolContext)
      this.deps.emitOutput({ agent: agentName, chunk: rewriteResult.text.slice(0, 200), type: 'tool_result' })
      this.deps.log(`deterministic section rewrite tool result=${rewriteResult.text.slice(0, 180)}`)
      if (isDocumentActionFailure(rewriteResult) || isDocumentNoMutationText(rewriteResult.text)) {
        return false
      }

      this.deps.emitOutput({
        agent: agentName,
        chunk: 'document_save_tab({})',
        type: 'tool_use',
      })
      const saveResult = await this.deps.executeToolCall('document_save_tab', {}, toolContext)
      this.deps.emitOutput({ agent: agentName, chunk: saveResult.text.slice(0, 200), type: 'tool_result' })
      this.deps.log(`deterministic section rewrite save result=${saveResult.text.slice(0, 180)}`)
      if (isDocumentActionFailure(saveResult)) return false

      const summary = [
        `已执行章节改写：${finalPlan.sectionTitle}`,
        `- ${rewriteResult.text}`,
        `- ${saveResult.text}`,
      ].join('\n')
      this.emitStructuredTaskPatch({
        agentName,
        taskTitle: '章节改写',
        taskSummary: `已完成：${finalPlan.sectionTitle}`,
        detailTitle: finalPlan.sectionTitle,
      })
      this.deps.emitOutput({ agent: agentName, chunk: summary, type: 'text' })
      onAssistantSummary(summary)
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.log(`deterministic section rewrite failed: ${msg}`)
      return false
    }
  }
}
