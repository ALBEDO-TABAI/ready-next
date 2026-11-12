import { useEffect, useState } from 'react'
import type { BookSourcesAPI, SourceSettings } from '../../../../shared/library-sources'
import { confirmed } from '../access'
import { SearchLane } from './SearchLane'
import { Button, Select } from '../../../components/ui'
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
    {settings.treasure && <><label className="source-category">分类<Select aria-label="分类" value={category} options={[{ value: '', label: '全部' }, ...categories.map(cat => ({ value: cat, label: cat }))]} onChange={e => setCategory(e.target.value)} /></label><SearchLane api={api} source="treasure" title="电子书宝库" query={query} revision={revision} format="epub" category={category} /></>}
    {settings.ctfile && <section><p>在搜索框粘贴城通网盘链接，再搜索并取回。</p><Button size="sm" disabled={!query.trim()} onClick={() => void direct()}>取回网盘 EPUB</Button></section>}
    {error && <p role="alert">{error}</p>}
  </div>
}
