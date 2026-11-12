import { writeReadyRefTransfer } from '../../../shared/ready-ref'
import { useEffect, useRef, useState } from 'react'
import { SaveToPicker } from '../../modules/document/page-ui/SaveToPicker'
import type { PageNode, PageResult } from '../../../shared/document-pages'
import type { FastCardCanvasTarget, FastCardTransferRequest } from '../../../shared/fastcard'
import { getFastCardTransferAPI, getFastCardQuickNoteAPI } from '../../stores/useFastCard'
import { FileText, Image as ImageIcon, Languages, Mic, PanelRightClose, Save, Send, Sparkles, TextQuote, Trash2, Video, X } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Field'
import { itemPreview, itemTitle, sourceLabel, timeLabel } from './fastcard-presentation'
import type { FastCardItem, FastCardSyncState } from '../../../shared/fastcard'

interface FastCardPanelProps {
  revealTarget?: { id: string; requestId: string } | null
  items: FastCardItem[]
  syncState?: FastCardSyncState
  onCollapse: () => void
  onClear: () => void
  onSaveCanvas: (itemIds: string[]) => void
  /** The chosen items, or every item when none is chosen. */
  onInsertToChat: (itemIds: string[]) => void
  /** 插入到文档 (W6 §3.2): the card into the current page, as dropping it there does. */
  onInsertToDocument: (id: string) => void
  onRemoveItem: (id: string) => void
}

function itemIcon(kind: FastCardItem['kind']) {
  if (kind === 'image') return <ImageIcon size={14} />
  if (kind === 'video') return <Video size={14} />
  if (kind === 'translation') return <Languages size={14} />
  if (kind === 'image-description') return <Sparkles size={14} />
  if (kind === 'audio') return <Mic size={14} />
  return <FileText size={14} />
}

// The FastCard shelf (W4 §6): the same panel in the browser's overlay window and in the shell's drawer.
export default function FastCardPanel({ revealTarget, items, syncState, onCollapse, onClear, onSaveCanvas, onInsertToChat, onInsertToDocument, onRemoveItem }: FastCardPanelProps) {
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!revealTarget) return
    const card = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-fastcard-id]') ?? []).find(node => node.dataset.fastcardId === revealTarget.id)
    card?.scrollIntoView({ block: 'center' })
    card?.focus({ preventScroll: true })
  }, [revealTarget])
  const [playback, setPlayback] = useState<Record<string, string>>({})
  const [playbackError, setPlaybackError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const chosen = selected.filter(id => items.some(item => item.id === id))
  const target = chosen.length ? chosen : items.map(item => item.id)
  const saving = syncState?.kind === 'saving'
  const toggle = (id: string, on: boolean) => setSelected(current => on ? [...current.filter(item => item !== id), id] : current.filter(item => item !== id))
  return (
    <aside ref={root} className="fc-shelf" aria-label="FastCard">
      <header className="fc-shelf__head">
        <div><h2>暂存</h2><span className="fc-shelf__count">{items.length} 条{chosen.length ? ` · 已选 ${chosen.length} 条` : ''}</span></div>
        <IconButton icon={<PanelRightClose size={16} />} title="收起" onClick={onCollapse} />
      </header>
      {playbackError && <p role="alert" className="fc-shelf__status">{playbackError}</p>}
      {syncState?.kind === 'error' && <p role="alert" className="fc-shelf__status">{syncState.message}</p>}
      {(syncState?.kind === 'loading' || syncState?.kind === 'saving') && (
        <p role="status" className="fc-shelf__status">{syncState.kind === 'loading' ? '正在读取暂存…' : '正在保存…'}</p>
      )}
      <div className="fc-shelf__list">
        {items.length === 0 ? (
          <p className="fc-shelf__empty">还没有暂存的内容。在网页上选中文字或图片收进来，或用快记（⌥⌘Space）随手记一条。</p>
        ) : items.map(item => {
          const title = itemTitle(item), preview = itemPreview(item), checked = chosen.includes(item.id)
          return <article data-fastcard-id={item.id} tabIndex={-1} className="fc-card" data-selected={checked || undefined} key={item.id} draggable
            onDragStart={event => { writeReadyRefTransfer(event.dataTransfer, (checked ? chosen : [item.id]).map(id => ({ kind: 'fastcard', id })), (checked ? items.filter(value => chosen.includes(value.id)) : [item]).map(value => value.title || '收集').join('\n')); event.dataTransfer.effectAllowed = 'move' }}>
            <div className="fc-card__head">
              <input type="checkbox" className="fc-card__check" aria-label={`选择 ${title}`} checked={checked} onChange={event => toggle(item.id, event.target.checked)} />
              <span className="fc-card__kind" aria-hidden>{itemIcon(item.kind)}</span>
              <span className="fc-card__title">{title}</span>
              <IconButton size="sm" icon={<TextQuote size={14} />} title="插入到文档" onClick={() => onInsertToDocument(item.id)} />
              <IconButton size="sm" icon={<X size={14} />} title="移除" onClick={() => onRemoveItem(item.id)} />
            </div>
            {preview && <p className="fc-card__body">{preview}</p>}
            {item.media?.status === 'missing' && <p role="alert" className="fc-card__note">媒体缺失：{item.media.error}</p>}
            {(item.kind === 'image' || item.kind === 'image-description') && !item.media && <p role="status" className="fc-card__note">图片尚未完成离线保存</p>}
            {item.kind === 'audio' && <div className="fc-card__note">
              {playback[item.id] ? <audio controls src={playback[item.id]} /> : <Button size="sm" variant="ghost" onClick={() => {
                void getFastCardQuickNoteAPI().playback(item.id).then(result => {
                  const url = result.data
                  if (!result.success || !url) throw new Error(result.error || '无法读取录音')
                  setPlayback(current => ({ ...current, [item.id]: url }))
                }).catch(error => setPlaybackError(String(error)))
              }}>播放录音</Button>}
              <p>{item.transcription?.status === 'ready' ? item.transcription.text : item.transcription?.status === 'failed' ? `转写失败：${item.transcription.error}` : item.transcription?.status === 'running' ? '正在转写' : '音频已保存，尚未转写'}</p>
            </div>}
            <div className="fc-card__meta">{sourceLabel(item)} · {timeLabel(item.createdAt)}{item.media?.status === 'cached' ? ' · 已离线保存' : ''}</div>
          </article>
        })}
      </div>
      <footer className="fc-shelf__foot">
        <Button size="sm" icon={<Save size={14} />} disabled={!target.length || saving} onClick={() => onSaveCanvas(target)}>保存到画板…</Button>
        <Button size="sm" icon={<Send size={14} />} disabled={!target.length} onClick={() => onInsertToChat(target)}>引入对话</Button>
        {chosen.length
          ? <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => { chosen.forEach(onRemoveItem); setSelected([]) }}>删除</Button>
          : <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={!items.length} onClick={onClear}>清空</Button>}
      </footer>
    </aside>
  )
}

