import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DocumentPagesAPI, PageProperties } from '../../../../shared/document-pages'
import { errorMessage, joinPagePath } from './page-state'
import { Icon } from '../ink/icons'
import { InkPageIcon, PAGE_ICON_CHOICES } from '../ink/InkPageIcon'
import { closePopover, openPopover } from '../ink/overlay'
import { useInkLayout } from '../ink/layout-state'

export interface PageHeaderProps {
  objectId: string
  root: string
  title: string
  api?: DocumentPagesAPI
  beforeSave?(): Promise<void>
}

/** Inkwell's page header: icon, cover and title above the page body. Every change goes through the versioned page API. */
export function PageHeader({ objectId, root, title, beforeSave, api = window.electronAPI.documentPages }: PageHeaderProps) {
  const [reload, setReload] = useState(0)
  const renameIntent = useRef<{ title: string; objectId: string; id: string } | null>(null)
  const [properties, setProperties] = useState<PageProperties | null>(null)
  const [titleDraft, setTitleDraft] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reposition, setReposition] = useState<number | null>(null)
  const lock = useRef(false)
  const owner = useRef(objectId)
  owner.current = objectId
  const titleRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let active = true
    setError(null)
    void api.properties(objectId).then(result => {
      if (!active) return
      if (!result.ok) { setError(result.message); return }
      setProperties(result.value.properties); setTitleDraft(result.value.properties.title ?? title)
    }).catch(failure => { if (active) setError(errorMessage(failure)) })
    return () => { active = false }
  }, [api, objectId, title, reload])
  useEffect(() => api.onChanged(event => {
    if ('objectId' in event && event.objectId === objectId) setReload(value => value + 1)
  }), [api, objectId])
  useLayoutEffect(() => {
    const element = titleRef.current
    if (!element) return
    element.style.height = '0px'; element.style.height = `${element.scrollHeight}px`
  }, [titleDraft, properties])
  // A page just created from the sidebar opens with its "未命名" title selected, ready to be typed over.
  useEffect(() => {
    if (!properties || useInkLayout.getState().titleFocus !== objectId) return
    useInkLayout.getState().setTitleFocus(null)
    titleRef.current?.focus(); titleRef.current?.select()
  }, [properties, objectId])

  const run = async (work: () => Promise<void>) => {
    if (lock.current) return false
    lock.current = true; setBusy(true); setError(null)
    try { await work(); return true } catch (failure) { if (owner.current === objectId) setError(errorMessage(failure)); return false }
    finally { lock.current = false; setBusy(false) }
  }
  const refresh = async () => {
    const result = await api.properties(objectId)
    if (!result.ok) throw new Error(result.message)
    if (owner.current === objectId) { setProperties(result.value.properties); setTitleDraft(result.value.properties.title ?? title) }
  }
  const patch = (set: PageProperties, remove: (keyof PageProperties)[] = []) => run(async () => {
    await beforeSave?.()
    const current = await api.properties(objectId)
    if (!current.ok) throw new Error(current.message)
    const result = await api.patchProperties(objectId, current.value.version, set, remove)
    if (!result.ok) throw new Error(result.message)
    await refresh()
  })
  const rename = () => {
    const next = titleDraft.trim()
    const currentTitle = properties?.title ?? title
    if (!properties || !next || next === currentTitle) { if (!next) setTitleDraft(currentTitle); return }
    void run(async () => {
      await beforeSave?.()
      if (renameIntent.current?.title !== next || renameIntent.current.objectId !== objectId) renameIntent.current = { title: next, objectId, id: crypto.randomUUID() }
      const result = await api.operate({ type: 'rename', operationId: renameIntent.current.id, root, objectId, title: next })
      if (!result.ok) throw new Error(result.message)
      await refresh()
    })
  }
  const pickIcon = (anchor: DOMRect, current?: string) => openPopover({ id: 'ink-icon-picker', anchor, placement: 'bottom-start', offset: 6, label: '选择图标',
    render: close => <IconPicker value={current} onPick={value => { close(); void (value ? patch({ icon: value }) : patch({}, ['icon'])) }} /> })
  const pickCover = (anchor: DOMRect) => openPopover({ id: 'ink-cover-picker', anchor, placement: 'bottom-end', offset: 6, label: '更换封面',
    render: close => <CoverPicker value={properties?.cover} onPick={value => { close(); void (value ? patch({ cover: value }) : patch({}, ['cover'])) }} /> })
  const dragCover = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (reposition === null) return
    event.preventDefault()
    const frame = event.currentTarget.getBoundingClientRect(), startY = event.clientY, start = reposition
    const move = (next: PointerEvent) => setReposition(Math.max(0, Math.min(1, start - (next.clientY - startY) / Math.max(1, frame.height))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const icon = properties?.icon
  const cover = properties?.cover
  const coverUrl = cover?.startsWith('https://') ? cover : cover ? `local-file://${joinPagePath(root, cover)}` : undefined
  const coverY = reposition ?? properties?.ready_page?.cover_y ?? 0.5
  return <header aria-label="页面头部" className={`ink-page-header${icon ? ' has-icon' : ''}${coverUrl ? ' has-cover' : ''}`}>
    {coverUrl ? <div className={`ink-cover${reposition !== null ? ' is-repos' : ''}`} onPointerDown={dragCover}>
      <img src={coverUrl} alt="页面封面" draggable={false} style={{ objectPosition: `center ${coverY * 100}%` }} />
      {reposition !== null && <div className="ink-cover-hint">拖动图片调整位置</div>}
      <div className="ink-cover-actions">
        {reposition === null ? <>
          <button type="button" disabled={busy} onClick={event => pickCover(event.currentTarget.getBoundingClientRect())}>更换封面</button>
          <button type="button" disabled={busy} onClick={() => setReposition(properties?.ready_page?.cover_y ?? 0.5)}>调整位置</button>
        </> : <>
          <button type="button" disabled={busy} onClick={() => { const value = reposition; setReposition(null); void patch({ ready_page: { cover_y: Math.round(value * 100) / 100 } }) }}>保存位置</button>
          <button type="button" onClick={() => setReposition(null)}>取消</button>
        </>}
      </div>
    </div> : <div className="ink-page-top-pad" />}
    <div className="ink-page-header-inner">
      {icon && <button type="button" className="ink-page-icon" aria-label="更换图标" disabled={busy}
        onClick={event => pickIcon(event.currentTarget.getBoundingClientRect(), icon)}>
        <InkPageIcon value={icon} size={78} emojiSize={70} />
      </button>}
      <div className="ink-page-controls">
        {!icon && <button type="button" className="ink-page-ctl" disabled={busy || !properties} onClick={event => pickIcon(event.currentTarget.getBoundingClientRect())}>
          <Icon name="smile" size={16} stroke={1.6} />添加图标</button>}
        {!coverUrl && <button type="button" className="ink-page-ctl" disabled={busy || !properties} onClick={event => pickCover(event.currentTarget.getBoundingClientRect())}>
          <Icon name="image" size={16} stroke={1.6} />添加封面</button>}
      </div>
      <div className="ink-page-title">
        <textarea ref={titleRef} className="ink-title-editable ready-input-slot-inner" aria-label="页面标题" rows={1} placeholder="无标题" spellCheck={false}
          value={titleDraft} disabled={busy || !properties}
          onChange={event => setTitleDraft(event.target.value.replace(/[\r\n]+/g, ' '))}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { setTitleDraft(properties?.title ?? title); event.currentTarget.blur() }
          }}
          onBlur={rename} />
      </div>
      {error && <p role="alert" className="ink-page-error">{error}<button type="button" className="ink-btn" disabled={busy} onClick={() => setReload(value => value + 1)}>重新读取页面属性</button></p>}
      {!properties && !error && <p role="status" className="ink-page-error" style={{ color: 'var(--ink-text-tertiary)' }}>正在读取页面属性…</p>}
    </div>
  </header>
}

