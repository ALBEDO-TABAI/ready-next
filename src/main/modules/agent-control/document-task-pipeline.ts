import type { DocumentWidgetComponentSpec } from '../../../shared/document-widget-openui'
import { validateDocumentWidgetComponentSpec } from '../../../shared/document-widget-openui'

export type DocumentWidgetPipelinePhase =
  | 'loading_document'
  | 'building_insight'
  | 'generating_widget_spec'
  | 'writing_widget'
  | 'locating_target_widget'
  | 'updating_widget'
  | 'listing_widgets'
  | 'removing_widget'
  | 'saving_document'
  | 'completed'
  | 'failed'

export type DocumentWidgetWriteStage = 'locate' | 'update' | 'insert'

export type DocumentStructuredTaskType =
  | 'document_read_then_widget_create'
  | 'document_read_then_widget_update'
  | 'document_list_widgets'
  | 'document_remove_widget'

export type DocumentWidgetOperation = 'create' | 'update'

export interface ActiveDocumentSnapshot {
  title: string
  path: string | null
  content: string
  isDirty: boolean
  charCount: number
}

export interface DocumentReadPlan {
  taskType: DocumentStructuredTaskType
  operation: DocumentWidgetOperation
  question: string
  documentPath: string | null
  deepRead: boolean
  preferredWidget: string | null
  maxChars: number
}

export interface DocumentInsight {
  question: string
  documentPath: string | null
  documentTitle: string
  summary: string
  keyPoints: string[]
  evidence: Array<{
    sectionTitle?: string
    quote: string
  }>
  recommendedWidget:
    | 'info_card'
    | 'stats_card'
    | 'comparison_grid'
    | 'callout_block'
    | 'data_table'
  warnings?: string[]
}

export interface DocumentInsightMetrics {
  chunkCount?: number
  selectedChunkCount?: number
  promptChars?: number
  usedSectionAnchors?: boolean
  cacheHit?: boolean
}

export interface DocumentInsightStageResult {
  insight: DocumentInsight
  metrics?: DocumentInsightMetrics
}

export interface DocumentWidgetDraft {
  title: string
  componentSpec?: DocumentWidgetComponentSpec
  widgetCode?: string
  insertionMode: 'append_end' | 'after_section' | 'update_existing'
  targetSectionTitle?: string
  targetWidgetTitle?: string
}

export interface DocumentTaskPipelineBudget {
  totalMs: number
  loadDocumentMs: number
  buildInsightMs: number
  buildWidgetMs: number
  writeWidgetMs: number
  saveDocumentMs: number
}

export interface DocumentTaskPipelinePhaseUpdate {
  phase: DocumentWidgetPipelinePhase
  status: 'running' | 'completed' | 'failed'
  summary: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  budgetMs: number
  error?: string
  metrics?: DocumentInsightMetrics
}

export interface DocumentTaskPipelineResult {
  success: boolean
  plan: DocumentReadPlan
  snapshot?: ActiveDocumentSnapshot
  insight?: DocumentInsight
  widgetDraft?: DocumentWidgetDraft
  finalText?: string
  error?: string
}

interface DocumentTaskPipelineDeps {
  now?: () => Date
  log: (message: string) => void
  loadDocumentSnapshot: (params: { question: string; signal: AbortSignal }) => Promise<ActiveDocumentSnapshot>
  getCachedInsight?: (params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
  }) => Promise<DocumentInsightStageResult | DocumentInsight | null> | DocumentInsightStageResult | DocumentInsight | null
  buildInsight: (params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
    signal: AbortSignal
  }) => Promise<DocumentInsightStageResult | DocumentInsight>
  storeCachedInsight?: (params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
    insight: DocumentInsight
    metrics?: DocumentInsightMetrics
  }) => Promise<void> | void
  buildWidgetDraft: (params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    insight: DocumentInsight
    plan: DocumentReadPlan
    signal: AbortSignal
  }) => Promise<DocumentWidgetDraft>
  writeWidget: (params: {
    draft: DocumentWidgetDraft
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
    stage: DocumentWidgetWriteStage
    signal: AbortSignal
  }) => Promise<string>
  saveDocument: (params: {
    snapshot: ActiveDocumentSnapshot
    signal: AbortSignal
  }) => Promise<string>
  listWidgets?: (params: {
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
    signal: AbortSignal
  }) => Promise<string>
  removeWidget?: (params: {
    snapshot: ActiveDocumentSnapshot
    plan: DocumentReadPlan
    stage: 'locate' | 'remove'
    signal: AbortSignal
  }) => Promise<string>
  emitPhase?: (payload: DocumentTaskPipelinePhaseUpdate) => void
}

