import { useEffect, useState } from 'react'
import { SaveToPicker } from '../../modules/document/page-ui/SaveToPicker'
import type { PageNode, PageResult } from '../../../shared/document-pages'
import type { FastCardCanvasTarget, FastCardTransferRequest } from '../../../shared/fastcard'
import { getFastCardTransferAPI, getFastCardQuickNoteAPI } from '../../stores/useFastCard'
import { FileText, Image as ImageIcon, Languages, PanelRightClose, Save, Send, Sparkles, Trash2, Video, X } from 'lucide-react'
import type { FastCardItem, FastCardSyncState } from '../../../shared/fastcard'
import { LiquidSurfaceLayer } from '../ui/liquid-glass/LiquidFloatingPanel'

interface FastCardPanelProps {
  items: FastCardItem[]
  syncState?: FastCardSyncState
  onCollapse: () => void
  onClear: () => void
  onSaveCanvas: (itemIds: string[]) => void
  onInsertToChat: () => void
  onRemoveItem: (id: string) => void
}

function itemIcon(kind: FastCardItem['kind']) {
  if (kind === 'image') return <ImageIcon size={14} />
  if (kind === 'video') return <Video size={14} />
  if (kind === 'translation') return <Languages size={14} />
  if (kind === 'image-description') return <Sparkles size={14} />
  return <FileText size={14} />
}

function itemTitle(item: FastCardItem): string {
  if (item.title) return item.title
  if (item.kind === 'audio') return '录音'
  if (item.kind === 'translation') return '翻译'
  if (item.kind === 'image-description') return '图片反推描述'
  if (item.kind === 'image') return item.alt || item.caption || '图片'
  if (item.kind === 'video') return item.video?.title || '视频'
  return '文字'
}

function itemPreview(item: FastCardItem): string {
  if (item.kind === 'translation') return item.translatedText || item.originalText || ''
  if (item.kind === 'image-description') return item.description || ''
  if (item.kind === 'video') return item.video?.playableUrl || item.video?.originalUrl || item.source?.pageUrl || ''
  if (item.kind === 'image') return item.caption || item.alt || item.imageUrl || ''
  return item.text || ''
}

