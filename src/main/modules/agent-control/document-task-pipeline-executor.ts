import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { getProviderDef, type AIModelConfig } from '../../../shared/ai-providers'
import { buildFocusedDocumentContext } from '../../../shared/document-sectioning'
import type { DocumentWidgetComponentSpec } from '../../../shared/document-widget-openui'
import { readDocumentEditableText } from '../document-engine/ipc-handler'
import { type DomainAdapterDispatchResult } from './domain-adapter'
import { classifyStructuredDocumentIntent } from './document-task-types'
import { buildDocumentTaskStepCacheKey } from './document-task-cache-key'
import { DocumentInsightCache } from './document-insight-cache'
import { buildDocumentInsightSourceMaterial } from './document-source-materials'
import { runDocumentTaskPlanWithSubtasks } from './document-task-subtask-runner'
import {
  DocumentTaskPipeline,
  type ActiveDocumentSnapshot,
  type DocumentInsight,
  type DocumentInsightMetrics,
  type DocumentInsightStageResult,
  type DocumentReadPlan,
  type DocumentStructuredTaskType,
  type DocumentTaskPipelinePhaseUpdate,
  type DocumentWidgetDraft,
} from './document-task-pipeline'
import type { DocumentTaskJob, DocumentTaskPlan, DocumentTaskStep } from './document-task-plan'
import type { ExecutionIntentContext } from './execution-intent-resolver'
import type { ToolPolicy } from './execution-tool-config'
import type { RequestEnvelope, RequestEnvelopeResource } from './request-envelope'
import type { ProjectionTruthSnapshot, TurnProviderContext } from './run-contracts'
import { SubtaskRuntime } from './subtask-runtime'
import type { ConversationScope, ScopeRunEventPayload } from './types'

interface DocumentPipelineCacheSession {
  activeRunId: string | null
  documentInsightCache: Array<{
    key: string
    insight: DocumentInsight
    metrics?: DocumentInsightMetrics
    createdAt: string
  }>
  documentWidgetDraftCache: Array<{
    key: string
    draft: DocumentWidgetDraft
    createdAt: string
  }>
}

interface DocumentPipelineSimpleSession {
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string | Array<Record<string, unknown>>
  }>
  abortController: null
  systemPrompt: string
  generation: number
  activeRunId: null
  preferTextToolBridge: false
  lastDocumentContextInput: null
  documentInsightCache: []
  documentWidgetDraftCache: []
}

interface DocumentTaskPipelineExecutorDeps {
  log: (message: string) => void
  requestKimiCodingSimple: (params: {
    session: DocumentPipelineSimpleSession
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    timeoutMs: number
  }) => Promise<string>
  requestAnthropicSimple: (params: {
    session: DocumentPipelineSimpleSession
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    timeoutMs: number
  }) => Promise<string>
  requestOpenAISimple: (params: {
    session: DocumentPipelineSimpleSession
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef> | undefined
    signal: AbortSignal
    isKimi: boolean
    enableKimiWebSearch: boolean
    timeoutMs: number
  }) => Promise<string>
  getConversationScope?: (scopeId: string) => ConversationScope | null
  publishScopeRunEvent?: (
    payload: ScopeRunEventPayload,
    projectionTruth?: ProjectionTruthSnapshot | null,
  ) => void | Promise<void>
  createSubtaskRuntime?: () => SubtaskRuntime
}

export interface DocumentTaskPipelineExecutionParams {
  route: {
    taskId: string
    chain: string
    executor: string
  }
  executionIntentContext: ExecutionIntentContext
  hasTools: boolean
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  signal: AbortSignal
  session: DocumentPipelineCacheSession
  providerContext: TurnProviderContext
  emitStructuredTaskPayload: (payload: unknown) => void
  scopeId?: string
  parentTaskId?: string
  parentRunId?: string | null
  toolPolicy: ToolPolicy
  domainState?: unknown
}

interface DocumentTaskPipelineExecutionResult {
  handled: boolean
  result?: DomainAdapterDispatchResult
}

export class DocumentTaskPipelineExecutor {
  private readonly documentInsightCache = new DocumentInsightCache()
  private readonly documentWidgetDraftCache = new Map<string, DocumentWidgetDraft>()

  constructor(private readonly deps: DocumentTaskPipelineExecutorDeps) {}

  async tryExecute(params: DocumentTaskPipelineExecutionParams): Promise<DocumentTaskPipelineExecutionResult> {
    const preferredSkillToolNames = params.toolPolicy.preferredSkillToolNames || null
    const canHandleDocumentShortcut =
      params.route.executor === 'document'
      && params.route.chain === 'domain_executor'
      && params.hasTools
      && Boolean(params.requestModuleToolAction)
      && !(preferredSkillToolNames && preferredSkillToolNames.length > 0)

    if (!canHandleDocumentShortcut) {
      return { handled: false }
    }

    if (params.executionIntentContext.shouldUseDocumentTaskPlan && params.executionIntentContext.documentTaskPlan) {
      const planResult = await this.runDocumentTaskPlan({
        plan: params.executionIntentContext.documentTaskPlan,
        requestEnvelope: params.executionIntentContext.requestEnvelope,
        session: params.session,
        scopeId: params.scopeId,
        parentTaskId: params.parentTaskId || params.route.taskId,
        parentRunId: params.parentRunId || params.session.activeRunId || null,
        requestModuleToolAction: params.requestModuleToolAction!,
        signal: params.signal,
        providerContext: params.providerContext,
        emitStructuredTaskPayload: params.emitStructuredTaskPayload,
      })

      if (!planResult.success && !planResult.finalText) {
        throw new Error(planResult.error || '文档任务计划执行失败')
      }

      return {
        handled: true,
        result: this.buildDispatchResult({
          domainState: params.domainState,
          success: planResult.success,
          finalText: planResult.finalText || null,
          error: planResult.error,
        }),
      }
    }

    if (
      params.executionIntentContext.structuredDocumentIntent === 'document_read_then_widget_create'
      || params.executionIntentContext.structuredDocumentIntent === 'document_read_then_widget_update'
    ) {
      const pipelineResult = await this.runDocumentWidgetPipeline({
        structuredIntent: params.executionIntentContext.structuredDocumentIntent,
        executionIntentContext: params.executionIntentContext,
        requestModuleToolAction: params.requestModuleToolAction!,
        signal: params.signal,
        session: params.session,
        providerContext: params.providerContext,
        emitStructuredTaskPayload: params.emitStructuredTaskPayload,
      })

      if (!pipelineResult.success && !pipelineResult.finalText) {
        throw new Error(pipelineResult.error || '文档信息卡 pipeline 失败')
      }

      return {
        handled: true,
        result: this.buildDispatchResult({
          domainState: params.domainState,
          success: pipelineResult.success,
          finalText: pipelineResult.finalText || null,
          error: pipelineResult.error,
        }),
      }
    }

    return { handled: false }
  }

