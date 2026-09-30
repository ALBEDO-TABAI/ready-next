import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRSSAgentHandler,
  type RSSAnalysisProgressLike,
  type RSSAnalysisStatus,
} from '../renderer/modules/rss/rss-agent-handler'

const item = {
  id: 'hn-1',
  title: 'Amazon Web Services - Four Years and Out',
  source: 'Hacker News',
  author: '',
  sourceId: 'hn',
  summary: 'A long-running article analysis target',
  publishedAt: '2026-05-24T08:00:00.000Z',
  read: false,
  starred: false,
  link: 'https://example.com/aws-four-years',
}

function createHandler(params: {
  startStatus?: RSSAnalysisStatus
  progress?: RSSAnalysisProgressLike | null
}) {
  const lastAnalysis: Array<Record<string, unknown>> = []
  let progressMap: Record<string, RSSAnalysisProgressLike> = {}
  let progressReads = 0

  const handler = createRSSAgentHandler({
    items: [item],
    selectedSource: 'hn',
    selectedItem: item,
    loadRSSData: async () => {},
    handleRefresh: async () => {},
    handleItemClick: () => {},
    setLastAnalysis: (payload) => {
      lastAnalysis.push(payload)
    },
    setAnalysisProgressMap: (updater) => {
      progressMap = updater(progressMap)
    },
    getWorkspaceRoot: () => '/workspace',
    rssApi: {
      startItemAnalysis: async () => ({
        success: true,
        data: {
          id: 'job-1',
          itemId: item.id,
          status: params.startStatus || 'queued',
          outputDir: '/workspace/aws-four-years/analysis',
          reportPath: null,
        },
      }),
      getItemAnalysisProgress: async () => {
        progressReads += 1
        return {
          success: true,
          data: params.progress ? { [item.id]: params.progress } : {},
        }
      },
    },
    documentApi: undefined,
    sleep: async () => {
      throw new Error('rss.analyzeItem must not wait for terminal completion')
    },
  } as Parameters<typeof createRSSAgentHandler>[0] & {
    sleep: () => Promise<void>
  })

  return {
    handler,
    get lastAnalysis() {
      return lastAnalysis
    },
    get progressMap() {
      return progressMap
    },
    get progressReads() {
      return progressReads
    },
  }
}

test('RSS agent analysis returns a running background job instead of waiting for completion', async () => {
  const runningProgress: RSSAnalysisProgressLike = {
    itemId: item.id,
    jobId: 'job-1',
    action: 'copy',
    status: 'running_subagent',
    progress: 86,
    message: 'subagent 正在撰写报告',
    error: null,
    outputDir: '/workspace/aws-four-years/analysis',
    reportPath: null,
    updatedAt: '2026-05-24T08:39:47.000Z',
  }
  const subject = createHandler({ progress: runningProgress })

  const result = await subject.handler({
    module: 'rss',
    action: 'rss.analyzeItem',
    args: { itemId: item.id, analysisType: 'copy' },
  }) as Record<string, unknown>

  assert.equal(subject.progressReads, 1)
  assert.equal(result.intent, 'analyze_rss_item')
  assert.equal(result.jobId, 'job-1')
  assert.equal(result.status, 'running_subagent')
  assert.equal(result.outputDir, '/workspace/aws-four-years/analysis')
  assert.equal(result.summary, 'RSS 条目分析已启动：《Amazon Web Services - Four Years and Out》。')
  assert.deepEqual(subject.progressMap[item.id], runningProgress)
  assert.equal(subject.lastAnalysis.at(-1)?.status, 'running_subagent')
  assert.equal(
    subject.lastAnalysis.at(-1)?.manifestPath,
    '/workspace/aws-four-years/analysis/manifest.json',
  )
})

test('RSS agent preserves source warnings instead of presenting an old report as current', async () => {
  const warning = '原文已更新或删除，此报告来自旧版本。'
  const subject = createHandler({ progress: {
    itemId: item.id, jobId: 'job-1', action: 'copy', status: 'success', progress: 100,
    message: '分析完成', error: null, outputDir: '/workspace/analysis', reportPath: '/workspace/analysis/report.md',
    updatedAt: '2026-09-30T00:00:00Z', sourceWarning: warning,
  } })
  const result = await subject.handler({ module: 'rss', action: 'rss.analyzeItem', args: { itemId: item.id, analysisType: 'copy' } }) as Record<string, unknown>
  assert.equal(result.sourceWarning, warning)
  assert.ok(String(result.summary).includes(warning))
})

test('RSS agent analysis reports immediate failures without pretending the job started cleanly', async () => {
  const failedProgress: RSSAnalysisProgressLike = {
    itemId: item.id,
    jobId: 'job-1',
    action: 'copy',
    status: 'failed',
    progress: 24,
    message: null,
    error: 'AI 模型超时或返回内容不完整',
    outputDir: '/workspace/aws-four-years/analysis',
    reportPath: null,
    updatedAt: '2026-05-24T08:40:47.000Z',
  }
  const subject = createHandler({ progress: failedProgress })

  const result = await subject.handler({
    module: 'rss',
    action: 'rss.analyzeItem',
    args: { itemId: item.id, analysisType: 'copy' },
  }) as Record<string, unknown>

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'AI 模型超时或返回内容不完整')
  assert.equal(result.summary, 'RSS 条目分析失败：《Amazon Web Services - Four Years and Out》。')
  assert.equal(subject.lastAnalysis.at(-1)?.status, 'failed')
})

test('RSS agent addSource treats existing sources as a non-blocking result', async () => {
  let reloaded = false
  const handler = createRSSAgentHandler({
    items: [item],
    selectedSource: 'hn',
    selectedItem: item,
    loadRSSData: async () => {
      reloaded = true
    },
    handleRefresh: async () => {},
    handleItemClick: () => {},
    setLastAnalysis: () => {},
    setAnalysisProgressMap: () => {},
    getWorkspaceRoot: () => '/workspace',
    rssApi: {
      addSource: async () => ({
        success: true,
        data: { warning: 'source_exists', itemCount: 30 },
      }),
    },
    documentApi: undefined,
  })

  const result = await handler({
    module: 'rss',
    action: 'rss.addSource',
    args: { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  }) as Record<string, unknown>

  assert.equal(reloaded, true)
  assert.equal(result.status, 'already_exists')
  assert.equal(result.summary, 'RSS 源已存在：Hacker News')
})

test('RSS capture reads a completed report again after its source changes without starting analysis', async () => {
  const params: { progress: RSSAnalysisProgressLike | null } = { progress: null }
  const subject = createHandler(params)
  const before = await subject.handler({ module: 'rss', action: 'rss.captureSession', args: {} }) as Record<string, unknown>
  assert.equal(before.analysis, null)
  params.progress = { itemId: item.id, jobId: 'completed-job', action: 'copy', status: 'success', progress: 100,
    message: '分析完成', error: null, outputDir: '/report', reportPath: '/report/analysis.md', updatedAt: '2026-09-30',
    sourceWarning: '原文已更新或删除，此报告来自旧版本。' }
  const after = await subject.handler({ module: 'rss', action: 'rss.captureSession', args: {} }) as Record<string, unknown>
  assert.deepEqual(after.analysis, params.progress)
  assert.equal(subject.lastAnalysis.length, 0)
  assert.equal(subject.progressReads, 2)
})