export default function FastCardPanel({
  items,
  syncState,
  onCollapse,
  onClear,
  onSaveCanvas,
  onInsertToChat,
  onRemoveItem,
}: FastCardPanelProps) {
  const [playback, setPlayback] = useState<Record<string, string>>({})
  const [playbackError, setPlaybackError] = useState('')
  const [selected, setSelected] = useState<string[] | null>(null)
  const itemIds = items.filter(item => selected === null || selected.includes(item.id)).map(item => item.id)
  return (
    <aside className="browser-fastcard-drawer browser-fastcard-surface content-surface-panel ready-app-liquid-panel is-entered" aria-label="FastCard">
      <LiquidSurfaceLayer
        className="ready-liquid-popover__lens ready-app-liquid-panel__lens"
        radius={18}
        withProjection={false}
        blur={8}
        frost={0}
        saturation={1.16}
        brightness={1.06}
        contrast={0.82}
      />
      <header className="browser-fastcard-header">
        <div>
          <div className="browser-fastcard-kicker">FastCard</div>
          <h2>{items.length} 条暂存</h2>
        </div>
        <button className="browser-fastcard-icon-button" type="button" aria-label="收起" title="收起" onClick={onCollapse}>
          <PanelRightClose size={16} />
        </button>
      </header>

      {playbackError && <p role="alert">{playbackError}</p>}
      {syncState?.kind === 'error' && <p role="alert">{syncState.message}</p>}
      {(syncState?.kind === 'loading' || syncState?.kind === 'saving') && (
        <p role="status">{syncState.kind === 'loading' ? '正在读取暂存…' : '正在保存…'}</p>
      )}
      <div className="browser-fastcard-list">
        {items.length === 0 ? (
          <div className="browser-fastcard-empty">暂无内容</div>
        ) : (
          items.map((item) => (
            <article className="browser-fastcard-item" key={item.id} draggable
              onDragStart={event => { event.dataTransfer.setData('application/x-ready-fastcard', JSON.stringify({ itemIds: [item.id], operationId: crypto.randomUUID() })); event.dataTransfer.effectAllowed = 'move' }}>
              <label><input type="checkbox" aria-label={`选择 ${itemTitle(item)}`} checked={itemIds.includes(item.id)}
                onChange={event => setSelected(event.target.checked ? [...itemIds, item.id] : itemIds.filter(id => id !== item.id))} />选择</label>
              <div className="browser-fastcard-item-head">
                <span className="browser-fastcard-item-kind">{itemIcon(item.kind)}</span>
                <div className="browser-fastcard-item-title">{itemTitle(item)}</div>
                <button
                  className="browser-fastcard-icon-button"
                  type="button"
                  aria-label="移除"
                  title="移除"
                  onClick={() => onRemoveItem(item.id)}
                >
                  <X size={14} />
                </button>
              </div>
              <p>{itemPreview(item)}</p>
              {item.media?.status === 'missing' && <p role="alert">媒体缺失：{item.media.error}</p>}
              {(item.kind === 'image' || item.kind === 'image-description') && !item.media && <p role="status">图片尚未完成离线保存</p>}
              {item.media?.status === 'cached' && <span>已离线保存</span>}
              {item.kind === 'audio' && <div>
                {playback[item.id] ? <audio controls src={playback[item.id]} /> : <button onClick={() => {
                  void getFastCardQuickNoteAPI().playback(item.id).then(result => {
                    const url = result.data
                    if (!result.success || !url) throw new Error(result.error || '无法读取录音')
                    setPlayback(current => ({ ...current, [item.id]: url }))
                  }).catch(error => setPlaybackError(String(error)))
                }}>播放录音</button>}
              </div>}
              {item.kind === 'audio' && <p>{item.transcription?.status === 'ready' ? item.transcription.text : item.transcription?.status === 'failed' ? `转写失败：${item.transcription.error}` : item.transcription?.status === 'running' ? '正在转写' : '音频已保存，尚未转写'}</p>}
              {item.source?.domain && <span className="browser-fastcard-source">{item.source.domain}</span>}
            </article>
          ))
        )}
      </div>

      <footer className="browser-fastcard-footer">
        <button className="browser-fastcard-action" type="button" onClick={() => onSaveCanvas(itemIds)} disabled={itemIds.length === 0 || syncState?.kind === 'saving'}>
          <Save size={14} />
          <span>保存到画板</span>
        </button>
        <button className="browser-fastcard-action" type="button" onClick={onInsertToChat} disabled={items.length === 0}>
          <Send size={14} />
          <span>引入到对话框</span>
        </button>
        <button className="browser-fastcard-action subtle" type="button" onClick={onClear} disabled={items.length === 0}>
          <Trash2 size={14} />
          <span>清空</span>
        </button>
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
  return <section role="dialog" aria-label="保存到画板" className="p-4 rounded space-y-3" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
    <h2>保存到画板</h2>
    <select aria-label="目标画板" value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}>
      <option value="">上次的画板；首次保存到《灵感》</option>
      {targets.map(target => <option key={target.objectId} value={target.objectId}>{target.title}</option>)}
    </select>
    <button disabled={busy || !trees.length} onClick={() => setCreating(true)}>新建画板…</button>
    {error && <p role="alert">{error}</p>}
    {pending.map(request => <button key={request.operationId} disabled={busy} onClick={() => {
      setBusy(true); void onRetry(request).then(ok => { if (ok) onCancel() }).catch(failure => setError(String(failure))).finally(() => setBusy(false))
    }}>恢复未完成的保存（{request.itemIds.length} 项）</button>)}
    <div><button disabled={busy} onClick={onCancel}>取消</button><button disabled={busy} onClick={() => {
      void save(targetId ? { kind: 'existing', objectId: targetId } : undefined).then(result => { if (!result.ok) setError(result.message) })
    }}>{busy ? '正在保存…' : '保存'}</button></div>
  </section>
}
