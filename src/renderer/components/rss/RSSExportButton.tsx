import { useState } from 'react'
import { Download } from 'lucide-react'
import { rssQueryKey } from '../../modules/rss/workspace-query'
import type { RSSQueryResult } from '../../../shared/rss-workspace'

export default function RSSExportButton({ view, disabled }: { view: RSSQueryResult | null; disabled: boolean }) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ path: string; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const exportResult = async () => {
    if (!view || pending) return
    setPending(true); setError(null); setResult(null)
    try {
      const response = await window.electronAPI.rss.exportQuery({ ...view.query, expectedRevision: view.revision })
      if (!response.success || !response.data) throw new Error(response.error || '导出失败')
      const receipt = response.data
      if (receipt.canceled) return
      if (receipt.revision !== view.revision || rssQueryKey(receipt.query) !== rssQueryKey(view.query)) throw new Error('导出结果与发起时的范围不一致。')
      setResult(receipt)
    } catch (cause) { setError(cause instanceof Error && cause.message === 'cursor_stale' ? '资料已更新，请重新读取后导出。' : cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <div className="rss-export-control">
    <button type="button" className="rss-reader-button" disabled={disabled || pending || !view} onClick={() => void exportResult()} title="导出全部匹配结果及已保存正文，不额外抓取">
      <Download size={15} />{pending ? '正在导出' : '导出当前结果（JSON）'}
    </button>
    {result && <button type="button" className="rss-reader-button" onClick={() => { void window.electronAPI.document.showInFolder(result.path).then((opened) => { if (!opened.success) setError(opened.error || '无法显示文件') }) }}>已导出发起时的 {result.total} 条结果 · 显示文件</button>}
    {error && <p role="alert" className="rss-reader-notice">{error}</p>}
  </div>
}
