import { rssReferencePath } from '../../../shared/rss-reference'
import type { RSSReference } from '../../../shared/rss-reference'
import { useEffect, useState } from 'react'
import { RSSReferenceSchema } from '../../../shared/rss-reference'
import { parseReadyUri } from '../../../shared/ready-ref'
import { RefCapsule } from '../ui'

export default function RSSReferencePreview({ reference, onReveal }: { reference: unknown; onReveal?: () => void }) {
  const [valid, setValid] = useState<{ reference: RSSReference; title: string } | null>(null)
  const [text, setText] = useState('正在读取 RSS 引用…')
  useEffect(() => {
    let live = true
    setValid(null); setText('正在读取 RSS 引用…')
    void (async () => {
      try {
        const parsed = RSSReferenceSchema.parse(reference)
        const api = window.electronAPI.rss
        let preview: string, title = ''
        if (parsed.kind === 'digest') {
          const result = await api.readDigests({ view: 'entries', ...parsed.read })
          if (!result.success || result.data?.view !== 'entries') throw new Error(result.error || '无法读取刊物')
          title = `${result.data.report.kind === 'daily' ? '资讯日报' : '范围简报'} · 第 ${result.data.report.version} 版`
          preview = `${result.data.report.kind === 'daily' ? '资讯日报' : '范围简报'} · 第 ${result.data.report.version} 版，共 ${result.data.total} 项${result.data.report.needsUpdate ? ' · 依据已变化，保留旧刊' : ''}\n\n${result.data.entries.map((entry) => `${entry.source.title}\n原文摘句：${entry.source.quote}`).join('\n\n')}${result.data.nextOffset !== null ? '\n\nAgent 可继续读取后续条目。' : ''}`
        } else if (parsed.kind === 'article' || parsed.kind === 'excerpt') {
          const result = parsed.kind === 'excerpt' ? await api.readExcerpt(parsed.read) : await api.readArticle(parsed.read)
          if (!result.success || !result.data) throw new Error(result.error || '无法读取文章')
          const { article, text, textKind, offset, nextOffset } = result.data
          title = article.title
          preview = `${article.title}\n来源：${article.source}\n${textKind === 'reading_text' ? 'textSource' in result.data && result.data.textSource === 'source_summary' ? '来源摘要中的选区' : result.data.body.status === 'partial' ? '部分正文中的选区' : '已保存正文中的选区' : textKind === 'source_summary' ? '来源摘要' : '已保存正文'}${offset > 0 || nextOffset !== null ? parsed.kind === 'excerpt' ? '（仅在选区内续读）' : '（片段预览，Agent 可继续读取）' : ''}\n\n${text}`
        } else {
          const result = await api.queryItems(parsed.query)
          if (!result.success || !result.data) throw new Error(result.error || '无法读取筛选结果')
          preview = `引用范围共 ${result.data.total} 条，以下预览 ${result.data.items.length} 条。\nAgent 可读取后续页面，不会重新抓取。\n\n${result.data.items.map((item) => `${item.title}\n${item.source}`).join('\n\n')}`
        }
        if (live) { setText(preview); setValid({ reference: parsed, title }) }
      } catch (error) {
        // silent-catch: the preview shows stale, deleted or unreadable reference state.
        const message = error instanceof Error ? error.message : String(error)
        if (live) setText(['article_changed', 'cursor_stale'].includes(message) ? '引用的资料已变化，请返回 RSS 重新引用。' : message === 'article_not_found' ? '引用的文章已删除。' : 'RSS 引用暂时无法读取，请重新引用后再试。')
      }
    })()
    return () => { live = false }
  }, [reference])
  // The source is a reference capsule (W6 §2.1): click opens it in 资讯 (and closes this preview), ⌥-click quick-looks.
  const parsed = valid && valid.reference.kind !== 'query' ? parseReadyUri(rssReferencePath(valid.reference)) : null
  // One column: the source capsule as the header line, the preview text under it. The preview closes after the click,
  // as quick look does: closing in the capture phase would unmount the capsule before its own click opens the source.
  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
    {parsed?.ok && <div style={{ padding: '12px 56px 0 14px' }} onClickCapture={event => { if (!event.altKey) window.setTimeout(() => onReveal?.()) }}><RefCapsule reference={parsed.ref} title={valid?.title || '资讯'} /></div>}
    <pre style={{ padding: parsed?.ok ? '12px 14px 14px' : '48px 14px 14px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.7 }} role="status">{text}</pre>
  </div>
}
