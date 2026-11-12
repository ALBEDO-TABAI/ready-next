import { rssQueryKey } from './workspace-query'
import type { RSSQueryResult } from '../../../shared/rss-workspace'

export interface RSSExportReceipt { path: string; total: number }

// 导出发起时的全部匹配结果（“更多”菜单里的一项）；结果与失败都交给调用方的状态提示。
// Resolves null when the person cancels the save dialog.
export async function exportRSSQuery(view: RSSQueryResult): Promise<RSSExportReceipt | null> {
  try {
    const response = await window.electronAPI.rss.exportQuery({ ...view.query, expectedRevision: view.revision })
    if (!response.success || !response.data) throw new Error(response.error || '导出失败')
    const receipt = response.data
    if (receipt.canceled) return null
    if (receipt.revision !== view.revision || rssQueryKey(receipt.query) !== rssQueryKey(view.query)) throw new Error('导出结果与发起时的范围不一致。')
    return { path: receipt.path, total: receipt.total }
  } catch (cause) {
    throw new Error(cause instanceof Error && cause.message === 'cursor_stale' ? '资料已更新，请重新读取后导出。' : cause instanceof Error ? cause.message : String(cause))
  }
}
