import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RSSArticle } from '../../../shared/rss-workspace'
import { atomicWriteText } from '../agent-control/atomic-write'
import { analysisReportName } from './analysis-report'

export interface ArticleAnalysisSource {
  itemId: string
  revision: string
  completeness: 'ready' | 'partial'
  capturedAt: number | null
}

export interface ArticleAnalysisResult {
  source: ArticleAnalysisSource
  sourcePath: string
}

export interface ArticleAnalysisDeps {
  read(itemId: string): RSSArticle | null
  load(itemId: string): Promise<RSSArticle>
  summarize(input: {
    title: string; link: string; source: string; summary: string; publishedAt?: string; extractedText: string; sourceScope: string
  }): Promise<string>
}

export function assertArticleAnalysisCurrent(source: ArticleAnalysisSource, read: ArticleAnalysisDeps['read']): void {
  if (read(source.itemId)?.revision !== source.revision) throw new Error('原文已更新或删除，请重新发起分析。')
}

export async function runArticleAnalysis(
  input: { itemId: string; sourceRevision: string; outputDir: string },
  deps: ArticleAnalysisDeps,
): Promise<ArticleAnalysisResult> {
  if (deps.read(input.itemId)?.sourceRevision !== input.sourceRevision) throw new Error('原文已更新或删除，请重新发起分析。')
  const article = await deps.load(input.itemId)
  if (article.sourceRevision !== input.sourceRevision) throw new Error('原文已更新或删除，请重新发起分析。')
  if ((article.body.status !== 'ready' && article.body.status !== 'partial') || !article.body.markdown) {
    throw new Error(article.body.error || '尚未取得可分析的正文，请先打开原文处理登录或获取问题。')
  }
  const source: ArticleAnalysisSource = {
    itemId: article.id, revision: article.revision,
    completeness: article.body.status, capturedAt: article.body.fetchedAt,
  }
  assertArticleAnalysisCurrent(source, deps.read)
  const scope = source.completeness === 'partial'
    ? '仅基于已获取的部分正文，不代表完整原文。'
    : '基于下述版本的已保存原文；原文未经过改写或转录校正。'
  const report = await deps.summarize({
    title: article.title, link: article.link, source: article.source, summary: article.summary,
    publishedAt: article.publishedAt === null ? undefined : new Date(article.publishedAt).toISOString(),
    extractedText: article.body.markdown,
    sourceScope: scope,
  })
  assertArticleAnalysisCurrent(source, deps.read)
  await mkdir(input.outputDir, { recursive: true })
  const sourcePath = join(input.outputDir, '网页原文.json')
  const reportPath = join(input.outputDir, analysisReportName('copy'))
  await writeFile(sourcePath, JSON.stringify({ ...source, title: article.title, link: article.link, markdown: article.body.markdown }, null, 2), 'utf8')
  atomicWriteText(reportPath, [
    '# 文案分析报告', '', `- 标题：${article.title}`, `- 原文：${article.link}`,
    `- 来源版本：${source.revision}`, `- 分析范围：${scope}`, '', report.trim(), '',
  ].join('\n'))
  await writeFile(join(input.outputDir, 'manifest.json'), JSON.stringify({
    action: 'copy', itemId: article.id, title: article.title, link: article.link,
    source, sourcePath, reportPath, generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  return { source, sourcePath }
}

export function articleAnalysisWarning(meta: unknown, current: RSSArticle | null): string | null {
  const source = (meta as { articleSource?: ArticleAnalysisSource } | null)?.articleSource
  if (!source?.revision) return '历史网页报告未记录原文版本，请重新分析。'
  if (current?.revision !== source.revision) return '原文已更新或删除，此报告来自旧版本。'
  return source.completeness === 'partial' ? '此报告仅分析已获取的部分正文。' : null
}
