import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DocumentTaskPipeline } from '../main/modules/agent-control/document-pipeline/document-task-pipeline'

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
      'insert operation keeps the 5-phase path with single writing_widget',
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
    const writes: Array<{ stage: 'locate' | 'update' | 'insert'; title: string; target?: string }> = []
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
      writeWidget: async ({ draft, stage }) => {
        writes.push({
          stage,
          title: draft.title,
          target: draft.targetWidgetTitle,
        })
        if (stage === 'locate') return '已定位现有信息卡：ready_positioning_card'
        return '已更新现有信息卡（需求文档.md）'
      },
      insertWidget: async ({ draft }) => {
        writes.push({ stage: 'insert', title: draft.title })
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
    assert.deepEqual(writes, [
      { stage: 'locate', title: 'ready_positioning_card', target: 'ready_positioning_card' },
      { stage: 'update', title: 'ready_positioning_card', target: 'ready_positioning_card' },
    ])
    assert.ok(
      phases.some((phase) => phase.phase === 'locating_target_widget'),
      'expected a locating_target_widget phase before updating',
    )
    assert.ok(
      phases.some((phase) => phase.phase === 'updating_widget'),
      'expected an updating_widget phase after locating',
    )
    assert.ok(
      !phases.some((phase) => phase.phase === 'writing_widget'),
      'update path should not emit the writing_widget phase',
    )
    assert.match(result.finalText || '', /已更新现有信息卡/)
  })

  it('fails update_existing writes when the target widget cannot be found instead of appending a new card', async () => {
    const writes: Array<{ stage: 'locate' | 'update' | 'insert'; title: string; target?: string }> = []
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
      writeWidget: async ({ draft, stage }) => {
        writes.push({
          stage,
          title: draft.title,
          target: draft.targetWidgetTitle,
        })
        if (stage === 'locate') {
          throw new Error('未找到可更新的信息卡：missing_widget')
        }
        return '不应走到 update 阶段'
      },
      insertWidget: async ({ draft }) => {
        writes.push({ stage: 'insert', title: draft.title })
        return '不应回退到追加路径'
      },
      saveDocument: async () => '已保存文档：/tmp/需求文档.md',
    } as any)

    const result = await pipeline.run({
      question: '把这个信息卡改成极简风格',
      signal: new AbortController().signal,
      taskType: 'document_read_then_widget_update',
    })

    assert.equal(result.success, false)
    assert.deepEqual(writes, [{
      stage: 'locate',
      title: 'ready_positioning_card',
      target: 'missing_widget',
    }])
    assert.match(result.error || '', /未找到可更新的信息卡/)
    assert.match(result.finalText || '', /卡片草稿已生成/)
  })

  it('runs document_list_widgets as a single listing phase after loading the document', async () => {
    const phases: Array<{ phase: string; status: string }> = []
    const pipeline = new DocumentTaskPipeline({
      now: () => new Date('2026-04-16T10:00:00.000Z'),
      log: () => undefined,
      loadDocumentSnapshot: async () => ({
        title: '需求文档.md',
        path: '/tmp/需求文档.md',
        content: 'Ready 是一个集成式创作工作台。',
        isDirty: false,
        charCount: 16,
      }),
      buildInsight: async () => {
        throw new Error('list 路径不应调用 buildInsight')
      },
      buildWidgetDraft: async () => {
        throw new Error('list 路径不应调用 buildWidgetDraft')
      },
      writeWidget: async () => {
        throw new Error('list 路径不应调用 writeWidget')
      },
      saveDocument: async () => {
        throw new Error('list 路径不应调用 saveDocument')
      },
      listWidgets: async () => ({
        summaries: [
          {
            id: 'widget_aaaaaa',
            index: 1,
            title: 'ready_positioning_card',
            mode: 'static-html',
            componentHint: null,
            preview: 'positioning preview',
            hasState: false,
            hasComponentSpec: false,
            canPatch: false,
            canReplace: true,
          },
          {
            id: 'widget_bbbbbb',
            index: 2,
            title: 'project_overview_card',
            mode: 'static-html',
            componentHint: 'project_overview_card',
            preview: 'overview preview',
            hasState: false,
            hasComponentSpec: true,
            canPatch: true,
            canReplace: true,
          },
        ],
        tabTitle: '需求文档.md',
      }),
      emitPhase: (phase) => {
        phases.push({ phase: phase.phase, status: phase.status })
      },
    } as any)

    const result = await pipeline.run({
      question: '看看这个文档里有哪些信息卡',
      signal: new AbortController().signal,
      taskType: 'document_list_widgets',
    })

    assert.equal(result.success, true)
    const finalText = result.finalText || ''
    assert.match(finalText, /已查到「需求文档\.md」中的 2 个 widget/)
    assert.match(finalText, /「ready_positioning_card」/)
    assert.match(finalText, /「project_overview_card」/)
    assert.match(finalText, /请指出具体标题或序号/)
    assert.doesNotMatch(finalText, /```json/, 'list finalText 不应再夹带 json 围栏')
    assert.doesNotMatch(finalText, /id=widget_/, 'list finalText 不应再回显内部 id')
    assert.doesNotMatch(finalText, /可 patch/, 'list finalText 不应再回显内部字段')
    assert.deepEqual(
      phases
        .filter((item) => item.status === 'running' || item.phase === 'completed')
        .map((item) => item.phase),
      ['loading_document', 'listing_widgets', 'completed'],
      'list intent uses the minimal 2-phase path',
    )
  })

  it('runs document_remove_widget through locate → remove → save phases', async () => {
    const removeCalls: Array<'locate' | 'remove'> = []
    const phases: Array<{ phase: string; status: string }> = []
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
      buildInsight: async () => {
        throw new Error('remove 路径不应调用 buildInsight')
      },
      buildWidgetDraft: async () => {
        throw new Error('remove 路径不应调用 buildWidgetDraft')
      },
      writeWidget: async () => {
        throw new Error('remove 路径不应调用 writeWidget')
      },
      saveDocument: async () => '已保存文档：/tmp/需求文档.md',
      removeWidget: async ({ stage }) => {
        removeCalls.push(stage)
        return stage === 'locate' ? '已定位 ready_positioning_card' : '已删除 ready_positioning_card'
      },
      emitPhase: (phase) => {
        phases.push({ phase: phase.phase, status: phase.status })
      },
    } as any)

    const result = await pipeline.run({
      question: '把当前文档里的那个信息卡删掉',
      signal: new AbortController().signal,
      taskType: 'document_remove_widget',
    })

    assert.equal(result.success, true)
    assert.deepEqual(removeCalls, ['locate', 'remove'])
    assert.match(result.finalText || '', /已删除 ready_positioning_card/)
    assert.deepEqual(
      phases
        .filter((item) => item.status === 'running' || item.phase === 'completed')
        .map((item) => item.phase),
      ['loading_document', 'locating_target_widget', 'removing_widget', 'saving_document', 'completed'],
      'remove intent walks locate → remove → save',
    )
  })
})
