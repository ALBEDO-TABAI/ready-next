import { useEffect, useState } from 'react'
import { RSSReferenceSchema } from '../../../shared/rss-reference'

export default function RSSReferencePreview({ reference }: { reference: unknown }) {
  const [text, setText] = useState('正在读取 RSS 引用…')
  useEffect(() => {
    let live = true
    setText('正在读取 RSS 引用…')
    void (async () => {
      try {
        const parsed = RSSReferenceSchema.parse(reference)
        const api = window.electronAPI.rss
        let preview: string
        if (parsed.kind === 'article') {
          const result = await api.readArticle(parsed.read)
          if (!result.success || !result.data) throw new Error(result.error || '无法读取文章')
          const { article, text, textKind, offset, nextOffset } = result.data
          preview = `${article.title}\n来源：${article.source}\n${textKind === 'source_summary' ? '来源摘要' : '已保存正文'}${offset > 0 || nextOffset !== null ? '（片段预览，Agent 可继续读取）' : ''}\n\n${text}`
        } else {
          const result = await api.queryItems(parsed.query)
          if (!result.success || !result.data) throw new Error(result.error || '无法读取筛选结果')
          preview = `引用范围共 ${result.data.total} 条，以下预览 ${result.data.items.length} 条。\nAgent 可读取后续页面，不会重新抓取。\n\n${result.data.items.map((item) => `${item.title}\n${item.source}`).join('\n\n')}`
        }
        if (live) setText(preview)
      } catch (error) {
        // silent-catch: the preview shows stale, deleted or unreadable reference state.
        const message = error instanceof Error ? error.message : String(error)
        if (live) setText(['article_changed', 'cursor_stale'].includes(message) ? '引用的资料已变化，请返回 RSS 重新引用。' : message === 'article_not_found' ? '引用的文章已删除。' : 'RSS 引用暂时无法读取，请重新引用后再试。')
      }
    })()
    return () => { live = false }
  }, [reference])
  return <pre style={{ padding: '48px 14px 14px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.7 }} role="status">{text}</pre>
}
