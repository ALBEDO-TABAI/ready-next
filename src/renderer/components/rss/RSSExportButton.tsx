import { useState } from 'react'
import { Download } from 'lucide-react'
import { rssQueryKey } from '../../modules/rss/workspace-query'
import type { RSSQueryResult } from '../../../shared/rss-workspace'

export interface RSSExportReceipt { path: string; total: number }

// 导出发起时的全部匹配结果；结果与失败都交给调用方的状态提示，不在原地堆按钮。
export default function RSSExportButton({ view, disabled, className = 'rss-btn', onExported, onError, onCanceled }: {
  view: RSSQueryResult | null; disabled: boolean; className?: string
  onExported(receipt: RSSExportReceipt): void; onError(message: string): void; onCanceled?(): void
}) {
  const [pending, setPending] = useState(false)
  const exportResult = async () => {
    if (!view || pending) return
    setPending(true)
    try {
      const response = await window.electronAPI.rss.exportQuery({ ...view.query, expectedRevision: view.revision })
      if (!response.success || !response.data) throw new Error(response.error || '导出失败')
      const receipt = response.data
      if (receipt.canceled) { onCanceled?.(); return }
      if (receipt.revision !== view.revision || rssQueryKey(receipt.query) !== rssQueryKey(view.query)) throw new Error('导出结果与发起时的范围不一致。')
      onExported({ path: receipt.path, total: receipt.total })
    } catch (cause) {
      // silent-catch: the export failure is shown through the RSS status notice.
      onError(cause instanceof Error && cause.message === 'cursor_stale' ? '资料已更新，请重新读取后导出。' : cause instanceof Error ? cause.message : String(cause))
    } finally { setPending(false) }
  }
  return <button type="button" className={className} disabled={disabled || pending || !view} onClick={() => void exportResult()}
    aria-label="导出当前结果（JSON）" title="导出全部匹配结果及已保存正文，不额外抓取">
    <Download size={15} strokeWidth={1.8} />{pending ? '正在导出' : '导出当前结果'}
  </button>
}