  private buildDispatchResult(params: {
    domainState?: unknown
    success: boolean
    finalText?: string | null
    error?: string
  }): DomainAdapterDispatchResult {
    return {
      domainState: params.domainState,
      interactionState: 'running',
      finalText: params.finalText || null,
      finish: {
        status: params.success ? 'done' : 'error',
        success: params.success,
      },
    }
  }

  private createPipelineSession(
    systemPrompt: string,
    userPrompt: string,
    options?: { includeSystemMessage?: boolean },
  ): DocumentPipelineSimpleSession {
    const messages = options?.includeSystemMessage
      ? [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userPrompt },
      ]
      : [{ role: 'user' as const, content: userPrompt }]
    return {
      messages,
      abortController: null,
      systemPrompt,
      generation: 0,
      activeRunId: null,
      preferTextToolBridge: false,
      lastDocumentContextInput: null,
      documentInsightCache: [],
      documentWidgetDraftCache: [],
    }
  }

  private async requestDocumentPipelineSimpleText(params: {
    systemPrompt: string
    userPrompt: string
    providerContext: TurnProviderContext
    signal: AbortSignal
    timeoutMs: number
  }): Promise<string> {
    if (params.providerContext.isKimiCoding) {
      return this.deps.requestKimiCodingSimple({
        session: this.createPipelineSession(params.systemPrompt, params.userPrompt, { includeSystemMessage: true }),
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      })
    }

    if (params.providerContext.useAnthropicProtocol) {
      return this.deps.requestAnthropicSimple({
        session: this.createPipelineSession(params.systemPrompt, params.userPrompt),
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      })
    }

    return this.deps.requestOpenAISimple({
      session: this.createPipelineSession(params.systemPrompt, params.userPrompt),
      config: params.providerContext.config,
      baseUrl: params.providerContext.baseUrl,
      provider: params.providerContext.provider as ReturnType<typeof getProviderDef> | undefined,
      signal: params.signal,
      isKimi: params.providerContext.isKimi,
      enableKimiWebSearch: false,
      timeoutMs: params.timeoutMs,
    })
  }

  private parsePipelineJson<T extends Record<string, unknown>>(raw: string): T | null {
    if (!raw) return null
    const candidates: string[] = []
    const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi
    let fencedMatch: RegExpExecArray | null = fencedRegex.exec(raw)
    while (fencedMatch) {
      if (fencedMatch[1]?.trim()) candidates.push(fencedMatch[1].trim())
      fencedMatch = fencedRegex.exec(raw)
    }
    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(raw.slice(firstBrace, lastBrace + 1))
    }
    candidates.push(raw.trim())

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as T
        if (parsed && typeof parsed === 'object') return parsed
      } catch {
        // Try next candidate.
      }
    }
    return null
  }

  private normalizePipelineInsight(
    raw: Record<string, unknown>,
    question: string,
    sourceDocument: {
      title: string
      path: string | null
    },
  ): DocumentInsight {
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    const keyPoints = Array.isArray(raw.keyPoints)
      ? raw.keyPoints.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const quote = typeof (item as { quote?: unknown }).quote === 'string'
            ? (item as { quote: string }).quote.trim()
            : ''
          if (!quote) return null
          const sectionTitle = typeof (item as { sectionTitle?: unknown }).sectionTitle === 'string'
            ? String((item as { sectionTitle: string }).sectionTitle).trim()
            : undefined
          return { quote, sectionTitle }
        })
        .filter(Boolean) as Array<{ sectionTitle?: string; quote: string }>
      : []
    const recommendedWidget = (() => {
      const value = typeof raw.recommendedWidget === 'string' ? raw.recommendedWidget.trim() : ''
      switch (value) {
        case 'stats_card':
        case 'comparison_grid':
        case 'callout_block':
        case 'data_table':
          return value
        default:
          return 'info_card'
      }
    })()
    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map((item) => String(item || '').trim()).filter(Boolean)
      : undefined

    if (!summary || keyPoints.length === 0) {
      throw new Error('Document insight JSON 缺少 summary 或 keyPoints')
    }

    return {
      question,
      documentPath: sourceDocument.path,
      documentTitle: sourceDocument.title,
      summary,
      keyPoints,
      evidence,
      recommendedWidget,
      warnings,
    }
  }

  private slugifyWidgetTitle(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'document_summary_card'
  }

  private buildFallbackDocumentWidgetDraft(params: {
    insight: DocumentInsight
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
    targetWidgetTitle?: string
  }): DocumentWidgetDraft {
    const heading = params.snapshot.title.replace(/\.[^.]+$/, '') || '文档摘要'
    return {
      title: this.slugifyWidgetTitle(`${heading}_summary_card`),
      insertionMode: params.plan.operation === 'update' ? 'update_existing' : 'append_end',
      targetWidgetTitle: params.plan.operation === 'update'
        ? params.targetWidgetTitle?.trim() || undefined
        : undefined,
      componentSpec: {
        component: 'info_card',
        props: {
          heading,
          body: params.insight.summary,
          points: params.insight.keyPoints.slice(0, 4),
          tone: 'info',
        },
      },
    }
  }

  private getDocumentTaskJobTarget(job: DocumentTaskJob): RequestEnvelopeResource | null {
    return job.bindings.find((binding) => binding.role === 'target_document')?.resource || null
  }

  private getDocumentTaskJobSources(job: DocumentTaskJob): RequestEnvelopeResource[] {
    return job.bindings
      .filter((binding) => binding.role === 'primary_source' || binding.role === 'secondary_source')
      .map((binding) => binding.resource)
  }

  private buildDocumentTaskStepTitle(job: DocumentTaskJob, step: DocumentTaskStep, jobIndex: number, totalJobs: number): string {
    const sources = this.getDocumentTaskJobSources(job)
    const target = this.getDocumentTaskJobTarget(job)
    const sourceLabel = sources.map((resource) => resource.name).join(' + ') || '材料'
    const targetLabel = target?.name || '目标文档'
    const jobPrefix = totalJobs > 1 ? `${jobIndex + 1}. ` : ''

    switch (step) {
      case 'collect_materials':
        return `${jobPrefix}读取 ${sourceLabel}`
      case 'build_insight':
        return `${jobPrefix}提炼 ${sourceLabel}`
      case 'compose_widget':
        return `${jobPrefix}生成卡片草稿`
      case 'write_target':
        return `${jobPrefix}写入 ${targetLabel}`
      case 'save_target':
        return `${jobPrefix}保存 ${targetLabel}`
      case 'verify_result':
        return `${jobPrefix}核对 ${targetLabel}`
      default:
        return `${jobPrefix}${step}`
    }
  }

  private buildDocumentTaskStepId(job: DocumentTaskJob, step: DocumentTaskStep): string {
    return `${job.id}:${step}`
  }

  private buildDocumentWidgetDraftCacheKey(
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
  ): string {
    return buildDocumentTaskStepCacheKey({
      question,
      step: 'compose_widget',
      job,
      targetSnapshot: snapshot,
    })
  }

  private normalizePipelineWidgetDraft(
    raw: Record<string, unknown> | null,
    params: {
      insight: DocumentInsight
      snapshot: ActiveDocumentSnapshot
      plan: DocumentReadPlan
    },
  ): DocumentWidgetDraft {
    const rawTargetWidgetTitle = typeof raw?.targetWidgetTitle === 'string'
      ? raw.targetWidgetTitle.trim()
      : undefined
    const fallback = this.buildFallbackDocumentWidgetDraft({
      insight: params.insight,
      snapshot: params.snapshot,
      plan: params.plan,
      targetWidgetTitle: rawTargetWidgetTitle,
    })
    if (!raw) return fallback

    const title = typeof raw.title === 'string' ? raw.title.trim() : fallback.title
    const insertionMode = raw.insertionMode === 'after_section' || raw.insertionMode === 'update_existing'
      ? raw.insertionMode
      : params.plan.operation === 'update'
        ? 'update_existing'
        : 'append_end'
    const componentSpec = raw.componentSpec && typeof raw.componentSpec === 'object'
      ? raw.componentSpec as Record<string, unknown>
      : null
    if (!componentSpec) {
      return {
        ...fallback,
        title: this.slugifyWidgetTitle(title),
      }
    }
    if (typeof componentSpec.component !== 'string' || !componentSpec.component.trim()) {
      return {
        ...fallback,
        title: this.slugifyWidgetTitle(title),
      }
    }
    const normalizedComponentSpec: DocumentWidgetComponentSpec = {
      component: componentSpec.component.trim(),
      props: componentSpec.props && typeof componentSpec.props === 'object'
        ? componentSpec.props as Record<string, unknown>
        : undefined,
      dataSource: componentSpec.dataSource && typeof componentSpec.dataSource === 'object'
        ? componentSpec.dataSource as DocumentWidgetComponentSpec['dataSource']
        : undefined,
    }

    return {
      title: this.slugifyWidgetTitle(title),
      insertionMode,
      targetSectionTitle: typeof raw.targetSectionTitle === 'string' ? raw.targetSectionTitle.trim() : undefined,
      targetWidgetTitle: rawTargetWidgetTitle,
      componentSpec: normalizedComponentSpec,
    }
  }

  private clipDocumentForInsight(content: string, maxChars: number): string {
    const normalized = String(content || '').trim()
    if (normalized.length <= maxChars) return normalized
    const segmentSize = Math.max(800, Math.floor((maxChars - 64) / 3))
    const head = normalized.slice(0, segmentSize)
    const middleStart = Math.max(0, Math.floor((normalized.length - segmentSize) / 2))
    const middle = normalized.slice(middleStart, middleStart + segmentSize)
    const tail = normalized.slice(-segmentSize)
    return [
      head,
      '...[文档中间内容已截断]...',
      middle,
      '...[文档尾部内容已截断]...',
      tail,
    ].join('\n')
  }

  private async buildDocumentPipelineInsight(params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    sourceText: string
    sourceKind: 'attachment_body' | 'document_excerpt' | 'snapshot' | 'task_plan'
    sourceDocumentTitle: string
    sourceDocumentPath: string | null
    timeoutMs: number
    providerContext: TurnProviderContext
    signal: AbortSignal
  }): Promise<DocumentInsightStageResult> {
    const focusedContext = buildFocusedDocumentContext({
      question: params.question,
      content: params.sourceText,
      maxCharsPerChunk: 2200,
      maxSelectedChunks: params.sourceText.length > 4000 ? 4 : 6,
      maxPromptChars: 12_000,
    })
    const promptBody = focusedContext.promptText || this.clipDocumentForInsight(params.snapshot.content, 12_000)
    const systemPrompt = [
      '你是 Ready 的文档 insight 阶段。',
      '你只负责阅读文档并提炼和问题最相关的结构化结果，不要生成 widget，不要写回文档。',
      '必须只输出 JSON，对象字段为 summary、keyPoints、evidence、recommendedWidget、warnings。',
      'recommendedWidget 只能是 info_card、stats_card、comparison_grid、callout_block、data_table 之一。',
      'keyPoints 保持 3 到 6 条，evidence 至少给 1 条简短引文。',
    ].join('\n')
    const userPrompt = [
      `问题：${params.question}`,
      `来源标题：${params.sourceDocumentTitle}`,
      `来源路径：${params.sourceDocumentPath || '(未保存草稿)'}`,
      `写入目标：${params.snapshot.title}`,
      `来源类型：${params.sourceKind}`,
      `来源字数：${params.sourceText.length}`,
      `文档片段数：${focusedContext.chunks.length}`,
      `本次使用片段数：${focusedContext.selectedChunks.length}`,
      '',
      '请围绕这个问题提炼可直接用于制作信息卡的 insight。',
      '只返回 JSON。',
      '',
      focusedContext.warnings.length > 0
        ? `系统提示：${focusedContext.warnings.join(' ')}`
        : '系统提示：当前已挑选与问题最相关的文档片段。',
      '',
      '相关文档片段：',
      promptBody,
    ].join('\n')
    this.deps.log(
      `document insight focused read chunks=${focusedContext.chunks.length}, selected=${focusedContext.selectedChunks.length}, sectioned=${focusedContext.usedSectionAnchors}`,
    )
    const raw = await this.requestDocumentPipelineSimpleText({
      systemPrompt,
      userPrompt,
      providerContext: params.providerContext,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    })
    const parsed = this.parsePipelineJson<Record<string, unknown>>(raw)
    if (!parsed) {
      throw new Error('Document insight 阶段未返回可解析 JSON')
    }
    const insight = this.normalizePipelineInsight(parsed, params.question, {
      title: params.sourceDocumentTitle,
      path: params.sourceDocumentPath,
    })
    const warningSet = new Set([
      ...(insight.warnings || []),
      ...focusedContext.warnings,
    ])
    if (warningSet.size > 0) {
      insight.warnings = Array.from(warningSet)
    }
    return {
      insight,
      metrics: {
        chunkCount: focusedContext.chunks.length,
        selectedChunkCount: focusedContext.selectedChunks.length,
        promptChars: promptBody.length,
        usedSectionAnchors: focusedContext.usedSectionAnchors,
      },
    }
  }

  private async buildDocumentPipelineWidgetDraft(params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    insight: DocumentInsight
    plan: DocumentReadPlan
    timeoutMs: number
    providerContext: TurnProviderContext
    signal: AbortSignal
  }): Promise<DocumentWidgetDraft> {
    const systemPrompt = [
      '你是 Ready 的 widget 草稿阶段。',
      '你只负责根据给定 insight 生成一个可写入文档的 componentSpec 草稿。',
      '必须只输出 JSON。',
      '字段为 title、insertionMode、componentSpec、targetSectionTitle、targetWidgetTitle。',
      params.plan.operation === 'update'
        ? '这次是更新现有信息卡，不允许 append_end；必须使用 update_existing，并尽量提供 targetWidgetTitle。'
        : '默认 insertionMode 使用 append_end。',
      'componentSpec.component 只能是 info_card、stats_card、comparison_grid、callout_block、data_table。',
      '优先选择简单稳定的组件，不要发明 catalog 外的新组件。',
    ].join('\n')
    const userPrompt = [
      `用户问题：${params.question}`,
      `文档标题：${params.snapshot.title}`,
      `任务类型：${params.plan.taskType}`,
      `推荐组件：${params.insight.recommendedWidget}`,
      '',
      'insight JSON：',
      JSON.stringify(params.insight, null, 2),
    ].join('\n')
    const raw = await this.requestDocumentPipelineSimpleText({
      systemPrompt,
      userPrompt,
      providerContext: params.providerContext,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    })
    const parsed = this.parsePipelineJson<Record<string, unknown>>(raw)
    return this.normalizePipelineWidgetDraft(parsed, {
      insight: params.insight,
      snapshot: params.snapshot,
      plan: params.plan,
    })
  }

  private doesListWidgetsSummaryContainTarget(summary: string, target: string): boolean {
    const trimmed = String(target || '').trim()
    if (!trimmed) return false
    if (/^\d+$/.test(trimmed)) {
      return new RegExp(`(^|\\n)\\s*${trimmed}\\.`).test(summary)
    }
    return summary.includes(trimmed)
  }

  private async writeDocumentWidget(params: {
    draft: DocumentWidgetDraft
    snapshot: ActiveDocumentSnapshot
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
  }): Promise<string> {
    void params.signal

    if (params.draft.insertionMode === 'update_existing') {
      const target = String(params.draft.targetWidgetTitle || '').trim()
      if (!target) {
        throw new Error('未提供要更新的信息卡目标')
      }

      const listPayload = await params.requestModuleToolAction('document.listWidgets', {})
      const widgetSummary = typeof listPayload.summary === 'string' ? listPayload.summary : ''
      if (!this.doesListWidgetsSummaryContainTarget(widgetSummary, target)) {
        throw new Error(`未找到可更新的信息卡：${target}`)
      }

      const payload = await params.requestModuleToolAction('document.updateWidget', {
        target,
        title: params.draft.title,
        componentSpec: params.draft.componentSpec,
        widgetCode: params.draft.widgetCode,
      })
      return typeof payload.summary === 'string' ? payload.summary : `已更新信息卡：${target}`
    }

    const payload = await params.requestModuleToolAction('document.insertWidget', {
      title: params.draft.title,
      componentSpec: params.draft.componentSpec,
      widgetCode: params.draft.widgetCode,
      position: params.draft.insertionMode === 'after_section' ? 'after_section' : 'append_end',
      sectionTitle: params.draft.targetSectionTitle,
    })
    return typeof payload.summary === 'string' ? payload.summary : '已写入信息卡'
  }

  private async verifyDocumentTaskPlanWrite(params: {
    draft: DocumentWidgetDraft
    targetResource: RequestEnvelopeResource
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
  }): Promise<string> {
    void params.signal
    const payload = await params.requestModuleToolAction('document.listWidgets', {})
    const summary = typeof payload.summary === 'string' ? payload.summary : ''
    const verifyTarget = params.draft.insertionMode === 'update_existing'
      ? params.draft.targetWidgetTitle || params.draft.title
      : params.draft.title
    if (verifyTarget && summary && !summary.includes(verifyTarget) && !/当前文档共有\s+\d+\s+个 widget/.test(summary)) {
      throw new Error(`写入后未在 ${params.targetResource.name} 中确认到目标信息卡`)
    }
    return summary || `已核对 ${params.targetResource.name}`
  }

  private buildDocumentTaskPlanFailureText(params: {
    job: DocumentTaskJob
    step: DocumentTaskStep
    error: string
    insight?: DocumentInsight
    draft?: DocumentWidgetDraft
  }): string {
    const target = this.getDocumentTaskJobTarget(params.job)
    const sources = this.getDocumentTaskJobSources(params.job)
    const sourceLabel = sources.map((resource) => resource.name).join(' + ') || '材料'
    const targetLabel = target?.name || '目标文档'

    if (params.step === 'collect_materials' || params.step === 'build_insight') {
      return `读取 ${sourceLabel} 失败，暂时没法继续写入 ${targetLabel}。原因：${params.error}`
    }

    const lines = [
      `已先完成对 ${sourceLabel} 的重点提炼，但在写入 ${targetLabel} 时中断。`,
      params.insight?.summary ? `提炼结果：${params.insight.summary}` : null,
      params.insight?.keyPoints?.length
        ? `重点：${params.insight.keyPoints.slice(0, 3).join('；')}`
        : null,
      params.draft?.title ? `卡片草稿：${params.draft.title}` : null,
      `失败原因：${params.error}`,
    ].filter(Boolean)

    return lines.join('\n')
  }

  private buildDocumentTaskPlanSuccessText(results: Array<{
    job: DocumentTaskJob
    writeSummary: string
    saveSummary: string
    verifySummary: string
  }>): string {
    if (results.length === 1) {
      const item = results[0]
      const target = this.getDocumentTaskJobTarget(item.job)
      const sources = this.getDocumentTaskJobSources(item.job)
      return [
        `已根据 ${sources.map((resource) => resource.name).join(' + ')} 在 ${target?.name || '目标文档'} 中生成信息卡。`,
        item.writeSummary,
        item.saveSummary,
      ].join('\n')
    }

    return [
      `本次共完成 ${results.length} 个文档任务：`,
      ...results.map((item, index) => {
        const target = this.getDocumentTaskJobTarget(item.job)
        const sources = this.getDocumentTaskJobSources(item.job)
        return `${index + 1}. ${sources.map((resource) => resource.name).join(' + ')} -> ${target?.name || '目标文档'}`
      }),
    ].join('\n')
  }

  private async executeDocumentTaskPlanJob(params: {
    job: DocumentTaskJob
    jobIndex: number
    totalJobs: number
    requestEnvelope: RequestEnvelope
    session: DocumentPipelineCacheSession
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    providerContext: TurnProviderContext
    onStepUpdate?: (payload: {
      job: DocumentTaskJob
      jobIndex: number
      step: DocumentTaskStep
      status: 'running' | 'completed' | 'failed'
      summary: string
      error?: string
    }) => void
  }): Promise<
    | {
      success: true
      writeSummary: string
      saveSummary: string
      verifySummary: string
    }
    | {
      success: false
      step: DocumentTaskStep
      error: string
      insight?: DocumentInsight
      draft?: DocumentWidgetDraft
    }
  > {
    const emitStepUpdate = params.onStepUpdate || (() => {})
    const targetResource = this.getDocumentTaskJobTarget(params.job)
    const sourceResources = this.getDocumentTaskJobSources(params.job)
    const sourceLabel = sourceResources.map((resource) => resource.name).join(' + ') || '材料'
    const targetLabel = targetResource?.name || '目标文档'

    let currentStep: DocumentTaskStep = 'collect_materials'
    let currentInsight: DocumentInsight | undefined
    let currentDraft: DocumentWidgetDraft | undefined

    try {
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'collect_materials',
        status: 'running',
        summary: `正在读取 ${sourceLabel}，准备写入 ${targetLabel}`,
      })
      if (!targetResource) {
        throw new Error('缺少明确的目标文档')
      }
      const targetSnapshot = await this.loadDocumentPipelineSnapshot({
        userText: params.job.instruction,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
        targetPathOverride: targetResource.path,
      })
      const sourceMaterial = buildDocumentInsightSourceMaterial({
        requestEnvelope: params.requestEnvelope,
        snapshotContent: targetSnapshot.content,
        job: params.job,
      })
      if (!sourceMaterial.text.trim()) {
        throw new Error('没有拿到可用的来源材料')
      }
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'collect_materials',
        status: 'completed',
        summary: `已读取 ${sourceLabel}，目标是 ${targetLabel}`,
      })

      currentStep = 'build_insight'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'build_insight',
        status: 'running',
        summary: `正在提炼 ${sourceLabel} 的重点`,
      })
      const insightCacheKey = buildDocumentTaskStepCacheKey({
        question: params.job.instruction,
        step: 'build_insight',
        job: params.job,
        targetSnapshot,
      })
      const cachedInsight = this.getCachedDocumentInsight(
        params.session,
        params.job.instruction,
        targetSnapshot,
        {
          job: params.job,
          cacheKeyOverride: insightCacheKey,
        },
      )
      const insightResult = cachedInsight || await this.buildDocumentPipelineInsight({
        question: params.job.instruction,
        snapshot: targetSnapshot,
        sourceText: sourceMaterial.text,
        sourceKind: sourceMaterial.kind,
        sourceDocumentTitle: sourceMaterial.sourceDocumentTitle || sourceResources[0]?.name || targetSnapshot.title,
        sourceDocumentPath: sourceMaterial.sourceDocumentPath ?? sourceResources[0]?.path ?? null,
        timeoutMs: 60_000,
        providerContext: params.providerContext,
        signal: params.signal,
      })
      currentInsight = ('insight' in insightResult ? insightResult.insight : insightResult)
      if (!cachedInsight) {
        this.storeCachedDocumentInsight(
          params.session,
          params.job.instruction,
          targetSnapshot,
          currentInsight,
          'metrics' in insightResult ? insightResult.metrics : undefined,
          {
            job: params.job,
            cacheKeyOverride: insightCacheKey,
          },
        )
      }
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'build_insight',
        status: 'completed',
        summary: cachedInsight
          ? `已复用 ${sourceLabel} 的提炼结果`
          : `已完成 ${sourceLabel} 的重点提炼`,
      })

      currentStep = 'compose_widget'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'compose_widget',
        status: 'running',
        summary: `正在为 ${targetLabel} 生成卡片草稿`,
      })
      const cachedDraft = this.getCachedDocumentWidgetDraft(
        params.session,
        params.job.instruction,
        params.job,
        targetSnapshot,
      )
      const planTaskType = classifyStructuredDocumentIntent(params.job.instruction) || 'document_read_then_widget_create'
      currentDraft = cachedDraft || await this.buildDocumentPipelineWidgetDraft({
        question: params.job.instruction,
        snapshot: targetSnapshot,
        insight: currentInsight,
        plan: {
          taskType: planTaskType,
          operation: planTaskType === 'document_read_then_widget_update' ? 'update' : 'create',
          question: params.job.instruction,
          documentPath: targetSnapshot.path,
          deepRead: false,
          preferredWidget: currentInsight.recommendedWidget,
          maxChars: 16_000,
        },
        timeoutMs: 60_000,
        providerContext: params.providerContext,
        signal: params.signal,
      })
      if (!cachedDraft) {
        this.storeCachedDocumentWidgetDraft(
          params.session,
          params.job.instruction,
          params.job,
          targetSnapshot,
          currentDraft,
        )
      }
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'compose_widget',
        status: 'completed',
        summary: cachedDraft
          ? `已复用 ${targetLabel} 的卡片草稿`
          : `已生成写入 ${targetLabel} 的卡片草稿`,
      })

      currentStep = 'write_target'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'write_target',
        status: 'running',
        summary: currentDraft.insertionMode === 'update_existing'
          ? `正在定位并更新 ${targetLabel} 中的现有信息卡`
          : `正在把卡片写入 ${targetLabel}`,
      })
      const writeSummary = await this.writeDocumentWidget({
        draft: currentDraft,
        snapshot: targetSnapshot,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
      })
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'write_target',
        status: 'completed',
        summary: writeSummary,
      })

      currentStep = 'save_target'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'save_target',
        status: 'running',
        summary: `正在保存 ${targetLabel}`,
      })
      const savePayload = await params.requestModuleToolAction('document.saveTab', {})
      const saveSummary = typeof savePayload.summary === 'string' ? savePayload.summary : `已保存 ${targetLabel}`
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'save_target',
        status: 'completed',
        summary: saveSummary,
      })

      currentStep = 'verify_result'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'verify_result',
        status: 'running',
        summary: `正在核对 ${targetLabel}`,
      })
      const verifySummary = await this.verifyDocumentTaskPlanWrite({
        draft: currentDraft,
        targetResource,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
      })
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'verify_result',
        status: 'completed',
        summary: verifySummary,
      })

      return {
        success: true,
        writeSummary,
        saveSummary,
        verifySummary,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: currentStep,
        status: 'failed',
        summary: message,
        error: message,
      })
      return {
        success: false,
        step: currentStep,
        error: message,
        insight: currentInsight,
        draft: currentDraft,
      }
    }
  }

  private async runDocumentTaskPlan(params: {
    plan: DocumentTaskPlan
    requestEnvelope: RequestEnvelope
    session: DocumentPipelineCacheSession
    scopeId?: string
    parentTaskId?: string
    parentRunId?: string | null
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    providerContext: TurnProviderContext
    emitStructuredTaskPayload: (payload: unknown) => void
  }): Promise<{ success: boolean; finalText?: string; error?: string }> {
    if (params.plan.blockedReason) {
      params.emitStructuredTaskPayload({
        module: 'document',
        taskTitle: '文档信息卡',
        taskSummary: params.plan.blockedReason,
        steps: [{
          id: 'clarify_resource_mapping',
          title: '确认材料与目标映射',
          status: 'blocked',
          updatedAt: new Date().toISOString(),
        }],
        currentStepId: 'clarify_resource_mapping',
        waitingFor: 'confirmation',
        resumableActions: ['continue', 'cancel'],
        blockedReason: params.plan.blockedReason,
      })
      return {
        success: false,
        finalText: params.plan.blockedReason,
        error: params.plan.blockedReason,
      }
    }

    if (params.plan.jobs.length === 0) {
      return {
        success: false,
        error: '当前没有可执行的文档任务计划',
      }
    }

    const scope = params.scopeId ? this.deps.getConversationScope?.(params.scopeId) || null : null
    if (scope && params.parentTaskId && params.plan.jobs.length > 1 && this.deps.createSubtaskRuntime) {
      let latestFailureText: string | null = null
      const subtaskRuntime = this.deps.createSubtaskRuntime()

      const multiJobResult = await runDocumentTaskPlanWithSubtasks({
        plan: params.plan,
        scope,
        parentTaskId: params.parentTaskId,
        parentRunId: params.parentRunId || null,
        subtaskRuntime,
        publishParentScopeRunEvent: (payload) => {
          return this.deps.publishScopeRunEvent?.(payload)
        },
        emitStructuredTaskPayload: (payload) => params.emitStructuredTaskPayload(payload),
        runJob: async ({ job, jobIndex, totalJobs, emitChildUpdate }) => {
          const childStepStates = new Map<DocumentTaskStep, 'pending' | 'running' | 'done' | 'blocked'>()
          const buildChildSteps = () => job.steps.map((step) => ({
            id: step,
            title: this.buildDocumentTaskStepTitle(job, step, jobIndex, totalJobs),
            status: childStepStates.get(step) || 'pending',
            updatedAt: new Date().toISOString(),
          }))
          const jobResult = await this.executeDocumentTaskPlanJob({
            job,
            jobIndex,
            totalJobs,
            requestEnvelope: params.requestEnvelope,
            session: params.session,
            requestModuleToolAction: params.requestModuleToolAction,
            signal: params.signal,
            providerContext: params.providerContext,
            onStepUpdate: ({ step, status, summary, error }) => {
              childStepStates.set(
                step,
                status === 'running'
                  ? 'running'
                  : status === 'completed'
                    ? 'done'
                    : 'blocked',
              )
              emitChildUpdate({
                phase: 'tool_running',
                taskSummary: summary,
                steps: buildChildSteps(),
                currentStepId: step,
                waitingFor: status === 'failed' ? 'confirmation' : 'none',
                resumableActions: status === 'failed' ? ['retry', 'cancel'] : ['cancel'],
                blockedReason: status === 'failed' ? (error || summary) : null,
              })
            },
          })
          if (!jobResult.success) {
            latestFailureText = this.buildDocumentTaskPlanFailureText({
              job,
              step: jobResult.step,
              error: jobResult.error,
              insight: jobResult.insight,
              draft: jobResult.draft,
            })
            throw new Error(jobResult.error)
          }
          return {
            finalText: jobResult.verifySummary,
            taskSummary: jobResult.verifySummary,
            steps: buildChildSteps(),
            currentStepId: 'verify_result',
            resumableActions: ['none'],
            waitingFor: 'none',
            writeSummary: jobResult.writeSummary,
            saveSummary: jobResult.saveSummary,
            verifySummary: jobResult.verifySummary,
          }
        },
      })

      if (!multiJobResult.success) {
        return {
          success: false,
          finalText: latestFailureText || multiJobResult.error,
          error: multiJobResult.error,
        }
      }

      return {
        success: true,
        finalText: this.buildDocumentTaskPlanSuccessText(multiJobResult.results || []),
      }
    }

    const stepStates = new Map<string, 'pending' | 'running' | 'done' | 'blocked'>()
    const allSteps = params.plan.jobs.flatMap((job, jobIndex) => job.steps.map((step) => ({
      id: this.buildDocumentTaskStepId(job, step),
      title: this.buildDocumentTaskStepTitle(job, step, jobIndex, params.plan.jobs.length),
    })))

    const emitPlanStep = (payload: {
      job: DocumentTaskJob
      jobIndex: number
      step: DocumentTaskStep
      status: 'running' | 'completed' | 'failed'
      summary: string
      error?: string
    }): void => {
      const stepId = this.buildDocumentTaskStepId(payload.job, payload.step)
      stepStates.set(
        stepId,
        payload.status === 'running'
          ? 'running'
          : payload.status === 'completed'
            ? 'done'
            : 'blocked',
      )

      params.emitStructuredTaskPayload({
        module: 'document',
        taskTitle: '文档信息卡',
        taskSummary: payload.summary,
        message: payload.summary,
        steps: allSteps.map((step) => ({
          id: step.id,
          title: step.title,
          status: stepStates.get(step.id) || 'pending',
          updatedAt: new Date().toISOString(),
        })),
        currentStepId: stepId,
        waitingFor: payload.status === 'failed' ? 'confirmation' : 'none',
        resumableActions: payload.status === 'failed' ? ['retry', 'cancel'] : ['cancel'],
        blockedReason: payload.status === 'failed' ? (payload.error || payload.summary) : null,
      })
    }

    const results: Array<{
      job: DocumentTaskJob
      writeSummary: string
      saveSummary: string
      verifySummary: string
    }> = []

    for (const [jobIndex, job] of params.plan.jobs.entries()) {
      const jobResult = await this.executeDocumentTaskPlanJob({
        job,
        jobIndex,
        totalJobs: params.plan.jobs.length,
        requestEnvelope: params.requestEnvelope,
        session: params.session,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
        providerContext: params.providerContext,
        onStepUpdate: emitPlanStep,
      })
      if (!jobResult.success) {
        return {
          success: false,
          finalText: this.buildDocumentTaskPlanFailureText({
            job,
            step: jobResult.step,
            error: jobResult.error,
            insight: jobResult.insight,
            draft: jobResult.draft,
          }),
          error: jobResult.error,
        }
      }
      results.push({
        job,
        writeSummary: jobResult.writeSummary,
        saveSummary: jobResult.saveSummary,
        verifySummary: jobResult.verifySummary,
      })
    }

    return {
      success: true,
      finalText: this.buildDocumentTaskPlanSuccessText(results),
    }
  }

  private normalizeActiveDocumentSnapshot(raw: unknown): ActiveDocumentSnapshot | null {
    if (!raw || typeof raw !== 'object') return null
    const title = typeof (raw as { title?: unknown }).title === 'string' ? String((raw as { title: string }).title).trim() : ''
    const content = typeof (raw as { content?: unknown }).content === 'string' ? String((raw as { content: string }).content) : ''
    if (!title || !content) return null
    return {
      title,
      path: typeof (raw as { path?: unknown }).path === 'string' && (raw as { path: string }).path.trim()
        ? String((raw as { path: string }).path).trim()
        : null,
      content,
      isDirty: Boolean((raw as { isDirty?: unknown }).isDirty),
      charCount: typeof (raw as { charCount?: unknown }).charCount === 'number'
        ? Number((raw as { charCount: number }).charCount)
        : content.length,
    }
  }

  private buildDocumentInsightCacheKey(
    question: string,
    snapshot: ActiveDocumentSnapshot,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): string {
    if (options?.cacheKeyOverride) return options.cacheKeyOverride
    if (options?.job) {
      return buildDocumentTaskStepCacheKey({
        question,
        step: 'build_insight',
        job: options.job,
        targetSnapshot: snapshot,
      })
    }
    const normalizedQuestion = String(question || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const documentIdentity = snapshot.path || snapshot.title || 'active-document'
    const contentHash = createHash('sha1')
      .update(snapshot.content)
      .digest('hex')
      .slice(0, 12)
    return `${documentIdentity}::${contentHash}::${normalizedQuestion}`
  }

  private getCachedDocumentInsight(
    session: DocumentPipelineCacheSession,
    question: string,
    snapshot: ActiveDocumentSnapshot,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): DocumentInsightStageResult | null {
    const key = this.buildDocumentInsightCacheKey(question, snapshot, options)
    const hit = session.documentInsightCache.find((entry) => entry.key === key)
    if (hit) {
      this.deps.log(`document insight session cache hit key=${key}`)
      return {
        insight: hit.insight,
        metrics: {
          ...(hit.metrics || {}),
          cacheHit: true,
        },
      }
    }

    const sharedHit = this.documentInsightCache.get(key)
    if (!sharedHit) return null
    this.deps.log(`document insight shared cache hit key=${key}`)
    return {
      insight: sharedHit.insight,
      metrics: {
        ...(sharedHit.metrics || {}),
        cacheHit: true,
      },
    }
  }

  private storeCachedDocumentInsight(
    session: DocumentPipelineCacheSession,
    question: string,
    snapshot: ActiveDocumentSnapshot,
    insight: DocumentInsight,
    metrics?: DocumentInsightMetrics,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): void {
    const key = this.buildDocumentInsightCacheKey(question, snapshot, options)
    const nextEntry = {
      key,
      insight,
      metrics,
      createdAt: new Date().toISOString(),
    }
    session.documentInsightCache = [
      nextEntry,
      ...session.documentInsightCache.filter((entry) => entry.key !== key),
    ].slice(0, 6)
    this.documentInsightCache.set(key, { insight, metrics })
    this.deps.log(`document insight cache store key=${key}`)
  }

  private getCachedDocumentWidgetDraft(
    session: DocumentPipelineCacheSession,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
  ): DocumentWidgetDraft | null {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const sessionHit = session.documentWidgetDraftCache.find((entry) => entry.key === key)
    if (sessionHit) {
      this.deps.log(`document widget draft session cache hit key=${key}`)
      return sessionHit.draft
    }

    const sharedHit = this.documentWidgetDraftCache.get(key)
    if (!sharedHit) return null
    this.deps.log(`document widget draft shared cache hit key=${key}`)
    return sharedHit
  }

  private storeCachedDocumentWidgetDraft(
    session: DocumentPipelineCacheSession,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
    draft: DocumentWidgetDraft,
  ): void {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const nextEntry = {
      key,
      draft,
      createdAt: new Date().toISOString(),
    }
    session.documentWidgetDraftCache = [
      nextEntry,
      ...session.documentWidgetDraftCache.filter((entry) => entry.key !== key),
    ].slice(0, 6)
    this.documentWidgetDraftCache.set(key, draft)
    this.deps.log(`document widget draft cache store key=${key}`)
  }

  private normalizeDocumentTargetPath(path: string): string {
    const trimmed = path.trim()
    const autosaveMatch = trimmed.match(/^(.*\.docx)\.autosave-\d{8}-\d{6}\.bak\.docx$/i)
    if (autosaveMatch?.[1] && existsSync(autosaveMatch[1])) {
      return autosaveMatch[1]
    }
    return trimmed
  }

  private extractDocumentPathFromUserText(raw: string): string | null {
    if (!raw) return null
    const contextPathLine = raw.match(/###\s*当前文档上下文[\s\S]*?(?:^|\n)-\s*路径:\s*([^\n]+)/m)
    const fromContext = contextPathLine?.[1]?.trim()
    if (fromContext && !/未保存草稿/.test(fromContext)) {
      return this.normalizeDocumentTargetPath(fromContext)
    }

    const attachmentPath = raw.match(/---\s*附件:[\s\S]*?(?:^|\n)-\s*路径:\s*(\/[^\n]+)/m)
    if (attachmentPath?.[1]) {
      return this.normalizeDocumentTargetPath(attachmentPath[1])
    }

    return null
  }

  private async loadDocumentPipelineSnapshot(params: {
    userText: string
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    targetPathOverride?: string | null
  }): Promise<ActiveDocumentSnapshot> {
    const targetPath = params.targetPathOverride?.trim() || this.extractDocumentPathFromUserText(params.userText)
    const requestSnapshot = async (): Promise<ActiveDocumentSnapshot | null> => {
      if (!params.requestModuleToolAction) return null
      const payload = await params.requestModuleToolAction('document.inspectActive', {})
      return this.normalizeActiveDocumentSnapshot((payload as { snapshot?: unknown }).snapshot)
    }

    if (params.requestModuleToolAction && targetPath) {
      const activeSnapshot = await requestSnapshot()
      if (!activeSnapshot || activeSnapshot.path !== targetPath) {
        await params.requestModuleToolAction('document.openTab', { path: targetPath })
      }
    }

    const activeSnapshot = await requestSnapshot()
    if (activeSnapshot) {
      if (!targetPath || activeSnapshot.path === targetPath || activeSnapshot.path === null) {
        return activeSnapshot
      }
    }

    if (targetPath) {
      const readResult = await readDocumentEditableText(targetPath)
      if (readResult.success) {
        return {
          title: targetPath.split('/').pop() || targetPath,
          path: targetPath,
          content: readResult.content,
          isDirty: false,
          charCount: readResult.content.length,
        }
      }
      throw new Error(`文档读取失败：${readResult.error || targetPath}`)
    }

    throw new Error('当前没有可读取的活动文档')
  }

  private async runDocumentWidgetPipeline(params: {
    structuredIntent: DocumentStructuredTaskType
    executionIntentContext: ExecutionIntentContext
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    session: DocumentPipelineCacheSession
    providerContext: TurnProviderContext
    emitStructuredTaskPayload: (payload: unknown) => void
  }): Promise<{ success: boolean; finalText?: string; error?: string }> {
    const sourceMaterial = buildDocumentInsightSourceMaterial({
      requestEnvelope: params.executionIntentContext.requestEnvelope,
      snapshotContent: '',
    })
    const pipelinePhaseOrder: Array<DocumentTaskPipelinePhaseUpdate['phase']> = [
      'loading_document',
      'building_insight',
      'generating_widget_spec',
      'writing_widget',
      'saving_document',
    ]
    const pipelinePhaseTitles: Record<DocumentTaskPipelinePhaseUpdate['phase'], string> = {
      loading_document: '读取文档',
      building_insight: '提炼重点',
      generating_widget_spec: '生成卡片草稿',
      writing_widget: params.structuredIntent === 'document_read_then_widget_update' ? '更新现有卡片' : '写入卡片',
      saving_document: '保存文档',
      completed: '完成',
      failed: '失败',
    }
    const pipelinePhaseStatus = new Map<string, 'running' | 'done' | 'error'>()
    let documentPipelineDiagnostics: {
      phase?: string
      chunkCount?: number
      selectedChunkCount?: number
      promptChars?: number
      cacheHit?: boolean
      usedSectionAnchors?: boolean
    } | null = null
    const emitDocumentPipelinePhase = (update: DocumentTaskPipelinePhaseUpdate): void => {
      if (update.phase === 'completed') {
        pipelinePhaseStatus.forEach((value, key) => {
          if (value === 'running') pipelinePhaseStatus.set(key, 'done')
        })
      } else if (update.phase === 'failed') {
        const lastRunning = pipelinePhaseOrder.find((phase) => pipelinePhaseStatus.get(phase) === 'running')
        if (lastRunning) pipelinePhaseStatus.set(lastRunning, 'error')
      } else if (update.status === 'running') {
        pipelinePhaseStatus.set(update.phase, 'running')
      } else if (update.status === 'completed') {
        pipelinePhaseStatus.set(update.phase, 'done')
      } else if (update.status === 'failed') {
        pipelinePhaseStatus.set(update.phase, 'error')
      }
      documentPipelineDiagnostics = {
        ...(documentPipelineDiagnostics || {}),
        ...(update.metrics || {}),
        phase: update.phase === 'completed' || update.phase === 'failed'
          ? documentPipelineDiagnostics?.phase || update.phase
          : update.phase,
      }

      params.emitStructuredTaskPayload({
        module: 'document',
        message: update.summary,
        taskTitle: '文档信息卡',
        taskSummary: update.summary,
        executionDiagnostics: {
          pipeline: {
            document: documentPipelineDiagnostics,
          },
        },
        steps: pipelinePhaseOrder.map((phase) => ({
          id: phase,
          title: pipelinePhaseTitles[phase],
          status: pipelinePhaseStatus.get(phase) === 'done'
            ? 'done'
            : pipelinePhaseStatus.get(phase) === 'error'
              ? 'blocked'
              : pipelinePhaseStatus.get(phase) === 'running'
                ? 'running'
                : 'pending',
          updatedAt: update.endedAt || update.startedAt,
        })),
        currentStepId:
          update.phase === 'completed' || update.phase === 'failed'
            ? pipelinePhaseOrder.find((phase) => pipelinePhaseStatus.get(phase) === 'running' || pipelinePhaseStatus.get(phase) === 'error') || pipelinePhaseOrder[pipelinePhaseOrder.length - 1]
            : update.phase,
        waitingFor: 'none',
        resumableActions: update.phase === 'failed' ? ['retry', 'cancel'] : ['cancel'],
        blockedReason: update.phase === 'failed' ? (update.error || update.summary) : null,
      })
    }

    const pipeline = new DocumentTaskPipeline({
      now: () => new Date(),
      log: (message) => this.deps.log(message),
      loadDocumentSnapshot: async ({ question, signal }) => await this.loadDocumentPipelineSnapshot({
        userText: question,
        requestModuleToolAction: params.requestModuleToolAction,
        signal,
      }),
      getCachedInsight: ({ question, snapshot }) => this.getCachedDocumentInsight(
        params.session,
        question,
        snapshot,
      ),
      buildInsight: async ({ question, snapshot }) => await this.buildDocumentPipelineInsight({
        question,
        snapshot,
        sourceText: sourceMaterial.kind === 'snapshot' ? snapshot.content : sourceMaterial.text,
        sourceKind: sourceMaterial.kind === 'snapshot' && sourceMaterial.text.trim()
          ? 'snapshot'
          : sourceMaterial.kind,
        sourceDocumentTitle: sourceMaterial.sourceDocumentTitle || snapshot.title,
        sourceDocumentPath: sourceMaterial.sourceDocumentPath ?? snapshot.path,
        timeoutMs: 60_000,
        providerContext: params.providerContext,
        signal: params.signal,
      }),
      storeCachedInsight: ({ question, snapshot, insight, metrics }) => {
        this.storeCachedDocumentInsight(params.session, question, snapshot, insight, metrics)
      },
      buildWidgetDraft: async ({ question, snapshot, insight, plan, signal }) => await this.buildDocumentPipelineWidgetDraft({
        question,
        snapshot,
        insight,
        plan,
        timeoutMs: 60_000,
        providerContext: params.providerContext,
        signal,
      }),
      writeWidget: async ({ draft, snapshot, signal }) => await this.writeDocumentWidget({
        draft,
        snapshot,
        requestModuleToolAction: params.requestModuleToolAction,
        signal,
      }),
      saveDocument: async ({ signal }) => {
        void signal
        const payload = await params.requestModuleToolAction('document.saveTab', {})
        return typeof payload.summary === 'string' ? payload.summary : '已保存文档'
      },
      emitPhase: emitDocumentPipelinePhase,
    })

    const pipelineResult = await pipeline.run({
      question: params.executionIntentContext.userInstructionText,
      signal: params.signal,
      taskType: params.structuredIntent,
    })

    return {
      success: pipelineResult.success,
      finalText: pipelineResult.finalText,
      error: pipelineResult.error,
    }
  }
}
