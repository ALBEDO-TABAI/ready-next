import { Suspense, useEffect, useRef, useState } from 'react'
import type { BookSourcesAPI, SourceSettings } from '../../../../shared/library-sources'
import { confirmed } from '../access'
import { ExtraSourceSearch } from './build-feature'
import { SearchLane } from './SearchLane'
import { sourceFormats } from './source-ui'
export function FindSheet({ api, onClose }: { api: BookSourcesAPI; onClose(): void }) {
  const [query, setQuery] = useState(''), [submitted, setSubmitted] = useState(''), [revision, setRevision] = useState(0)
  const [settings, setSettings] = useState<SourceSettings | null>(null), [extra, setExtra] = useState(false), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    let live = true
    api.settings().then(confirmed).then(data => { if (live) { setSettings(data.settings); setExtra(data.extraSources) } }).catch(error => { if (live) setError(String(error)) })
    return () => { live = false }
  }, [api])
  return <div className="source-find" role="dialog" aria-modal="false" aria-label="找书" onKeyDown={e => {
    e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose() }

  }}>
    <header><h2>找书</h2><button type="button" onClick={onClose}>关闭找书</button></header>
    <form onSubmit={e => { e.preventDefault(); setSubmitted(query.trim()); setRevision(value => value + 1) }}>
      <input ref={input} aria-label="搜索书源" placeholder="书名、作者或网盘链接" value={query} onChange={e => setQuery(e.target.value)} />
      {settings && <select aria-label="搜索格式" value={settings.format} onChange={e => { const format = sourceFormats.find(format => format === e.target.value); if (format) setSettings({ ...settings, format }) }}>{sourceFormats.map(format => <option key={format}>{format}</option>)}</select>}
      <button type="submit" disabled={!settings}>搜索</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {settings && <div className="source-lanes"><SearchLane api={api} source="zlib" title="Z-Library" query={submitted} revision={revision} format={settings.format} />
      {extra && ExtraSourceSearch && <Suspense fallback={<p>正在加载书源…</p>}><ExtraSourceSearch api={api} settings={settings} query={submitted} revision={revision} /></Suspense>}
    </div>}
  </div>
}