export function FastCardSaveDialog({ onSave, onRetry, onCancel }: {
  onSave(target?: FastCardCanvasTarget): Promise<boolean>
  onRetry(request: FastCardTransferRequest): Promise<boolean>
  onCancel(): void
}) {
  const [targets, setTargets] = useState<Array<{ objectId: string; title: string }>>([])
  const [trees, setTrees] = useState<PageNode[]>([])
  const [pending, setPending] = useState<FastCardTransferRequest[]>([])
  const [targetId, setTargetId] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const api = getFastCardTransferAPI()
      const [available, recovering, vault] = await Promise.all([api.targets(), api.pending(), window.electronAPI.vault.get()])
      if (!available.success || !available.data || !recovering.success) throw new Error(available.error || recovering.error || '无法读取目标画板')
      if (cancelled) return
      setTargets(available.data); setPending(recovering.data || [])
      if (vault.status !== 'ready') throw new Error('请先设置可用的资料库')
      const tree = await window.electronAPI.documentPages.tree({ kind: 'vault', path: vault.root })
      if (!tree.ok) throw new Error(tree.message)
      if (!cancelled) setTrees([tree.value])
    })().catch(failure => { if (!cancelled) setError(String(failure)) })
    return () => { cancelled = true }
  }, [])
  const save = async (target?: FastCardCanvasTarget): Promise<PageResult<unknown>> => {
    setBusy(true)
    try {
      if (!await onSave(target)) return { ok: false, code: 'save_failed', message: '保存未完成，暂存仍保留；请查看错误后重试' }
      onCancel(); return { ok: true, value: undefined }
    } catch (failure) { console.warn('[FastCardPanel] save to canvas failed:', failure instanceof Error ? failure.message : String(failure)); return { ok: false, code: 'save_failed', message: String(failure) } }
    finally { setBusy(false) }
  }
  if (creating) return <SaveToPicker trees={trees} initialTitle="新画板" extension=".canvas" onCancel={() => setCreating(false)} onConfirm={selection => save({ kind: 'new', title: selection.title,
    ...(selection.parentObjectId ? { parentObjectId: selection.parentObjectId } : {}), ...(selection.parentPath ? { parentPath: selection.parentPath } : {}) })} />
  return <section role="dialog" aria-label="保存到画板" className="rn-float flex flex-col gap-3 p-4" style={{ color: 'var(--rn-ink)' }}>
    <h2 className="m-0 text-[15px] font-semibold">保存到画板</h2>
    <Select aria-label="目标画板" value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}
      options={[{ value: '', label: '上次的画板；首次保存到《灵感》' }, ...targets.map(target => ({ value: target.objectId, label: target.title }))]} />
    <Button size="sm" variant="ghost" className="self-start" disabled={busy || !trees.length} onClick={() => setCreating(true)}>新建画板…</Button>
    {error && <p role="alert" className="m-0 text-[12px]" style={{ color: 'var(--rn-bad)' }}>{error}</p>}
    {pending.map(request => <Button key={request.operationId} size="sm" className="self-start" disabled={busy} onClick={() => {
      setBusy(true); void onRetry(request).then(ok => { if (ok) onCancel() }).catch(failure => setError(String(failure))).finally(() => setBusy(false))
    }}>恢复未完成的保存（{request.itemIds.length} 项）</Button>)}
    <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onCancel}>取消</Button><Button variant="primary" disabled={busy} onClick={() => {
      void save(targetId ? { kind: 'existing', objectId: targetId } : undefined).then(result => { if (!result.ok) setError(result.message) })
    }}>{busy ? '正在保存…' : '保存'}</Button></div>
  </section>
}
