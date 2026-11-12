import { useEffect, useState } from 'react'
import type { ObjectRelations, RelationItem } from '../../../../main/modules/object-relations/contract'
import { RefCapsule } from '../../../components/ui'

const labels: Record<string, string> = { page: '页面', file: '文件', canvas: '画板', event: '日程', day: '日期', web: '网页', 'rss-item': 'RSS 文章', 'rss-digest': 'RSS 摘要', 'book-location': '书', conversation: '会话', fastcard: '卡片', unresolved: '未解析' }
export function RelationsPanel({ objectId }: { objectId: string }) {
  const [result, setResult] = useState<{ id: string; data: ObjectRelations } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true, version = 0
    const read = () => {
      const current = ++version
      void window.electronAPI.objectRelations.query(objectId).then(result => {
        if (!active || current !== version) return
        if (!result.ok) { setError(result.message); return }
        setResult({ id: objectId, data: result.value }); setError('')
      }, error => { if (active && current === version) setError(String(error)) })
    }
    read()
    const off = window.electronAPI.documentPages.onChanged(read)
    return () => { active = false; off() }
  }, [objectId])
  const groups = (items: RelationItem[]) => {
    const grouped = new Map<string, RelationItem[]>()
    for (const item of items) { const key = item.ref ? item.sourceType : 'unresolved'; grouped.set(key, [...(grouped.get(key) || []), item]) }
    return [...grouped].map(([type, rows]) => <section key={type}><h4>{labels[type] || type}</h4><ul>{rows.map(row => <li key={row.id} className="py-1">
      {/* A reference behaves as everywhere (W6 §2.1): click opens, ⌥-click or hover then Space quick-looks. */}
      {row.ref ? <RefCapsule reference={row.ref} title={row.title.replace(/\.(md|canvas)$/i, '')} /> : <span>{row.title}</span>}
      <small className="block">{row.reason || row.relation}</small>
    </li>)}</ul></section>)
  }
  const data = result?.id === objectId ? result.data : null
  return <aside className="rn-object-ui shrink-0 max-h-64 overflow-auto border-t border-[var(--rn-hair-2)] p-3 text-sm" aria-label="关联面板">
    <details><summary>关联{data ? ` · 反链 ${data.backlinkCount}` : ''}</summary>
      {data && <><h3>出链</h3>{groups(data.outgoing)}<h3>反链</h3>{groups(data.incoming)}{data.truncated && <p>关联超过显示上限，列表不完整</p>}</>}
      {error && <p role="alert">{error}</p>}
    </details>
  </aside>
}