function IconPicker({ value, onPick }: { value?: string; onPick(value: string | null): void }) {
  const [custom, setCustom] = useState('')
  return <div className="ink-menu ink-panel" style={{ width: 300 }}>
    <div className="ink-panel-row" style={{ justifyContent: 'space-between' }}>
      <span className="ink-panel-title">图标</span>
      {value && <button type="button" className="ink-btn" onClick={() => onPick(null)}>移除</button>}
    </div>
    <div className="ink-icon-grid" role="listbox" aria-label="图标">
      {PAGE_ICON_CHOICES.map(choice => <button key={choice} type="button" role="option" aria-selected={choice === value} aria-label={choice} className="ink-icon-cell" onClick={() => onPick(choice)}>
        <InkPageIcon value={choice} size={22} emojiSize={21} />
      </button>)}
    </div>
    <form className="ink-panel-row" onSubmit={event => { event.preventDefault(); if (custom.trim()) onPick(custom.trim()) }}>
      <input className="ink-input" aria-label="自定义图标" placeholder="其他 Emoji，或 lucide:名称" value={custom} onChange={event => setCustom(event.target.value)} />
      <button type="submit" className="ink-btn" disabled={!custom.trim()}>使用</button>
    </form>
  </div>
}

function CoverPicker({ value, onPick }: { value?: string; onPick(value: string | null): void }) {
  const [draft, setDraft] = useState(value ?? '')
  return <form className="ink-menu ink-panel" style={{ width: 340 }} onSubmit={event => { event.preventDefault(); if (draft.trim()) onPick(draft.trim()) }}>
    <span className="ink-panel-title">封面</span>
    <input className="ink-input" data-autofocus aria-label="封面" placeholder="资料库内的图片路径，或 https 链接" value={draft} onChange={event => setDraft(event.target.value)} />
    <div className="ink-panel-actions">
      {value && <button type="button" className="ink-btn is-danger" onClick={() => onPick(null)}>移除封面</button>}
      <button type="button" className="ink-btn" onClick={() => closePopover('ink-cover-picker')}>取消</button>
      <button type="submit" className="ink-btn ink-btn-primary" disabled={!draft.trim()}>使用</button>
    </div>
  </form>
}
