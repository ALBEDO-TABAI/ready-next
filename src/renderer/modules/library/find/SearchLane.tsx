import { useEffect, useState } from 'react'
import type { BookSourcesAPI, BookSource, SourceFormat, SourceHit } from '../../../../shared/library-sources'
import { confirmed } from '../access'
import { Button } from '../../../components/ui'
export function SearchLane({ api, source, title, query, format, category, revision }: { api: BookSourcesAPI; source: BookSource; title: string; query: string; format: SourceFormat; category?: string; revision: number }) {
  const [hits, setHits] = useState<SourceHit[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!revision && !category) return
    setBusy(true); setError(''); setHits([])
    api.search({ source, query, format, category }).then(confirmed).then(hits => { if (live) setHits(hits) })
      .catch(error => { if (live) setError(String(error)) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [api, source, query, format, category, revision])
  const download = async (hit: SourceHit) => {
    setAdding(hit.ref); setError('')
    try { confirmed(await api.download({ source, ref: hit.ref })) } catch (error) { setError(String(error)) }
    finally { setAdding(null) }
  }
  return <section aria-label={title} className="source-lane"><h3>{title}</h3>
    {busy && <p role="status">正在搜索…</p>}{error && <p role="alert">{error}</p>}
    {!busy && revision > 0 && !error && !hits.length && <p>没有找到结果。</p>}
    {hits.map(hit => <article key={hit.ref}><div><strong>{hit.title}</strong><p>{hit.author} · {hit.format.toUpperCase()}</p></div><Button size="sm" disabled={adding !== null} onClick={() => void download(hit)}>{adding === hit.ref ? '加入任务中…' : '下载上架'}</Button></article>)}
  </section>
}
