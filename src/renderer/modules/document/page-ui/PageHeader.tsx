import { useEffect, useId, useRef, useState } from 'react'
import type { DocumentPagesAPI, PageProperties } from '../../../../shared/document-pages'
import { errorMessage, joinPagePath } from './page-state'
import { PageIcon, PageIconOptions } from './PageIcon'

export interface PageHeaderProps {
  objectId: string
  root: string
  title: string
  api?: DocumentPagesAPI
  beforeSave?(): Promise<void>
}

export function PageHeader({ objectId, root, title, beforeSave, api = window.electronAPI.documentPages }: PageHeaderProps) {
  const iconList = useId()
  const [reload, setReload] = useState(0)
  const renameIntent = useRef<{ title: string; objectId: string; id: string } | null>(null)
  const [loaded, setLoaded] = useState<{ properties: PageProperties; version: string } | null>(null)
  const [draft, setDraft] = useState<PageProperties>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const owner = useRef(objectId)
  owner.current = objectId
  useEffect(() => {
    let active = true
    setLoaded(null); setError(null)
    void api.properties(objectId).then(result => {
      if (!active) return
      if (!result.ok) { setError(result.message); return }
      setLoaded(result.value); setDraft({ ...result.value.properties, title: result.value.properties.title ?? title })
    }).catch(failure => { if (active) setError(errorMessage(failure)) })
    return () => { active = false }
  }, [api, objectId, title, reload])

  useEffect(() => api.onChanged(event => {
    if ('objectId' in event && event.objectId === objectId) setReload(value => value + 1)
  }), [api, objectId])

  const save = async () => {
    if (!loaded || lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try {
      await beforeSave?.()
      let version = loaded.version
      if (beforeSave) {
        const current = await api.properties(objectId)
        if (!current.ok) throw new Error(current.message)
        if (JSON.stringify(current.value.properties) !== JSON.stringify(loaded.properties)) throw new Error('页面属性已有变化，请重新读取后再修改。')
        version = current.value.version
      }
      if (draft.title !== (loaded.properties.title ?? title)) {
        const nextTitle = draft.title ?? ''
        if (renameIntent.current?.title !== nextTitle || renameIntent.current.objectId !== objectId) renameIntent.current = { title: nextTitle, objectId, id: crypto.randomUUID() }
        const rename = await api.operate({ type: 'rename', operationId: renameIntent.current.id, root, objectId, title: nextTitle })
        if (!rename.ok) throw new Error(rename.message)
        const current = await api.properties(objectId)
        if (!current.ok) throw new Error(current.message)
        version = current.value.version
      }
      const set: PageProperties = {}
      const remove: (keyof PageProperties)[] = []
      for (const key of ['icon', 'cover'] as const) {
        if (draft[key] !== loaded.properties[key]) {
          if (draft[key]) set[key] = draft[key]
          else remove.push(key)
        }
      }
      const options: NonNullable<PageProperties['ready_page']> = {}
      if (draft.ready_page?.font !== loaded.properties.ready_page?.font) options.font = draft.ready_page?.font
      if (draft.ready_page?.small_text !== loaded.properties.ready_page?.small_text) options.small_text = draft.ready_page?.small_text
      if (draft.ready_page?.full_width !== loaded.properties.ready_page?.full_width) options.full_width = draft.ready_page?.full_width
      if (draft.ready_page?.cover_y !== loaded.properties.ready_page?.cover_y) options.cover_y = draft.ready_page?.cover_y
      if (Object.keys(options).length) set.ready_page = options
      if (Object.keys(set).length || remove.length) {
        const result = await api.patchProperties(objectId, version, set, remove)
        if (!result.ok) throw new Error(result.message)
      }
      const result = await api.properties(objectId)
      if (!result.ok) throw new Error(result.message)
      if (owner.current === objectId) { setLoaded(result.value); setDraft({ ...result.value.properties, title: result.value.properties.title ?? title }) }
    } catch (failure) { if (owner.current === objectId) setError(errorMessage(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const display = (patch: NonNullable<PageProperties['ready_page']>) => setDraft(value => ({ ...value, ready_page: { ...value.ready_page, ...patch } }))
  const cover = draft.cover?.startsWith('https://') ? draft.cover : draft.cover ? `local-file://${joinPagePath(root, draft.cover)}` : undefined
  return <header aria-label="页面头部" className="p-4 space-y-3" style={{ color: 'var(--text-primary)' }}>
    {cover && <img src={cover} alt="页面封面" className="w-full h-40 object-cover rounded" style={{ objectPosition: `center ${(draft.ready_page?.cover_y ?? 0.5) * 100}%` }} />}
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => setReload(value => value + 1)}>重新读取页面属性</button></p>}
    {!loaded ? !error && <p role="status">正在读取页面属性…</p> : <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy} className="space-y-3">
        <div className="flex items-center gap-2"><PageIcon value={draft.icon} /><label>图标<input aria-label="图标" list={iconList} value={draft.icon || ''} onChange={event => setDraft(value => ({ ...value, icon: event.target.value }))} placeholder="Emoji 或 lucide:star" /></label></div>
        <PageIconOptions id={iconList} />
        <label className="block">标题<input aria-label="页面标题" className="block w-full text-2xl bg-transparent" value={draft.title || ''} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} /></label>
        <label className="block">封面<input aria-label="封面" className="w-full" placeholder="资料库内图片路径或 https URL" value={draft.cover || ''} onChange={event => setDraft(value => ({ ...value, cover: event.target.value }))} /></label>
        {draft.cover && <label className="block">封面位置<input aria-label="封面位置" type="range" min="0" max="1" step="0.01" value={draft.ready_page?.cover_y ?? 0.5} onChange={event => display({ cover_y: Number(event.target.value) })} /></label>}
        <label>字体<select aria-label="字体" value={draft.ready_page?.font || 'sans'} onChange={event => {
          const font = event.target.value
          if (font === 'sans' || font === 'serif' || font === 'mono') display({ font })
        }}><option value="sans">无衬线</option><option value="serif">衬线</option><option value="mono">等宽</option></select></label>
        <label><input type="checkbox" checked={draft.ready_page?.small_text ?? false} onChange={event => display({ small_text: event.target.checked })} />小字</label>
        <label><input type="checkbox" checked={draft.ready_page?.full_width ?? false} onChange={event => display({ full_width: event.target.checked })} />全宽</label>
        <button type="submit">{busy ? '正在保存…' : '保存页面属性'}</button>
      </fieldset>
    </form>}
  </header>
}