const DEFAULT_BUDGET: DocumentTaskPipelineBudget = {
  totalMs: 180_000,
  loadDocumentMs: 15_000,
  buildInsightMs: 60_000,
  buildWidgetMs: 60_000,
  writeWidgetMs: 15_000,
  saveDocumentMs: 15_000,
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  throw error
}

export class DocumentTaskPipeline {
  constructor(private readonly deps: DocumentTaskPipelineDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  private createReadPlan(
    question: string,
    snapshot?: ActiveDocumentSnapshot,
    taskType: DocumentStructuredTaskType = 'document_read_then_widget_create',
  ): DocumentReadPlan {
    const operation: DocumentWidgetOperation =
      taskType === 'document_read_then_widget_update' ? 'update' : 'create'
    // For list/remove tasks, operation is unused but set to 'create' as a neutral default.
    const preferredWidget =
      /stats card|指标卡|统计卡/i.test(question)
        ? 'stats_card'
        : /comparison|对比/i.test(question)
          ? 'comparison_grid'
          : /table|表格/i.test(question)
            ? 'data_table'
            : /callout|提示|提醒|警示/i.test(question)
              ? 'callout_block'
              : 'info_card'

    return {
      taskType,
      operation,
      question,
      documentPath: snapshot?.path || null,
      deepRead: (snapshot?.charCount || 0) > 4000 || /(先阅读|看完|通读|根据全文|根据当前文档)/i.test(question),
      preferredWidget,
      maxChars: 16_000,
    }
  }

  private validateInsight(insight: DocumentInsight): void {
    if (!insight.summary.trim()) {
      throw new Error('Document insight 缺少 summary')
    }
    if (!Array.isArray(insight.keyPoints) || insight.keyPoints.length === 0) {
      throw new Error('Document insight 缺少 keyPoints')
    }
  }

  private normalizeInsightStageResult(
    value: DocumentInsightStageResult | DocumentInsight,
    options?: { cacheHit?: boolean },
  ): DocumentInsightStageResult {
    const isWrapped = value && typeof value === 'object' && 'insight' in value
    const base = isWrapped
      ? value as DocumentInsightStageResult
      : { insight: value as DocumentInsight }
    return {
      insight: base.insight,
      metrics: {
        ...(base.metrics || {}),
        ...(options?.cacheHit ? { cacheHit: true } : {}),
      },
    }
  }

  private formatInsightPhaseSummary(result: DocumentInsightStageResult): string {
    const parts: string[] = []
    parts.push(result.metrics?.cacheHit ? '已复用文档重点（缓存命中）' : '已完成文档重点提炼')
    if (typeof result.metrics?.chunkCount === 'number' && typeof result.metrics?.selectedChunkCount === 'number') {
      parts.push(`共 ${result.metrics.chunkCount} 段，使用 ${result.metrics.selectedChunkCount} 段`)
    }
    if (typeof result.metrics?.usedSectionAnchors === 'boolean') {
      parts.push(result.metrics.usedSectionAnchors ? '章节切分' : '段落切分')
    }
    return parts.join(' · ')
  }

  private normalizeWidgetDraft(draft: DocumentWidgetDraft, plan: DocumentReadPlan): DocumentWidgetDraft {
    const normalized: DocumentWidgetDraft = {
      ...draft,
      title: draft.title?.trim() || 'document_summary_card',
      insertionMode: draft.insertionMode || (plan.operation === 'update' ? 'update_existing' : 'append_end'),
    }

    if (normalized.componentSpec) {
      const nextComponent = typeof normalized.componentSpec.component === 'string' && normalized.componentSpec.component.trim()
        ? normalized.componentSpec.component
        : plan.preferredWidget || 'info_card'
      normalized.componentSpec = {
        ...normalized.componentSpec,
        component: nextComponent,
      }
      const validation = validateDocumentWidgetComponentSpec(normalized.componentSpec)
      if (!validation.ok) {
        throw new Error(`Widget componentSpec 非法：${validation.errors.join('；')}`)
      }
    }

    if (!normalized.componentSpec && !(normalized.widgetCode && normalized.widgetCode.trim())) {
      throw new Error('Widget draft 缺少 componentSpec 或 widgetCode')
    }

    return normalized
  }

  private buildFailureFinalText(params: {
    insight?: DocumentInsight
    widgetDraft?: DocumentWidgetDraft
  }): string | undefined {
    if (params.widgetDraft) {
      return [
        '卡片草稿已生成，但写入或保存文档时失败。',
        `草稿标题：${params.widgetDraft.title}`,
        '你可以直接重试下一步，无需重新阅读文档。',
      ].join('\n')
    }
    if (params.insight) {
      return [
        '已先完成文档重点提炼，但卡片草稿阶段失败。',
        `提炼结论：${params.insight.summary}`,
        params.insight.keyPoints.length > 0
          ? `关键点：${params.insight.keyPoints.join('；')}`
          : '',
        '你可以继续重试卡片生成，无需重新阅读文档。',
      ].filter(Boolean).join('\n')
    }
    return undefined
  }

  private async runPhase<T>(params: {
    phase: Exclude<DocumentWidgetPipelinePhase, 'completed' | 'failed'>
    summary: string
    budgetMs: number
    totalStartedAtMs: number
    totalBudgetMs: number
    signal: AbortSignal
    fn: () => Promise<T>
    completedSummary?: (value: T) => string
    completedMetrics?: (value: T) => DocumentInsightMetrics | undefined
  }): Promise<T> {
    const remainingTotalBudget = params.totalBudgetMs - (Date.now() - params.totalStartedAtMs)
    const effectiveBudget = Math.max(1, Math.min(params.budgetMs, remainingTotalBudget))
    if (remainingTotalBudget <= 0) {
      throw new Error('document pipeline 总预算已耗尽')
    }

    const startedAt = this.now()
    this.deps.emitPhase?.({
      phase: params.phase,
      status: 'running',
      summary: params.summary,
      startedAt: startedAt.toISOString(),
      budgetMs: effectiveBudget,
    })
    this.deps.log(`document pipeline phase=${params.phase} status=running budgetMs=${effectiveBudget}`)

    let timer: NodeJS.Timeout | null = null
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        const error = new Error('Operation aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (params.signal.aborted) {
        onAbort()
        return
      }
      params.signal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      throwIfAborted(params.signal)
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`document pipeline phase=${params.phase} 超时（>${Math.floor(effectiveBudget / 1000)}s）`))
        }, effectiveBudget)
      })
      const value = await Promise.race([
        params.fn(),
        timeoutPromise,
        abortPromise,
      ])
      const endedAt = this.now()
      this.deps.emitPhase?.({
        phase: params.phase,
        status: 'completed',
        summary: params.completedSummary ? params.completedSummary(value) : params.summary,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        budgetMs: effectiveBudget,
        metrics: params.completedMetrics ? params.completedMetrics(value) : undefined,
      })
      this.deps.log(`document pipeline phase=${params.phase} status=completed durationMs=${endedAt.getTime() - startedAt.getTime()}`)
      return value
    } catch (error) {
      const endedAt = this.now()
      this.deps.emitPhase?.({
        phase: params.phase,
        status: 'failed',
        summary: params.summary,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        budgetMs: effectiveBudget,
        error: error instanceof Error ? error.message : String(error),
      })
      this.deps.log(`document pipeline phase=${params.phase} status=failed error=${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async run(params: {
    question: string
    signal: AbortSignal
    budget?: Partial<DocumentTaskPipelineBudget>
    taskType?: DocumentStructuredTaskType
  }): Promise<DocumentTaskPipelineResult> {
    const budget: DocumentTaskPipelineBudget = {
      ...DEFAULT_BUDGET,
      ...(params.budget || {}),
    }
    const totalStartedAtMs = Date.now()

    let plan = this.createReadPlan(params.question, undefined, params.taskType)
    let snapshot: ActiveDocumentSnapshot | undefined
    let insight: DocumentInsight | undefined
    let widgetDraft: DocumentWidgetDraft | undefined

    try {
      snapshot = await this.runPhase({
        phase: 'loading_document',
        summary: '正在读取文档内容',
        budgetMs: budget.loadDocumentMs,
        totalStartedAtMs,
        totalBudgetMs: budget.totalMs,
        signal: params.signal,
        fn: async () => await this.deps.loadDocumentSnapshot({
          question: params.question,
          signal: params.signal,
        }),
      })
      plan = this.createReadPlan(params.question, snapshot, params.taskType)

      if (plan.taskType === 'document_list_widgets') {
        if (!this.deps.listWidgets) {
          throw new Error('document pipeline 缺少 listWidgets 依赖')
        }
        const listSummary = await this.runPhase({
          phase: 'listing_widgets',
          summary: '正在列出文档中的信息卡',
          budgetMs: budget.writeWidgetMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.listWidgets!({
            snapshot: snapshot!,
            plan,
            signal: params.signal,
          }),
        })
        this.deps.emitPhase?.({
          phase: 'completed',
          status: 'completed',
          summary: '文档信息卡已列出',
          startedAt: this.now().toISOString(),
          budgetMs: budget.totalMs,
        })
        this.deps.log('document pipeline phase=completed status=completed')
        return {
          success: true,
          plan,
          snapshot,
          finalText: listSummary,
        }
      }

      if (plan.taskType === 'document_remove_widget') {
        if (!this.deps.removeWidget) {
          throw new Error('document pipeline 缺少 removeWidget 依赖')
        }
        const removeLocateBudgetMs = Math.max(1, Math.floor(budget.writeWidgetMs / 3))
        const removeBudgetMs = Math.max(1, budget.writeWidgetMs - removeLocateBudgetMs)
        await this.runPhase({
          phase: 'locating_target_widget',
          summary: '正在定位待删除的信息卡',
          budgetMs: removeLocateBudgetMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.removeWidget!({
            snapshot: snapshot!,
            plan,
            stage: 'locate',
            signal: params.signal,
          }),
        })
        const removeSummary = await this.runPhase({
          phase: 'removing_widget',
          summary: '正在删除信息卡',
          budgetMs: removeBudgetMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.removeWidget!({
            snapshot: snapshot!,
            plan,
            stage: 'remove',
            signal: params.signal,
          }),
        })
        const saveSummary = await this.runPhase({
          phase: 'saving_document',
          summary: '正在保存文档',
          budgetMs: budget.saveDocumentMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.saveDocument({
            snapshot: snapshot!,
            signal: params.signal,
          }),
        })
        this.deps.emitPhase?.({
          phase: 'completed',
          status: 'completed',
          summary: '信息卡已删除',
          startedAt: this.now().toISOString(),
          budgetMs: budget.totalMs,
        })
        this.deps.log('document pipeline phase=completed status=completed')
        return {
          success: true,
          plan,
          snapshot,
          finalText: [removeSummary, saveSummary].filter(Boolean).join('\n'),
        }
      }

      const cachedInsight = await this.deps.getCachedInsight?.({
        question: params.question,
        snapshot,
        plan,
      }) || null

      const insightStage = await this.runPhase({
        phase: 'building_insight',
        summary: cachedInsight ? '正在复用已缓存的文档重点' : '正在提炼文档重点',
        budgetMs: budget.buildInsightMs,
        totalStartedAtMs,
        totalBudgetMs: budget.totalMs,
        signal: params.signal,
        fn: async () => {
          if (cachedInsight) {
            return this.normalizeInsightStageResult(cachedInsight, { cacheHit: true })
          }
          const nextInsight = this.normalizeInsightStageResult(await this.deps.buildInsight({
            question: params.question,
            snapshot: snapshot!,
            plan,
            signal: params.signal,
          }))
          this.validateInsight(nextInsight.insight)
          await this.deps.storeCachedInsight?.({
            question: params.question,
            snapshot: snapshot!,
            plan,
            insight: nextInsight.insight,
            metrics: nextInsight.metrics,
          })
          return nextInsight
        },
        completedSummary: (value) => this.formatInsightPhaseSummary(value),
        completedMetrics: (value) => value.metrics,
      })
      insight = insightStage.insight
      widgetDraft = await this.runPhase({
        phase: 'generating_widget_spec',
        summary: '正在生成信息卡草稿',
        budgetMs: budget.buildWidgetMs,
        totalStartedAtMs,
        totalBudgetMs: budget.totalMs,
        signal: params.signal,
        fn: async () => this.normalizeWidgetDraft(await this.deps.buildWidgetDraft({
          question: params.question,
          snapshot: snapshot!,
          insight: insight!,
          plan,
          signal: params.signal,
        }), plan),
      })

      let writeSummary: string
      if (plan.operation === 'update') {
        const locateBudgetMs = Math.max(1, Math.floor(budget.writeWidgetMs / 3))
        const updateBudgetMs = Math.max(1, budget.writeWidgetMs - locateBudgetMs)
        await this.runPhase({
          phase: 'locating_target_widget',
          summary: '正在定位现有信息卡',
          budgetMs: locateBudgetMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.writeWidget({
            draft: widgetDraft!,
            snapshot: snapshot!,
            plan,
            stage: 'locate',
            signal: params.signal,
          }),
        })
        writeSummary = await this.runPhase({
          phase: 'updating_widget',
          summary: '正在更新现有信息卡',
          budgetMs: updateBudgetMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.writeWidget({
            draft: widgetDraft!,
            snapshot: snapshot!,
            plan,
            stage: 'update',
            signal: params.signal,
          }),
        })
      } else {
        writeSummary = await this.runPhase({
          phase: 'writing_widget',
          summary: '正在写入信息卡',
          budgetMs: budget.writeWidgetMs,
          totalStartedAtMs,
          totalBudgetMs: budget.totalMs,
          signal: params.signal,
          fn: async () => await this.deps.writeWidget({
            draft: widgetDraft!,
            snapshot: snapshot!,
            plan,
            stage: 'insert',
            signal: params.signal,
          }),
        })
      }

      const saveSummary = await this.runPhase({
        phase: 'saving_document',
        summary: '正在保存文档',
        budgetMs: budget.saveDocumentMs,
        totalStartedAtMs,
        totalBudgetMs: budget.totalMs,
        signal: params.signal,
        fn: async () => await this.deps.saveDocument({
          snapshot: snapshot!,
          signal: params.signal,
        }),
      })

      this.deps.emitPhase?.({
        phase: 'completed',
        status: 'completed',
        summary: '文档信息卡已完成',
        startedAt: this.now().toISOString(),
        budgetMs: budget.totalMs,
      })
      this.deps.log('document pipeline phase=completed status=completed')
      return {
        success: true,
        plan,
        snapshot,
        insight,
        widgetDraft,
        finalText: [writeSummary, saveSummary].filter(Boolean).join('\n'),
      }
    } catch (error) {
      if (!isAbortError(error)) {
        this.deps.emitPhase?.({
          phase: 'failed',
          status: 'failed',
          summary: '文档信息卡生成失败',
          startedAt: this.now().toISOString(),
          budgetMs: budget.totalMs,
          error: error instanceof Error ? error.message : String(error),
        })
        this.deps.log(`document pipeline phase=failed status=failed error=${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        success: false,
        plan,
        snapshot,
        insight,
        widgetDraft,
        finalText: this.buildFailureFinalText({
          insight,
          widgetDraft,
        }),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
