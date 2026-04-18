import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DocumentTaskPipeline } from '../main/modules/agent-control/document-task-pipeline'

describe('DocumentTaskPipeline', () => {
  it('runs insight and widget creation in separate phases before deterministic writeback', async () => {
    const phases: Array<{ phase: string; status: string; summary: string }> = []
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: null,
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: true,
        charCount: 16,
      }),
      buildInsight: async ({ question, snapshot }) => ({
        insight: {
          question,
          documentPath: snapshot.path,
          documentTitle: snapshot.title,
          summary: 'Ready 是一个集成式创作工作台。',
          keyPoints: ['统一工作台', '多模式切换'],
          evidence: [{ quote: '集成式创作工作台' }],
          recommendedWidget: 'info_card',
        },
        metrics: {
          chunkCount: 3,
          selectedChunkCount: 2,
          promptChars: 120,
          usedSectionAnchors: true,
        },
      }),
      buildWidgetDraft: async ({ insight }) => ({
        title: 'ready_positioning_card',
        insertionMode: 'append_end',
        componentSpec: {
          component: 'info_card',
          props: {
            heading: 'Ready 项目定位',
            body: insight.summary,
            points: insight.keyPoints,
            tone: 'info',
          },
        },
      }),
      writeWidget: async () => '已在文档尾部插入 widget（需求文档.md）',
      saveDocument: async () => '已另存文档：/tmp/需求文档.md',
      emitPhase: (phase) => {
        phases.push({ phase: phase.phase, status: phase.status, summary: phase.summary })
      },
    })

    const result = await pipeline.run({
      question: '先阅读当前文档，然后做一个项目定位信息卡',
      signal: new AbortController().signal,
    })

    assert.equal(result.success, true)
    assert.equal(result.insight?.summary, 'Ready 是一个集成式创作工作台。')
    assert.equal(result.widgetDraft?.title, 'ready_positioning_card')
    assert.match(result.finalText || '', /已在文档尾部插入 widget/)
    assert.deepEqual(
      phases
        .filter((item) => item.status === 'running' || item.phase === 'completed')
        .map((item) => item.phase),
      [
        'loading_document',
        'building_insight',
        'generating_widget_spec',
        'writing_widget',
        'saving_document',
        'completed',
      ],
    )
    assert.match(
      phases.find((item) => item.phase === 'building_insight' && item.status === 'completed')?.summary || '',
      /3 段.*2 段/,
    )
  })

  it('reuses cached insight instead of rebuilding it again', async () => {
    let buildInsightCalls = 0
    let storeCalls = 0
    const cachedInsight = {
      question: '先阅读当前文档，然后做一个项目定位信息卡',
      documentPath: null,
      documentTitle: '需求文档.md',
      summary: '缓存里的结论',
      keyPoints: ['统一工作台', '多模式切换'],
      evidence: [{ quote: '集成式创作工作台' }],
      recommendedWidget: 'info_card' as const,
    }
    const phases: Array<{ phase: string; status: string; summary: string }> = []
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: null,
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: true,
        charCount: 16,
      }),
      getCachedInsight: async () => ({
        insight: cachedInsight,
        metrics: {
          chunkCount: 4,
          selectedChunkCount: 2,
          promptChars: 96,
          usedSectionAnchors: true,
          cacheHit: true,
        },
      }),
      buildInsight: async () => {
        buildInsightCalls += 1
        throw new Error('should not rebuild insight on cache hit')
      },
      storeCachedInsight: async () => {
        storeCalls += 1
      },
      buildWidgetDraft: async ({ insight }) => ({
        title: 'ready_positioning_card',
        insertionMode: 'append_end',
        componentSpec: {
          component: 'info_card',
          props: {
            heading: 'Ready 项目定位',
            body: insight.summary,
            points: insight.keyPoints,
            tone: 'info',
          },
        },
      }),
      writeWidget: async () => '已在文档尾部插入 widget（需求文档.md）',
      saveDocument: async () => '已另存文档：/tmp/需求文档.md',
      emitPhase: (phase) => {
        phases.push({ phase: phase.phase, status: phase.status, summary: phase.summary })
      },
    })

    const result = await pipeline.run({
      question: '先阅读当前文档，然后做一个项目定位信息卡',
      signal: new AbortController().signal,
    })

    assert.equal(result.success, true)
    assert.equal(result.insight?.summary, '缓存里的结论')
    assert.equal(buildInsightCalls, 0)
    assert.equal(storeCalls, 0)
    assert.match(
      phases.find((item) => item.phase === 'building_insight' && item.status === 'completed')?.summary || '',
      /缓存命中/,
    )
    assert.match(
      phases.find((item) => item.phase === 'building_insight' && item.status === 'completed')?.summary || '',
      /4 段.*2 段/,
    )
  })

  it('returns insight fallback text when widget generation fails after reading succeeds', async () => {
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: null,
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: true,
        charCount: 16,
      }),
      buildInsight: async ({ question, snapshot }) => ({
        insight: {
          question,
          documentPath: snapshot.path,
          documentTitle: snapshot.title,
          summary: 'Ready 是一个集成式创作工作台。',
          keyPoints: ['统一工作台', '多模式切换'],
          evidence: [{ quote: '集成式创作工作台' }],
          recommendedWidget: 'info_card',
        },
        metrics: {
          chunkCount: 3,
          selectedChunkCount: 2,
          promptChars: 120,
          usedSectionAnchors: true,
        },
      }),
      buildWidgetDraft: async () => {
        throw new Error('widget stage timeout')
      },
      writeWidget: async () => 'unused',
      saveDocument: async () => 'unused',
    })

    const result = await pipeline.run({
      question: '先阅读当前文档，然后做一个项目定位信息卡',
      signal: new AbortController().signal,
    })

    assert.equal(result.success, false)
    assert.equal(result.insight?.summary, 'Ready 是一个集成式创作工作台。')
    assert.match(result.finalText || '', /已先完成文档重点提炼/)
    assert.match(result.finalText || '', /Ready 是一个集成式创作工作台/)
  })

  it('returns widget draft fallback text when save fails after widget write succeeds', async () => {
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: null,
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: true,
        charCount: 16,
      }),
      buildInsight: async ({ question, snapshot }) => ({
        insight: {
          question,
          documentPath: snapshot.path,
          documentTitle: snapshot.title,
          summary: 'Ready 是一个集成式创作工作台。',
          keyPoints: ['统一工作台', '多模式切换'],
          evidence: [{ quote: '集成式创作工作台' }],
          recommendedWidget: 'info_card',
        },
        metrics: {
          chunkCount: 3,
          selectedChunkCount: 2,
          promptChars: 120,
          usedSectionAnchors: true,
        },
      }),
      buildWidgetDraft: async () => ({
        title: 'ready_positioning_card',
        insertionMode: 'append_end',
        componentSpec: {
          component: 'info_card',
          props: {
            heading: 'Ready 项目定位',
            body: 'Ready 是一个集成式创作工作台。',
            points: ['统一工作台', '多模式切换'],
            tone: 'info',
          },
        },
      }),
      writeWidget: async () => '已在文档尾部插入 widget（需求文档.md）',
      saveDocument: async () => {
        throw new Error('save failed')
      },
    })

    const result = await pipeline.run({
      question: '先阅读当前文档，然后做一个项目定位信息卡',
      signal: new AbortController().signal,
    })

    assert.equal(result.success, false)
    assert.equal(result.widgetDraft?.title, 'ready_positioning_card')
    assert.match(result.finalText || '', /卡片草稿已生成/)
    assert.match(result.finalText || '', /ready_positioning_card/)
  })

  it('routes update_existing drafts to widget update instead of append insert', async () => {
    const writes: Array<{ kind: 'update' | 'insert'; title: string; target?: string }> = []
    const phases: Array<{ phase: string; summary: string }> = []
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: '/tmp/需求文档.md',
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: true,
        charCount: 16,
      }),
      buildInsight: async ({ question, snapshot }) => ({
        insight: {
          question,
          documentPath: snapshot.path,
          documentTitle: snapshot.title,
          summary: 'Ready 是一个集成式创作工作台。',
          keyPoints: ['统一工作台', '多模式切换'],
          evidence: [{ quote: '集成式创作工作台' }],
          recommendedWidget: 'info_card',
        },
      }),
      buildWidgetDraft: async () => ({
        title: 'ready_positioning_card',
        insertionMode: 'update_existing',
        targetWidgetTitle: 'ready_positioning_card',
        componentSpec: {
          component: 'info_card',
          props: {
            heading: 'Ready 项目定位',
            body: '更简洁的内容',
            tone: 'warning',
          },
        },
      }),
      writeWidget: async ({ draft }) => {
        writes.push({
          kind: draft.insertionMode === 'update_existing' ? 'update' : 'insert',
          title: draft.title,
          target: draft.targetWidgetTitle,
        })
        return '已更新现有信息卡（需求文档.md）'
      },
      insertWidget: async ({ draft }) => {
        writes.push({ kind: 'insert', title: draft.title })
        return '不应走到追加路径'
      },
      saveDocument: async () => '已保存文档：/tmp/需求文档.md',
      emitPhase: (phase) => {
        phases.push({ phase: phase.phase, summary: phase.summary })
      },
    } as any)

    const result = await pipeline.run({
      question: '把这个信息卡改成极简风格',
      signal: new AbortController().signal,
      taskType: 'document_read_then_widget_update',
    })

    assert.equal(result.success, true)
    assert.deepEqual(writes, [{
      kind: 'update',
      title: 'ready_positioning_card',
      target: 'ready_positioning_card',
    }])
    assert.ok(
      phases.some((phase) => phase.phase === 'writing_widget' && /定位|更新现有信息卡/.test(phase.summary)),
      'expected task progress to describe locating/updating the existing widget',
    )
    assert.match(result.finalText || '', /已更新现有信息卡/)
  })

  it('fails update_existing writes when the target widget cannot be found instead of appending a new card', async () => {
    const writes: Array<{ kind: 'update' | 'insert'; title: string; target?: string }> = []
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: '/tmp/需求文档.md',
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: true,
        charCount: 16,
      }),
      buildInsight: async ({ question, snapshot }) => ({
        insight: {
          question,
          documentPath: snapshot.path,
          documentTitle: snapshot.title,
          summary: 'Ready 是一个集成式创作工作台。',
          keyPoints: ['统一工作台', '多模式切换'],
          evidence: [{ quote: '集成式创作工作台' }],
          recommendedWidget: 'info_card',
        },
      }),
      buildWidgetDraft: async () => ({
        title: 'ready_positioning_card',
        insertionMode: 'update_existing',
        targetWidgetTitle: 'missing_widget',
        componentSpec: {
          component: 'info_card',
          props: {
            heading: 'Ready 项目定位',
            body: '更简洁的内容',
            tone: 'warning',
          },
        },
      }),
      writeWidget: async ({ draft }) => {
        writes.push({
          kind: draft.insertionMode === 'update_existing' ? 'update' : 'insert',
          title: draft.title,
          target: draft.targetWidgetTitle,
        })
        throw new Error('未找到可更新的信息卡：missing_widget')
      },
      insertWidget: async ({ draft }) => {
        writes.push({ kind: 'insert', title: draft.title })
        return '不应回退到追加路径'
      },
      saveDocument: async () => '已保存文档：/tmp/需求文档.md',
    } as any)

    const result = await pipeline.run({
      question: '把这个信息卡改成极简风格',
      signal: new AbortController().signal,
    })

    assert.equal(result.success, false)
    assert.deepEqual(writes, [{
      kind: 'update',
      title: 'ready_positioning_card',
      target: 'missing_widget',
    }])
    assert.match(result.error || '', /未找到可更新的信息卡/)
    assert.match(result.finalText || '', /卡片草稿已生成/)
  })
})
