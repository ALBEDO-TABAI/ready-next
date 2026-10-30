import { useEffect, useState } from 'react'
import type { BookSourcesAPI, SourceSettings } from '../../../../shared/library-sources'
import { confirmed } from '../access'
import { SearchLane } from './SearchLane'
export default function ExtraSourceSearch({ api, settings, query, revision }: { api: BookSourcesAPI; settings: SourceSettings; query: string; revision: number }) {
  const [categories, setCategories] = useState<string[]>([]), [category, setCategory] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let live = true
    if (settings.treasure) api.categories().then(confirmed).then(items => { if (live) setCategories(items) }).catch(error => { if (live) setError(String(error)) })
    return () => { live = false }
  }, [api, settings.treasure])
  const direct = async () => {
    try { confirmed(await api.download({ source: 'ctfile', ref: query })); setError('') } catch (error) { setError(String(error)) }
  }
  return <div className="source-extra">
    {settings.treasure && <><label>分类<select value={category} onChange={e => setCategory(e.target.value)}><option value="">全部</option>{categories.map(cat => <option key={cat}>{cat}</option>)}</select></label><SearchLane api={api} source="treasure" title="电子书宝库" query={query} revision={revision} format="epub" category={category} /></>}
    {settings.ctfile && <section><p>在搜索框粘贴城通网盘链接，再搜索并取回。</p><button type="button" disabled={!query.trim()} onClick={() => void direct()}>取回网盘 EPUB</button></section>}
    {error && <p role="alert">{error}</p>}
  </div>
}
