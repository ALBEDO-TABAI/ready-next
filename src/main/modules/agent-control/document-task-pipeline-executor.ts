import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { getProviderDef, type AIModelConfig } from '../../../shared/ai-providers'
import {
  buildDocumentChunks,
  buildFocusedDocumentContext,
  selectWidgetCenteredChunks,
  type DocumentChunk,
} from '../../../shared/document-sectioning'
import {
  describeApprovedWidgetProps,
  validateDocumentWidgetComponentSpec,
  WIDGET_COMPONENT_IDS,
  type DocumentWidgetComponentName,
  type DocumentWidgetComponentSpec,
} from '../../../shared/document-widget-openui'
import {
  collectDocumentWidgets,
  summarizeWidgetRecord,
  type DocumentWidgetRecord,
} from '../../../shared/document-widget-parse'
import { resolveControlledWidgetTarget } from '../../../shared/document-widget-target'
import { readDocumentEditableText } from '../document-engine/ipc-handler'
import { documentCommitRegistry } from '../document-engine/document-commit-registry'
import { type DomainAdapterDispatchResult } from './domain-adapters/domain-adapter'
import { classifyStructuredDocumentIntent } from './document-task-types'
import { buildDocumentTaskStepCacheKey, hashText } from './document-task-cache-key'
import {
  getDocumentToolTimeout,
  raceWithTimeout,
  throwIfAborted,
  wrapToolCall,
} from './document-task-tool-timing'
import { DocumentInsightCache } from './document-insight-cache'
import { buildDocumentInsightSourceMaterial } from './document-source-materials'
import { logAgentMetric } from './metrics'
import { runDocumentTaskPlanWithSubtasks } from './document-task-subtask-runner'
import {
  buildPipelinePhaseOrder,
  DocumentTaskPipeline,
  type ActiveDocumentSnapshot,
  type DocumentInsight,
  type DocumentInsightMetrics,
  type DocumentInsightStageResult,
  type DocumentReadPlan,
  type DocumentStructuredTaskType,
  type DocumentTaskPipelinePhaseUpdate,
  type DocumentWidgetDraft,
  type DocumentWidgetWriteStage,
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
  acquireWidgetEditLease?: (params: {
    agent: string
    sessionId?: string | null
    widgetId?: string | null
    tabId?: string | null
    documentPath?: string | null
    widgetTitle?: string | null
    origin: 'pipeline_write' | 'pipeline_locate' | 'envelope_widget_target'
    widgetFingerprint?: string | null
    widgetTextSample?: string | null
  }) => void
  resolveWidgetEditLease?: (params: {
    agent: string
    sessionId?: string | null
  }) => import('./widget-edit-lease').ActiveWidgetEditLease | null
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
  sessionId: string
  agentName?: string
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

const WIDGET_DRAFT_TTL_MS = 90_000

export class DocumentTaskPipelineExecutor {
  private readonly documentInsightCache = new DocumentInsightCache()
  private readonly sessionInsightCaches = new Map<string, Array<{
    key: string
    insight: DocumentInsight
    metrics?: DocumentInsightMetrics
    createdAt: string
  }>>()
  private readonly sessionWidgetDraftCaches = new Map<string, Array<{
    key: string
    draft: DocumentWidgetDraft
    createdAt: string
    expiresAt: number
  }>>()

  constructor(private readonly deps: DocumentTaskPipelineExecutorDeps) {}

  clearSessionCache(sessionId: string): void {
    this.sessionInsightCaches.delete(sessionId)
    this.sessionWidgetDraftCaches.delete(sessionId)
  }

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
        sessionId: params.sessionId,
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
      || params.executionIntentContext.structuredDocumentIntent === 'document_list_widgets'
      || params.executionIntentContext.structuredDocumentIntent === 'document_remove_widget'
    ) {
      const pipelineResult = await this.runDocumentWidgetPipeline({
        structuredIntent: params.executionIntentContext.structuredDocumentIntent,
        executionIntentContext: params.executionIntentContext,
        requestModuleToolAction: params.requestModuleToolAction!,
        signal: params.signal,
        sessionId: params.sessionId,
        agentName: params.agentName,
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
    options?: {
      includeSystemMessage?: boolean
      overrideMessages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    },
  ): DocumentPipelineSimpleSession {
    const messages = options?.overrideMessages
      ? options.overrideMessages.map((message) => ({ role: message.role, content: message.content }))
      : options?.includeSystemMessage
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
    }
  }

  private async requestDocumentPipelineSimpleText(params: {
    systemPrompt: string
    userPrompt: string
    providerContext: TurnProviderContext
    signal: AbortSignal
    timeoutMs: number
    messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  }): Promise<string> {
    const kimiOptions = params.messages
      ? { overrideMessages: params.messages }
      : { includeSystemMessage: true }
    const defaultOptions = params.messages
      ? { overrideMessages: params.messages }
      : undefined

    if (params.providerContext.isKimiCoding) {
      return this.deps.requestKimiCodingSimple({
        session: this.createPipelineSession(params.systemPrompt, params.userPrompt, kimiOptions),
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      })
    }

    if (params.providerContext.useAnthropicProtocol) {
      return this.deps.requestAnthropicSimple({
        session: this.createPipelineSession(params.systemPrompt, params.userPrompt, defaultOptions),
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      })
    }

    return this.deps.requestOpenAISimple({
      session: this.createPipelineSession(params.systemPrompt, params.userPrompt, defaultOptions),
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
      if ((WIDGET_COMPONENT_IDS as ReadonlyArray<string>).includes(value)) {
        return value as DocumentWidgetComponentName
      }
      return 'info_card' satisfies DocumentWidgetComponentName
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
    const rawPatch = raw.componentSpecPatch && typeof raw.componentSpecPatch === 'object' && !Array.isArray(raw.componentSpecPatch)
      ? raw.componentSpecPatch as Record<string, unknown>
      : null
    const normalizedPatch = rawPatch && params.plan.operation === 'update'
      ? {
          component: typeof rawPatch.component === 'string' && rawPatch.component.trim().length > 0
            ? rawPatch.component.trim()
            : undefined,
          props: rawPatch.props && typeof rawPatch.props === 'object' && !Array.isArray(rawPatch.props)
            ? rawPatch.props as Record<string, unknown>
            : undefined,
          dataSource: rawPatch.dataSource && typeof rawPatch.dataSource === 'object' && !Array.isArray(rawPatch.dataSource)
            ? rawPatch.dataSource as Record<string, unknown>
            : undefined,
        }
      : null
    const hasMeaningfulPatch = normalizedPatch
      && (normalizedPatch.component || normalizedPatch.props || normalizedPatch.dataSource)
    if (!componentSpec) {
      if (hasMeaningfulPatch) {
        return {
          title: this.slugifyWidgetTitle(title),
          insertionMode: 'update_existing',
          targetSectionTitle: typeof raw.targetSectionTitle === 'string' ? raw.targetSectionTitle.trim() : undefined,
          targetWidgetTitle: rawTargetWidgetTitle,
          componentSpecPatch: normalizedPatch!,
        }
      }
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
      componentSpecPatch: hasMeaningfulPatch ? normalizedPatch! : undefined,
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
    targetWidgetTitle?: string
    targetWidgetOccurrence?: number
  }): Promise<DocumentInsightStageResult> {
    const focusedContext = buildFocusedDocumentContext({
      question: params.question,
      content: params.sourceText,
      maxCharsPerChunk: 2200,
      maxSelectedChunks: params.sourceText.length > 4000 ? 4 : 6,
      maxPromptChars: 12_000,
    })
    let effectiveChunks: DocumentChunk[] = focusedContext.selectedChunks
    let windowedPromptText: string | null = null
    if (params.targetWidgetTitle) {
      const allChunks = buildDocumentChunks(params.sourceText, { maxCharsPerChunk: 2200 }).chunks
      const centered = selectWidgetCenteredChunks(
        params.sourceText,
        allChunks,
        params.targetWidgetTitle,
        params.targetWidgetOccurrence,
        { windowChunks: 2 },
      )
      if (centered && centered.length > 0) {
        effectiveChunks = centered
        const sections: string[] = []
        for (const [index, chunk] of centered.entries()) {
          const heading = chunk.sectionTitle
            ? `### 目标卡片窗口片段 ${index + 1}｜${chunk.sectionTitle}`
            : `### 目标卡片窗口片段 ${index + 1}`
          sections.push([heading, chunk.content].join('\n'))
        }
        windowedPromptText = sections.join('\n\n')
      }
    }
    const promptBody = windowedPromptText || focusedContext.promptText || this.clipDocumentForInsight(params.snapshot.content, 12_000)
    const systemPrompt = [
      '你是 Ready 的文档 insight 阶段。',
      '你只负责阅读文档并提炼和问题最相关的结构化结果，不要生成 widget，不要写回文档。',
      '必须只输出 JSON，对象字段为 summary、keyPoints、evidence、recommendedWidget、warnings。',
      `recommendedWidget 只能是以下组件之一：${WIDGET_COMPONENT_IDS.join('、')}。`,
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
      `本次使用片段数：${effectiveChunks.length}`,
      windowedPromptText && params.targetWidgetTitle
        ? `目标卡片：${params.targetWidgetTitle}`
        : '',
      '',
      '请围绕这个问题提炼可直接用于制作信息卡的 insight。',
      '只返回 JSON。',
      '',
      windowedPromptText
        ? '系统提示：已按目标卡片周围段落窗口化，聚焦卡片所在上下文。'
        : focusedContext.warnings.length > 0
          ? `系统提示：${focusedContext.warnings.join(' ')}`
          : '系统提示：当前已挑选与问题最相关的文档片段。',
      '',
      '相关文档片段：',
      promptBody,
    ].filter(Boolean).join('\n')
    this.deps.log(
      `document insight focused read chunks=${focusedContext.chunks.length}, selected=${effectiveChunks.length}, sectioned=${focusedContext.usedSectionAnchors}, windowed=${Boolean(windowedPromptText)}`,
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
        selectedChunkCount: effectiveChunks.length,
        promptChars: promptBody.length,
        usedSectionAnchors: focusedContext.usedSectionAnchors,
      },
    }
  }

  private readonly approvedWidgetComponentNames: DocumentWidgetComponentName[] = [...WIDGET_COMPONENT_IDS]

  private clipWidgetCodeForPrompt(widgetCode: string, maxChars = 1000): string {
    const trimmed = String(widgetCode || '').trim()
    if (trimmed.length <= maxChars) return trimmed
    return `${trimmed.slice(0, maxChars)}\n…[widgetCode 已截断]`
  }

  private collectExistingWidgetsForPrompt(snapshot: ActiveDocumentSnapshot, limit = 3): DocumentWidgetRecord[] {
    const widgets = collectDocumentWidgets(snapshot.content)
    return widgets.slice(0, Math.max(1, limit))
  }

  private serializeExistingWidgetsForPrompt(records: DocumentWidgetRecord[]): string {
    const payload = records.map((record) => ({
      id: record.id,
      index: record.index,
      title: record.title,
      mode: record.mode,
      component: record.componentSpec?.component || null,
      hasComponentSpec: Boolean(record.componentSpec),
      canPatch: Boolean(record.componentSpec),
      canReplace: true,
      widgetCode: this.clipWidgetCodeForPrompt(record.widgetCode),
    }))
    return JSON.stringify(payload, null, 2)
  }

  private buildWidgetDraftSystemPrompt(params: {
    plan: DocumentReadPlan
    hasExistingWidgets: boolean
  }): string {
    const propsBlock = describeApprovedWidgetProps(this.approvedWidgetComponentNames)
    const lines: string[] = [
      '你是 Ready 的 widget 草稿阶段。',
      '你只负责根据给定 insight 生成一个可写入文档的 componentSpec 草稿。',
      '必须只输出 JSON，且不要包裹 markdown 代码块。',
      '字段为 title、insertionMode、componentSpec、targetSectionTitle、targetWidgetTitle。',
      params.plan.operation === 'update'
        ? '这次是更新现有信息卡，不允许 append_end；必须使用 update_existing，并尽量提供 targetWidgetTitle。'
        : '默认 insertionMode 使用 append_end。',
      `componentSpec.component 只能是以下组件之一：${this.approvedWidgetComponentNames.join('、')}。`,
      '优先选择简单稳定的组件，不要发明 catalog 外的新组件。',
      '',
      '每个允许的组件 props 字段（! 表示必填，? 表示可选）：',
      propsBlock,
      '',
      '请严格按照上面的 props 字段输出，**所有必填字段都必须出现且非空**。',
    ]
    if (params.plan.operation === 'update' && params.hasExistingWidgets) {
      lines.push('')
      lines.push('注意：文档里已有 widget。若待更新 widget 已确定组件类型，**必须沿用同一组件**，不要换类别；改动只作用于 props 内容。')
      lines.push('')
      lines.push('若目标 widget 标记为 `canPatch=false`，说明它没有结构化底稿；此时不要输出 componentSpecPatch，必须输出完整 componentSpec 以整卡替换。')
      lines.push('【字段级 patch（优先）】若用户需求只涉及一两个字段的微调（例如仅改 tone/color/heading 或替换一条 point），请只输出 `componentSpecPatch`（仅含变更字段路径的对象），不要重新输出完整 componentSpec。')
      lines.push('仅当用户要求"整张卡片重写/彻底换内容/换组件类型"时才输出完整 componentSpec。patch 和 componentSpec 二选一。')
      lines.push('componentSpecPatch 字段结构：{ "component"?: string, "props"?: { ...只写变更字段 }, "dataSource"?: { ... } }。props 内对象会按字段合并，数组字段会整体替换，设为 null 表示删除该字段。')
    }
    return lines.join('\n')
  }

  private buildWidgetDraftUserPrompt(params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    insight: DocumentInsight
    plan: DocumentReadPlan
    existingWidgets: DocumentWidgetRecord[]
    targetCandidates?: string[]
    preferredTarget?: string
  }): string {
    const segments: string[] = []
    if (params.plan.operation === 'update' && params.existingWidgets.length > 0) {
      segments.push('现有 widget（update 候选，必须优先以此为改动基线）：')
      segments.push(this.serializeExistingWidgetsForPrompt(params.existingWidgets))
      segments.push('')
    }
    if (params.plan.operation === 'update' && params.targetCandidates && params.targetCandidates.length > 0) {
      segments.push('targetWidgetTitle 必须严格等于下列候选之一（大小写敏感）：')
      params.targetCandidates.forEach((title) => {
        segments.push(`- ${title}`)
      })
      if (params.preferredTarget) {
        segments.push(`上下文已指明目标 widget：${params.preferredTarget}。若无相反证据，请直接选它。`)
      }
      segments.push('若候选项里 `canPatch=false`，只能整卡替换，不能输出 patch-only。')
      segments.push('')
    }
    segments.push(`用户问题：${params.question}`)
    segments.push(`文档标题：${params.snapshot.title}`)
    segments.push(`任务类型：${params.plan.taskType}`)
    segments.push(`推荐组件：${params.insight.recommendedWidget}`)
    segments.push('')
    segments.push('insight JSON：')
    segments.push(JSON.stringify(params.insight, null, 2))
    return segments.join('\n')
  }

  private resolveControlledWidgetTarget(
    raw: string | undefined,
    candidates: string[],
  ): { resolved?: string; unresolvedReason?: string } {
    return resolveControlledWidgetTarget(raw, candidates)
  }

  private appendInsightWarning(insight: DocumentInsight, warning: string): void {
    const next = new Set(insight.warnings || [])
    next.add(warning)
    insight.warnings = Array.from(next)
  }

  private validateDraftComponentSpec(draft: DocumentWidgetDraft): string[] {
    if (!draft.componentSpec) return []
    const validation = validateDocumentWidgetComponentSpec(draft.componentSpec)
    return validation.ok ? [] : validation.errors
  }

  private findTargetWidgetRecord(
    records: DocumentWidgetRecord[],
    draft: DocumentWidgetDraft,
  ): DocumentWidgetRecord | null {
    if (draft.targetWidgetId) {
      return records.find((record) => record.id === draft.targetWidgetId) || null
    }
    const targetTitle = String(draft.targetWidgetTitle || '').trim()
    if (!targetTitle) return null
    return records.find((record) => record.title === targetTitle) || null
  }

  private evaluateWidgetDraftAttempt(
    parsed: Record<string, unknown> | null,
    params: {
      insight: DocumentInsight
      snapshot: ActiveDocumentSnapshot
      plan: DocumentReadPlan
      existingWidgets?: DocumentWidgetRecord[]
      targetCandidates?: string[]
      preferredTarget?: string
    },
  ): { draft: DocumentWidgetDraft; errors: string[] } {
    if (!parsed) {
      const draft = this.normalizePipelineWidgetDraft(null, params)
      return { draft, errors: ['Widget 草稿未返回可解析 JSON'] }
    }
    const hasComponentSpec = parsed.componentSpec
      && typeof parsed.componentSpec === 'object'
      && typeof (parsed.componentSpec as Record<string, unknown>).component === 'string'
      && String((parsed.componentSpec as Record<string, unknown>).component).trim().length > 0
    const patchCandidate = parsed.componentSpecPatch && typeof parsed.componentSpecPatch === 'object' && !Array.isArray(parsed.componentSpecPatch)
      ? parsed.componentSpecPatch as Record<string, unknown>
      : null
    const hasMeaningfulPatch = Boolean(patchCandidate && (
      (typeof patchCandidate.component === 'string' && patchCandidate.component.trim().length > 0)
      || (patchCandidate.props && typeof patchCandidate.props === 'object')
      || (patchCandidate.dataSource && typeof patchCandidate.dataSource === 'object')
    ))
    const draft = this.normalizePipelineWidgetDraft(parsed, params)
    const errors: string[] = []
    if (params.plan.operation === 'update' && params.targetCandidates && params.targetCandidates.length > 0) {
      const resolution = this.resolveControlledWidgetTarget(draft.targetWidgetTitle, params.targetCandidates)
      if (resolution.resolved) {
        draft.targetWidgetTitle = resolution.resolved
      } else if (params.preferredTarget && params.targetCandidates.includes(params.preferredTarget)) {
        draft.targetWidgetTitle = params.preferredTarget
      } else if (resolution.unresolvedReason) {
        errors.push(resolution.unresolvedReason)
      }
      const targetRecord = this.findTargetWidgetRecord(params.existingWidgets || [], draft)
      if (targetRecord) {
        draft.targetWidgetId = targetRecord.id
      }
    }
    if (params.plan.operation === 'update' && hasMeaningfulPatch && !hasComponentSpec) {
      const targetRecord = this.findTargetWidgetRecord(params.existingWidgets || [], draft)
      if (targetRecord?.componentSpec) {
        draft.targetWidgetId = targetRecord.id
      } else if (targetRecord) {
        errors.push(`目标 widget "${targetRecord.title}" 不支持字段级 patch，请输出完整 componentSpec 以整卡替换。`)
      }
    } else if (!hasComponentSpec) {
      errors.push('Widget 草稿缺少 componentSpec.component')
    } else {
      errors.push(...this.validateDraftComponentSpec(draft))
    }
    return { draft, errors }
  }

  private async buildDocumentPipelineWidgetDraft(params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    insight: DocumentInsight
    plan: DocumentReadPlan
    timeoutMs: number
    providerContext: TurnProviderContext
    signal: AbortSignal
    preferredTargetWidgetTitle?: string
  }): Promise<{ draft: DocumentWidgetDraft; cacheable: boolean }> {
    const existingWidgets = params.plan.operation === 'update'
      ? this.collectExistingWidgetsForPrompt(params.snapshot, 32)
      : []
    const allUpdateWidgets = params.plan.operation === 'update'
      ? collectDocumentWidgets(params.snapshot.content)
      : []
    const targetCandidates = params.plan.operation === 'update'
      ? Array.from(new Set(allUpdateWidgets.map((record) => record.title).filter((title) => title && title.length > 0)))
      : []
    const preferredTargetResolved = params.preferredTargetWidgetTitle
      ? this.resolveControlledWidgetTarget(params.preferredTargetWidgetTitle, targetCandidates).resolved
      : undefined
    const systemPrompt = this.buildWidgetDraftSystemPrompt({
      plan: params.plan,
      hasExistingWidgets: existingWidgets.length > 0,
    })
    const userPrompt = this.buildWidgetDraftUserPrompt({
      question: params.question,
      snapshot: params.snapshot,
      insight: params.insight,
      plan: params.plan,
      existingWidgets,
      targetCandidates,
      preferredTarget: preferredTargetResolved,
    })

    const firstRaw = await this.requestDocumentPipelineSimpleText({
      systemPrompt,
      userPrompt,
      providerContext: params.providerContext,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    })
    this.deps.log(`document pipeline widget draft attempt=1 rawChars=${firstRaw.length}`)
    const firstParsed = this.parsePipelineJson<Record<string, unknown>>(firstRaw)
    const firstAttempt = this.evaluateWidgetDraftAttempt(firstParsed, {
      insight: params.insight,
      snapshot: params.snapshot,
      plan: params.plan,
      existingWidgets: allUpdateWidgets,
      targetCandidates,
      preferredTarget: preferredTargetResolved,
    })
    if (firstAttempt.errors.length === 0) {
      return { draft: firstAttempt.draft, cacheable: true }
    }
    this.deps.log(`document pipeline widget draft attempt=1 invalid errors=${firstAttempt.errors.join('；')}`)

    const repromptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: firstRaw || '{}' },
      {
        role: 'user',
        content: [
          '上一次输出的 componentSpec 未通过校验：',
          firstAttempt.errors.join('\n'),
          '',
          '请只修正上述字段，保持其它内容不变，重新输出完整 JSON。所有必填字段都必须出现且非空。',
        ].join('\n'),
      },
    ]
    const secondRaw = await this.requestDocumentPipelineSimpleText({
      systemPrompt,
      userPrompt,
      providerContext: params.providerContext,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      messages: repromptMessages,
    })
    this.deps.log(`document pipeline widget draft attempt=2 rawChars=${secondRaw.length}`)
    const secondParsed = this.parsePipelineJson<Record<string, unknown>>(secondRaw)
    const secondAttempt = this.evaluateWidgetDraftAttempt(secondParsed, {
      insight: params.insight,
      snapshot: params.snapshot,
      plan: params.plan,
      existingWidgets: allUpdateWidgets,
      targetCandidates,
      preferredTarget: preferredTargetResolved,
    })
    if (secondAttempt.errors.length === 0) {
      return { draft: secondAttempt.draft, cacheable: true }
    }
    this.deps.log(`document pipeline widget draft attempt=2 invalid errors=${secondAttempt.errors.join('；')}`)

    const lastErrors = secondAttempt.errors.length > 0 ? secondAttempt.errors : firstAttempt.errors
    if (params.plan.operation === 'update') {
      throw new Error(`Widget componentSpec 两次校验失败：${lastErrors.join('；')}`)
    }

    const fallbackDraft = this.buildFallbackDocumentWidgetDraft({
      insight: params.insight,
      snapshot: params.snapshot,
      plan: params.plan,
      targetWidgetTitle: preferredTargetResolved
        || secondAttempt.draft.targetWidgetTitle
        || firstAttempt.draft.targetWidgetTitle,
    })
    this.appendInsightWarning(
      params.insight,
      `已使用兜底摘要卡（原因：componentSpec 两次校验失败 · ${lastErrors.join('；')}）`,
    )
    this.deps.log('document pipeline widget draft fallback=applied mode=create')
    return { draft: fallbackDraft, cacheable: false }
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
    stage?: DocumentWidgetWriteStage
    signal: AbortSignal
  }): Promise<string> {
    throwIfAborted(params.signal, 'writeDocumentWidget')
    const tool = wrapToolCall(params.requestModuleToolAction, params.signal)
    const stage: DocumentWidgetWriteStage = params.stage
      || (params.draft.insertionMode === 'update_existing' ? 'update' : 'insert')

    if (stage === 'locate') {
      const target = String(params.draft.targetWidgetId || params.draft.targetWidgetTitle || '').trim()
      if (!target) {
        throw new Error('未提供要更新的信息卡目标')
      }
      const listPayload = await tool('document.listWidgets', {
        tabId: params.snapshot.tabId || undefined,
      })
      const widgetSummary = typeof listPayload.summary === 'string' ? listPayload.summary : ''
      if (!this.doesListWidgetsSummaryContainTarget(widgetSummary, target)) {
        throw new Error(`未找到可更新的信息卡：${target}`)
      }
      return `已定位信息卡：${target}`
    }

    if (stage === 'update') {
      const target = String(params.draft.targetWidgetId || params.draft.targetWidgetTitle || '').trim()
      if (!target) {
        throw new Error('未提供要更新的信息卡目标')
      }
      const writeStartedAt = Date.now()
      const payload = await tool('document.updateWidget', {
        target,
        title: params.draft.title,
        componentSpec: params.draft.componentSpec,
        componentSpecPatch: params.draft.componentSpecPatch,
        widgetCode: params.draft.widgetCode,
        tabId: params.snapshot.tabId || undefined,
      })
      if (payload.ok === false && payload.reason === 'target_not_resolved') {
        logAgentMetric('patch_target_resolution_failed', {
          stage: 'document_task_pipeline_executor.writeDocumentWidget',
          targetKind: /^widget_[a-z0-9]+$/.test(target) ? 'internal_id' : 'title_or_index',
          targetLen: target.length,
          hadPatch: Boolean(params.draft.componentSpecPatch),
          hadComponentSpec: Boolean(params.draft.componentSpec),
          hadWidgetCode: Boolean(params.draft.widgetCode),
          tabId: params.snapshot.tabId || null,
        })
      }
      const ackWidgetId = String(params.draft.targetWidgetId || '').trim()
      const ackTabId = String(params.snapshot.tabId || '').trim()
      if (ackWidgetId && ackTabId && payload.ok !== false) {
        const committed = await documentCommitRegistry.waitForCommitAfter({
          tabId: ackTabId,
          widgetId: ackWidgetId,
          afterTimestamp: writeStartedAt,
          timeoutMs: 10_000,
        })
        if (!committed) {
          this.deps.log(
            `document widget commit ack missing tabId=${ackTabId} widgetId=${ackWidgetId} — proceeding`,
          )
          logAgentMetric('document_widget_commit_ack_missing', {
            tabId: ackTabId,
            widgetId: ackWidgetId,
            elapsedMs: Date.now() - writeStartedAt,
          })
        }
      }
      return typeof payload.summary === 'string' ? payload.summary : `已更新信息卡：${target}`
    }

    const payload = await tool('document.insertWidget', {
      title: params.draft.title,
      componentSpec: params.draft.componentSpec,
      widgetCode: params.draft.widgetCode,
      position: params.draft.insertionMode === 'after_section' ? 'after_section' : 'append_end',
      sectionTitle: params.draft.targetSectionTitle,
      tabId: params.snapshot.tabId || undefined,
    })
    return typeof payload.summary === 'string' ? payload.summary : '已写入信息卡'
  }

  private async verifyDocumentTaskPlanWrite(params: {
    draft: DocumentWidgetDraft
    snapshot: ActiveDocumentSnapshot
    targetResource: RequestEnvelopeResource
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
  }): Promise<string> {
    throwIfAborted(params.signal, 'verifyDocumentTaskPlanWrite')
    const tool = wrapToolCall(params.requestModuleToolAction, params.signal)
    const inspectPayload = await tool('document.inspectActive', {
      tabId: params.snapshot.tabId || undefined,
    })
    const refreshedSnapshot = this.normalizeActiveDocumentSnapshot((inspectPayload as { snapshot?: unknown }).snapshot)
    if (!refreshedSnapshot) {
      throw new Error(`写入后未能重新读取 ${params.targetResource.name}`)
    }
    if (refreshedSnapshot.content === params.snapshot.content) {
      throw new Error(`写入后 ${params.targetResource.name} 内容未变化`)
    }

    const payload = await tool('document.listWidgets', {
      tabId: params.snapshot.tabId || undefined,
    })
    const summary = typeof payload.summary === 'string' ? payload.summary : ''
    const verifyTarget = params.draft.insertionMode === 'update_existing'
      ? params.draft.targetWidgetId || params.draft.targetWidgetTitle || params.draft.title
      : params.draft.title
    if (verifyTarget && summary && !summary.includes(verifyTarget) && !/当前文档共有\s+\d+\s+个 widget/.test(summary)) {
      throw new Error(`写入后未在 ${params.targetResource.name} 中确认到目标信息卡`)
    }
    const verifyPath = refreshedSnapshot.path || params.targetResource.documentPath || params.targetResource.path
    if (verifyPath) {
      const readResult = await readDocumentEditableText(verifyPath)
      if (!readResult.success) {
        throw new Error(`写入后未能重新读取磁盘文件：${verifyPath}`)
      }
      if (readResult.content !== refreshedSnapshot.content) {
        throw new Error(`写入后 ${params.targetResource.name} 未成功落盘`)
      }
      if (readResult.content === params.snapshot.content) {
        throw new Error(`写入后 ${params.targetResource.name} 的磁盘内容未变化`)
      }
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
    sessionId: string
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
        targetPathOverride: targetResource.documentPath || targetResource.path,
        targetTabIdOverride: targetResource.tabId || null,
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
        params.sessionId,
        params.job.instruction,
        targetSnapshot,
        {
          job: params.job,
          cacheKeyOverride: insightCacheKey,
        },
      )
      const envelopeWidgetTargetForInsight = params.requestEnvelope.resources.find(
        (resource) => resource.kind === 'widget_target',
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
        targetWidgetTitle: envelopeWidgetTargetForInsight?.name,
      })
      currentInsight = ('insight' in insightResult ? insightResult.insight : insightResult)
      if (!cachedInsight) {
        this.storeCachedDocumentInsight(
          params.sessionId,
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
        params.sessionId,
        params.job.instruction,
        params.job,
        targetSnapshot,
      )
      const planTaskType = classifyStructuredDocumentIntent(params.job.instruction) || 'document_read_then_widget_create'
      const envelopeWidgetTarget = params.requestEnvelope.resources.find((resource) => resource.kind === 'widget_target')
      if (cachedDraft) {
        currentDraft = cachedDraft
      } else {
        try {
          const built = await this.buildDocumentPipelineWidgetDraft({
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
            preferredTargetWidgetTitle: envelopeWidgetTarget?.name,
          })
          currentDraft = built.draft
          if (built.cacheable) {
            this.storeCachedDocumentWidgetDraft(
              params.sessionId,
              params.job.instruction,
              params.job,
              targetSnapshot,
              built.draft,
            )
          }
        } catch (err) {
          this.deleteCachedWidgetDraft(
            params.sessionId,
            params.job.instruction,
            params.job,
            targetSnapshot,
            'build-failed',
          )
          throw err
        }
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
      // Invalidate the draft we just wrote so the next round (same phrasing, same widget/tab)
      // doesn't replay a stale draft. The next round builds fresh from the now-updated document.
      this.deleteCachedWidgetDraft(
        params.sessionId,
        params.job.instruction,
        params.job,
        targetSnapshot,
        'write-succeeded',
      )
      // Also invalidate any other cache entries targeting the same widgetId. Prompt phrasing and
      // snapshot text both change between rounds, so key-level deletion alone can miss drafts
      // cached under an earlier phrasing that still points at the same widget.
      if (currentDraft.targetWidgetId) {
        this.deleteCachedWidgetDraftsByWidgetId(
          params.sessionId,
          currentDraft.targetWidgetId,
          'write-succeeded',
        )
      }
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
      throwIfAborted(params.signal, 'document.saveTab')
      const savePayload = await raceWithTimeout(
        params.requestModuleToolAction('document.saveTab', {
          tabId: targetSnapshot.tabId || undefined,
        }),
        params.signal,
        getDocumentToolTimeout('document.saveTab'),
        'document.saveTab',
      )
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
        snapshot: targetSnapshot,
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
    sessionId: string
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
            sessionId: params.sessionId,
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
        sessionId: params.sessionId,
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
      tabId: typeof (raw as { tabId?: unknown }).tabId === 'string' && (raw as { tabId: string }).tabId.trim()
        ? String((raw as { tabId: string }).tabId).trim()
        : null,
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
    sessionId: string,
    question: string,
    snapshot: ActiveDocumentSnapshot,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): DocumentInsightStageResult | null {
    const key = this.buildDocumentInsightCacheKey(question, snapshot, options)
    const sessionEntries = this.sessionInsightCaches.get(sessionId) || []
    const hit = sessionEntries.find((entry) => entry.key === key)
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
    sessionId: string,
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
    const previous = this.sessionInsightCaches.get(sessionId) || []
    const nextEntries = [
      nextEntry,
      ...previous.filter((entry) => entry.key !== key),
    ].slice(0, 6)
    this.sessionInsightCaches.set(sessionId, nextEntries)
    this.documentInsightCache.set(key, { insight, metrics })
    this.deps.log(`document insight cache store key=${key}`)
  }

  private getCachedDocumentWidgetDraft(
    sessionId: string,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
  ): DocumentWidgetDraft | null {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const sessionEntries = this.sessionWidgetDraftCaches.get(sessionId) || []
    const now = Date.now()
    const sessionHit = sessionEntries.find((entry) => entry.key === key)
    if (!sessionHit) return null
    if (sessionHit.expiresAt <= now) {
      const filtered = sessionEntries.filter((entry) => entry.key !== key)
      if (filtered.length > 0) this.sessionWidgetDraftCaches.set(sessionId, filtered)
      else this.sessionWidgetDraftCaches.delete(sessionId)
      this.deps.log(`document widget draft session cache expired key=${key}`)
      return null
    }
    this.deps.log(`document widget draft session cache hit key=${key}`)
    return sessionHit.draft
  }

  private storeCachedDocumentWidgetDraft(
    sessionId: string,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
    draft: DocumentWidgetDraft,
  ): void {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const now = Date.now()
    const nextEntry = {
      key,
      draft,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + WIDGET_DRAFT_TTL_MS,
    }
    const previous = this.sessionWidgetDraftCaches.get(sessionId) || []
    const nextEntries = [
      nextEntry,
      ...previous.filter((entry) => entry.key !== key && entry.expiresAt > now),
    ].slice(0, 6)
    this.sessionWidgetDraftCaches.set(sessionId, nextEntries)
    this.deps.log(`document widget draft cache store key=${key}`)
  }

  private deleteCachedWidgetDraft(
    sessionId: string,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
    reason: string,
  ): void {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const sessionEntries = this.sessionWidgetDraftCaches.get(sessionId)
    const hadSessionEntry = Array.isArray(sessionEntries)
      && sessionEntries.some((entry) => entry.key === key)
    if (hadSessionEntry) {
      const filtered = (sessionEntries || []).filter((entry) => entry.key !== key)
      if (filtered.length > 0) {
        this.sessionWidgetDraftCaches.set(sessionId, filtered)
      } else {
        this.sessionWidgetDraftCaches.delete(sessionId)
      }
      this.deps.log(`document widget draft cache invalidated key=${key} reason=${reason}`)
    }
  }

  private deleteCachedWidgetDraftsByWidgetId(
    sessionId: string,
    widgetId: string,
    reason: string,
  ): void {
    if (!widgetId) return
    const entries = this.sessionWidgetDraftCaches.get(sessionId)
    if (!Array.isArray(entries) || entries.length === 0) return
    const keep: typeof entries = []
    let removed = 0
    for (const entry of entries) {
      if (entry.draft.targetWidgetId === widgetId) { removed++; continue }
      keep.push(entry)
    }
    if (removed === 0) return
    if (keep.length > 0) {
      this.sessionWidgetDraftCaches.set(sessionId, keep)
    } else {
      this.sessionWidgetDraftCaches.delete(sessionId)
    }
    this.deps.log(
      `document widget draft cache invalidated-by-widget widgetId=${widgetId} removed=${removed} reason=${reason}`,
    )
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
    targetTabIdOverride?: string | null
  }): Promise<ActiveDocumentSnapshot> {
    const targetPath = params.targetPathOverride?.trim() || this.extractDocumentPathFromUserText(params.userText)
    const targetTabId = params.targetTabIdOverride?.trim() || null
    const requestSnapshot = async (): Promise<ActiveDocumentSnapshot | null> => {
      if (!params.requestModuleToolAction) return null
      const tryInspect = async (tabId?: string): Promise<ActiveDocumentSnapshot | null> => {
        throwIfAborted(params.signal, 'document.inspectActive')
        const payload = await raceWithTimeout(
          params.requestModuleToolAction!('document.inspectActive', { tabId }),
          params.signal,
          getDocumentToolTimeout('document.inspectActive'),
          'document.inspectActive',
        )
        return this.normalizeActiveDocumentSnapshot((payload as { snapshot?: unknown }).snapshot)
      }
      const targetedSnapshot = await tryInspect(targetTabId || undefined)
      if (targetedSnapshot || !targetTabId) return targetedSnapshot
      return tryInspect(undefined)
    }

    if (params.requestModuleToolAction && targetPath) {
      const activeSnapshot = await requestSnapshot()
      if (!activeSnapshot || activeSnapshot.path !== targetPath) {
        throwIfAborted(params.signal, 'document.openTab')
        await raceWithTimeout(
          params.requestModuleToolAction('document.openTab', { path: targetPath }),
          params.signal,
          getDocumentToolTimeout('document.openTab'),
          'document.openTab',
        )
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
          tabId: null,
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
    sessionId: string
    agentName?: string
    providerContext: TurnProviderContext
    emitStructuredTaskPayload: (payload: unknown) => void
  }): Promise<{ success: boolean; finalText?: string; error?: string }> {
    const sourceMaterial = buildDocumentInsightSourceMaterial({
      requestEnvelope: params.executionIntentContext.requestEnvelope,
      snapshotContent: '',
    })
    const realEnvelopeWidgetTarget = params.executionIntentContext.requestEnvelope.resources.find(
      (resource) => resource.kind === 'widget_target',
    )
    const leaseSnapshot = (params.agentName && this.deps.resolveWidgetEditLease)
      ? this.deps.resolveWidgetEditLease({ agent: params.agentName, sessionId: params.sessionId })
      : null
    const envelopeWidgetTarget: RequestEnvelopeResource | null = realEnvelopeWidgetTarget
      || (leaseSnapshot
        ? {
          kind: 'widget_target',
          source: 'widget_target',
          id: `lease::${leaseSnapshot.widgetId || leaseSnapshot.widgetTitle}`,
          name: leaseSnapshot.widgetTitle,
          path: leaseSnapshot.documentPath || null,
          documentPath: leaseSnapshot.documentPath || null,
          tabId: leaseSnapshot.tabId || null,
          widgetId: leaseSnapshot.widgetId || null,
          // Carry the recorded widget body slice so cache keys stay stable across rounds.
          text: leaseSnapshot.widgetTextSample || '',
          summary: null,
          order: 0,
          canRead: true,
          canWrite: true,
          widgetFingerprint: leaseSnapshot.widgetFingerprint || null,
          widgetTextSample: leaseSnapshot.widgetTextSample || null,
        }
        : null)
    if (!realEnvelopeWidgetTarget && leaseSnapshot) {
      logAgentMetric('widget_lease_synthesized_envelope_target', {
        sessionId: params.sessionId || null,
        leaseWidgetId: leaseSnapshot.widgetId,
        leaseTabId: leaseSnapshot.tabId,
        leaseAgeMs: Math.max(0, Date.now() - leaseSnapshot.acquiredAt),
        origin: leaseSnapshot.origin,
      })
    }
    if (realEnvelopeWidgetTarget && params.agentName && this.deps.acquireWidgetEditLease) {
      this.deps.acquireWidgetEditLease({
        agent: params.agentName,
        sessionId: params.sessionId,
        widgetId: realEnvelopeWidgetTarget.widgetId || null,
        tabId: realEnvelopeWidgetTarget.tabId || null,
        documentPath: realEnvelopeWidgetTarget.documentPath || realEnvelopeWidgetTarget.path || null,
        widgetTitle: realEnvelopeWidgetTarget.name || null,
        origin: 'envelope_widget_target',
      })
    }
    const pipelinePhaseOrder: Array<DocumentTaskPipelinePhaseUpdate['phase']> = buildPipelinePhaseOrder(params.structuredIntent)
    const pipelinePhaseTitles: Record<DocumentTaskPipelinePhaseUpdate['phase'], string> = {
      loading_document: '读取文档',
      building_insight: '提炼重点',
      generating_widget_spec: '生成卡片草稿',
      writing_widget: params.structuredIntent === 'document_read_then_widget_update' ? '更新现有卡片' : '写入卡片',
      locating_target_widget: '定位目标卡片',
      updating_widget: '更新现有卡片',
      listing_widgets: '列出文档卡片',
      removing_widget: '删除信息卡',
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
        targetPathOverride: envelopeWidgetTarget?.documentPath || envelopeWidgetTarget?.path || null,
        targetTabIdOverride: envelopeWidgetTarget?.tabId || null,
      }),
      getCachedInsight: ({ question, snapshot }) => this.getCachedDocumentInsight(
        params.sessionId,
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
        targetWidgetTitle: envelopeWidgetTarget?.name,
      }),
      storeCachedInsight: ({ question, snapshot, insight, metrics }) => {
        this.storeCachedDocumentInsight(params.sessionId, question, snapshot, insight, metrics)
      },
      buildWidgetDraft: async ({ question, snapshot, insight, plan, signal }) => {
        const built = await this.buildDocumentPipelineWidgetDraft({
          question,
          snapshot,
          insight,
          plan,
          timeoutMs: 60_000,
          providerContext: params.providerContext,
          signal,
          preferredTargetWidgetTitle: envelopeWidgetTarget?.name,
        })
        if (!built.draft.targetWidgetId && envelopeWidgetTarget?.widgetId) {
          built.draft.targetWidgetId = envelopeWidgetTarget.widgetId
        }
        return built.draft
      },
      writeWidget: async ({ draft, snapshot, stage, signal }) => {
        const writeResult = await this.writeDocumentWidget({
          draft,
          snapshot,
          stage,
          requestModuleToolAction: params.requestModuleToolAction,
          signal,
        })
        if (params.agentName && this.deps.acquireWidgetEditLease) {
          const fingerprintSource = draft.componentSpec
            ? JSON.stringify(draft.componentSpec)
            : draft.widgetCode || draft.title
          const widgetFingerprint = fingerprintSource ? hashText(fingerprintSource) : null
          // widgetCode captures the actual fence body that was written — use it (trimmed to 2KB) as
          //   a non-empty text sample so downstream cache keys differentiate widget states.
          const widgetTextSample = draft.widgetCode
            ? draft.widgetCode.slice(0, 2048)
            : draft.title || null
          this.deps.acquireWidgetEditLease({
            agent: params.agentName,
            sessionId: params.sessionId,
            widgetId: draft.targetWidgetId || envelopeWidgetTarget?.widgetId || null,
            tabId: snapshot.tabId || envelopeWidgetTarget?.tabId || null,
            documentPath: snapshot.path || envelopeWidgetTarget?.documentPath || envelopeWidgetTarget?.path || null,
            widgetTitle: draft.title || envelopeWidgetTarget?.name || null,
            origin: stage === 'locate' ? 'pipeline_locate' : 'pipeline_write',
            widgetFingerprint,
            widgetTextSample,
          })
        }
        return writeResult
      },
      saveDocument: async ({ snapshot, signal }) => {
        throwIfAborted(signal, 'document.saveTab')
        const payload = await raceWithTimeout(
          params.requestModuleToolAction('document.saveTab', { tabId: snapshot.tabId || undefined }),
          signal,
          getDocumentToolTimeout('document.saveTab'),
          'document.saveTab',
        )
        return typeof payload.summary === 'string' ? payload.summary : '已保存文档'
      },
      listWidgets: async ({ snapshot, signal }) => {
        throwIfAborted(signal, 'document.listWidgets')
        await raceWithTimeout(
          params.requestModuleToolAction('document.listWidgets', { tabId: snapshot.tabId || undefined }),
          signal,
          getDocumentToolTimeout('document.listWidgets'),
          'document.listWidgets',
        )
        const widgets = collectDocumentWidgets(snapshot.content || '')
        return {
          summaries: widgets.map(summarizeWidgetRecord),
          tabTitle: snapshot.title || '',
        }
      },
      removeWidget: async ({ plan, snapshot, stage, signal }) => {
        throwIfAborted(signal, 'document.removeWidget')
        const target = plan.preferredWidget || ''
        if (stage === 'locate') {
          return target
            ? `已定位待删除的信息卡：${target}`
            : '未提供待删除信息卡的 target，等待删除阶段反馈'
        }
        const payload = await raceWithTimeout(
          params.requestModuleToolAction('document.removeWidget', {
            target,
            tabId: snapshot.tabId || undefined,
          }),
          signal,
          getDocumentToolTimeout('document.removeWidget'),
          'document.removeWidget',
        )
        return typeof payload.summary === 'string' ? payload.summary : '已删除信息卡'
      },
      emitPhase: emitDocumentPipelinePhase,
    })

    const pipelineResult = await pipeline.run({
      question: params.executionIntentContext.userInstructionText,
      signal: params.signal,
      taskType: params.structuredIntent,
    })

    const fallbackWarnings = (pipelineResult.insight?.warnings || []).filter(
      (warning) => warning.includes('兜底摘要卡'),
    )
    if (fallbackWarnings.length > 0) {
      params.emitStructuredTaskPayload({
        module: 'document',
        message: fallbackWarnings[0],
        taskTitle: '文档信息卡',
        taskSummary: fallbackWarnings[0],
        executionDiagnostics: {
          pipeline: {
            document: {
              ...(documentPipelineDiagnostics || {}),
              fallbackWarning: fallbackWarnings[0],
              fallbackWarnings,
            },
          },
        },
      })
    }

    return {
      success: pipelineResult.success,
      finalText: pipelineResult.finalText,
      error: pipelineResult.error,
    }
  }
}
