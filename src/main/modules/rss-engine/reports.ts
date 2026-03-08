import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { generateMasterFeed, generateCategoryFeeds } from './feed-generator'
import { generateSubscriptionsOpml } from './opml'
import type { RSSSourceBenchmarkEntry, RSSSourceBenchmarkSummary } from './source-diagnostics'

interface RSSSourceForReport {
  id: string
  name: string
  url: string
  group_name: string
  platform?: string
}

interface RSSItemForReport {
  id: string
  source_id: string
  title: string
  link: string
  summary: string | null
  author: string | null
  published_at: number | null
  read: number
  ai_tags: string | null
}

export interface RSSArtifactsResult {
  rootDir: string
  files: {
    latestUpdate: string
    summary: string
    masterFeed: string
    categoryFeeds: Record<string, string>
    subscriptionsOpml: string
  }
}

export interface RSSBenchmarkArtifactsResult {
  rootDir: string
  files: {
    benchmarkJson: string
    benchmarkMarkdown: string
  }
}

function formatDate(unixSeconds: number | null): string {
  if (!unixSeconds) return '-'
  return new Date(unixSeconds * 1000).toLocaleString('zh-CN')
}

function renderLatestUpdateMarkdown(
  insertedItems: RSSItemForReport[],
  sourceById: Map<string, RSSSourceForReport>,
): string {
  const lines = [
    '# RSS 最新更新',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ]

  if (insertedItems.length === 0) {
    lines.push('本次无新增内容。')
    return lines.join('\n')
  }

  for (const item of insertedItems) {
    const source = sourceById.get(item.source_id)
    lines.push(`- [${item.title}](${item.link})`)
    lines.push(`  - 来源：${source?.name || item.source_id}`)
    lines.push(`  - 时间：${formatDate(item.published_at)}`)
    lines.push(`  - 分类：${item.ai_tags || '其他'}`)
  }

  return lines.join('\n')
}

function renderSummaryMarkdown(
  sources: RSSSourceForReport[],
  items: RSSItemForReport[],
): string {
  const unread = items.filter((item) => item.read === 0).length
  const categoryCounts = new Map<string, number>()
  for (const item of items) {
    const key = item.ai_tags || '其他'
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1)
  }

  const sourceLines = sources.map((source) => `- ${source.name} (${source.platform || 'rss'})`)
  const categoryLines = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `- ${category}: ${count}`)

  return [
    '# RSS 汇总报告',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 概览',
    `- 订阅源数量：${sources.length}`,
    `- 内容总量：${items.length}`,
    `- 未读数量：${unread}`,
    '',
    '## 订阅源列表',
    ...sourceLines,
    '',
    '## 分类分布',
    ...(categoryLines.length > 0 ? categoryLines : ['- 暂无数据']),
  ].join('\n')
}

export async function generateRSSArtifacts(params: {
  sources: RSSSourceForReport[]
  allItems: RSSItemForReport[]
  insertedItems: RSSItemForReport[]
}): Promise<RSSArtifactsResult> {
  const rootDir = join(app.getPath('userData'), 'rss-artifacts')
  await mkdir(rootDir, { recursive: true })

  const sourceById = new Map(params.sources.map((source) => [source.id, source]))
  const latestUpdateContent = renderLatestUpdateMarkdown(params.insertedItems, sourceById)
  const summaryContent = renderSummaryMarkdown(params.sources, params.allItems)

  const masterFeedContent = generateMasterFeed(params.allItems, params.sources)
  const categoryFeedsContent = generateCategoryFeeds(params.allItems, params.sources)
  const opmlContent = generateSubscriptionsOpml(params.sources)

  const latestUpdatePath = join(rootDir, 'latest_update.md')
  const summaryPath = join(rootDir, 'summary.md')
  const masterFeedPath = join(rootDir, 'feed.xml')
  const opmlPath = join(rootDir, 'subscriptions.opml')

  await writeFile(latestUpdatePath, latestUpdateContent, 'utf8')
  await writeFile(summaryPath, summaryContent, 'utf8')
  await writeFile(masterFeedPath, masterFeedContent, 'utf8')
  await writeFile(opmlPath, opmlContent, 'utf8')

  const categoryFeedPaths: Record<string, string> = {}
  for (const [slug, content] of Object.entries(categoryFeedsContent)) {
    const outputPath = join(rootDir, `feed.${slug}.xml`)
    await writeFile(outputPath, content, 'utf8')
    categoryFeedPaths[slug] = outputPath
  }

  return {
    rootDir,
    files: {
      latestUpdate: latestUpdatePath,
      summary: summaryPath,
      masterFeed: masterFeedPath,
      categoryFeeds: categoryFeedPaths,
      subscriptionsOpml: opmlPath,
    },
  }
}

function renderBenchmarkMarkdown(params: {
  startedAt: string
  finishedAt: string
  entries: RSSSourceBenchmarkEntry[]
  summary: RSSSourceBenchmarkSummary
}): string {
  const lines = [
    '# RSS Source Benchmark',
    '',
    `开始时间：${new Date(params.startedAt).toLocaleString('zh-CN')}`,
    `完成时间：${new Date(params.finishedAt).toLocaleString('zh-CN')}`,
    '',
    '## 总览',
    `- 源数：${params.summary.sourceCount}`,
    `- 成功：${params.summary.successCount}`,
    `- 失败：${params.summary.failureCount}`,
    `- p50：${params.summary.p50DurationMs ?? '未记录'} ms`,
    `- p95：${params.summary.p95DurationMs ?? '未记录'} ms`,
    `- Scrapling 候选平台：${params.summary.scraplingCandidatePlatforms.join(', ') || '无'}`,
    '',
    '## 平台汇总',
  ]

  for (const platform of params.summary.platforms) {
    lines.push(
      `- ${platform.label}: ${platform.successCount}/${platform.sourceCount} 成功 · backend=${platform.backend} · p95=${platform.p95DurationMs ?? '未记录'}ms`,
    )
  }

  lines.push('', '## 源明细')

  for (const entry of params.entries) {
    lines.push(
      `- ${entry.sourceName} [${entry.platform}] backend=${entry.backend} success=${entry.success} items=${entry.itemCount} duration=${entry.durationMs}ms`,
    )
    if (entry.error) {
      lines.push(`  - error: ${entry.error}`)
    }
    if (entry.failureKind) {
      lines.push(`  - failureKind: ${entry.failureKind}`)
    }
  }

  return lines.join('\n')
}

export async function generateRSSBenchmarkArtifacts(params: {
  startedAt: string
  finishedAt: string
  entries: RSSSourceBenchmarkEntry[]
  summary: RSSSourceBenchmarkSummary
}): Promise<RSSBenchmarkArtifactsResult> {
  const rootDir = join(app.getPath('userData'), 'rss-artifacts')
  await mkdir(rootDir, { recursive: true })

  const benchmarkJsonPath = join(rootDir, 'benchmark.latest.json')
  const benchmarkMarkdownPath = join(rootDir, 'benchmark.latest.md')

  await writeFile(
    benchmarkJsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...params,
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(benchmarkMarkdownPath, renderBenchmarkMarkdown(params), 'utf8')

  return {
    rootDir,
    files: {
      benchmarkJson: benchmarkJsonPath,
      benchmarkMarkdown: benchmarkMarkdownPath,
    },
  }
}
