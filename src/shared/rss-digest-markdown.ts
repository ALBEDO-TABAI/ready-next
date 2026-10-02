import { toMarkdown } from 'mdast-util-to-markdown'
import type { Root, RootContent } from 'mdast'
import type { RSSDigestHeader, RSSDigestEntry, RSSDigestSource, RSSDigestCriteria, RSSDigestCoverageSource } from './rss-digests'

/** Published quotations remain literal text, including source strings that resemble executable document blocks. */
export function renderRSSDigest(report: RSSDigestHeader, entries: Array<RSSDigestEntry & { sources: RSSDigestSource[] }>, criteria: RSSDigestCriteria[] = [], coverage: RSSDigestCoverageSource[] = []): string {
  const text = (value: string) => ({ type: 'text' as const, value })
  const paragraph = (value: string): RootContent => ({ type: 'paragraph', children: [text(value)] })
  const children: RootContent[] = [
    { type: 'heading', depth: 1, children: [text(`${report.kind === 'daily' ? '资讯日报' : '范围简报'} · 第 ${report.version} 版`)] },
    paragraph(`${report.kind === 'daily' ? `覆盖时间：${new Date(report.from).toISOString()} 至 ${new Date(report.until).toISOString()}（截止时刻不包含在内）；` : ''}范围：${report.scopeLabel}；时区：${report.timezone}；生成：${new Date(report.createdAt).toISOString()}`),
    paragraph(`共 ${report.total} 项，${report.referenceCount} 条报道依据。尚未获得明确精选判断 ${report.coverage.unresolvedArticles} 篇，其中存在失败或未知任务 ${report.coverage.failedArticles} 篇；等待中的文章 ${report.coverage.pendingArticles} 篇。`),
    paragraph('内容由已保存的来源摘句与精选理由组成，没有再次生成事实综述。'),
  ]
  children.push({ type: 'heading', depth: 2, children: [text('本刊采用的标准与订阅覆盖')] })
  for (const rule of criteria) children.push(paragraph(`${rule.name} · 标准第 ${rule.ruleRevision} 版：${rule.description}`))
  for (const source of coverage) children.push(paragraph(`${source.name} · ${source.enabled ? '启用' : '停用'} · ${source.fetch ? `${source.fetch.attemptedAt} ${source.fetch.success ? '采集成功' : '采集失败'} ${source.fetch.error || ''} ${source.fetch.warning || ''}` : '缺少最近采集结果'}`))
  if (report.needsUpdate) children.push(paragraph('来源、标准或归属已变化；以下保留发布时的内容，需要更新。'))
  if (!entries.length) children.push(paragraph('本期暂无已入选的可用内容，不代表没有新闻。'))
  let section = ''
  for (const entry of entries) {
    if (section !== entry.section) { section = entry.section; children.push({ type: 'heading', depth: 2, children: [text(section)] }) }
    children.push({ type: 'heading', depth: 3, children: [text(entry.source.title)] })
    const topics = [...new Set(entry.sources.flatMap((s) => s.topics.map((t) => t.name)))]
    if (topics.length) children.push(paragraph(`分类：${topics.join('、')}`))
    for (const source of entry.sources) {
      children.push(paragraph(`${source.source} · ${source.quoteKind === 'source_summary' ? '来源摘要' : source.quoteKind === 'title' ? '仅标题' : '原文摘句'}${source.quoteTruncated ? '（节选）' : ''}${source.carriedOver ? ' · 补收入选后尚未刊出的内容' : ''}`))
      children.push({ type: 'blockquote', children: [paragraph(source.quote) as Extract<RootContent, { type: 'paragraph' }>] })
      if (source.curation) children.push(paragraph(`${source.curation.origin === 'manual' ? '手工精选' : '模型精选理由'}：${source.curation.reason}`))
      children.push(paragraph(`文章 ${source.itemId}；版本 ${source.articleRevision}`))
      if (/^https?:\/\//i.test(source.link)) children.push({ type: 'paragraph', children: [{ type: 'link', url: source.link, children: [text('打开原文')] }] })
    }
  }
  return toMarkdown({ type: 'root', children } as Root)
}
