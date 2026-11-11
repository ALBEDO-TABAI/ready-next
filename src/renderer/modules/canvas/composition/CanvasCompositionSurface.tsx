import type { CalendarSnapshot } from '../../../../shared/calendar/commands'
import { EventCard, ScheduleMark } from '../../calendar/linkage/EventCard'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { CanvasComposeInput, CanvasCompositionAPI, DocumentDraftAPI, DocumentDraft } from '../../../../shared/document-drafts'
import type { PageNode } from '../../../../shared/document-pages'
import { CanvasSurface } from '../../../components/canvas/surface/CanvasSurface'
import type { CanvasSurfaceProps } from '../../../components/canvas/surface/types'
import { DocumentCard, LinkCard, TextCard, type CardEditorHost, type DocumentPreviewSource, type LinkPreviewSource } from '../../../components/canvas/cards'
import { CardMarkdown } from '../../../components/canvas/cards/CardMarkdown'
import { SaveToPicker } from '../../document/page-ui/SaveToPicker'

export interface CanvasCompositionSurfaceProps extends Omit<CanvasSurfaceProps, 'renderCard' | 'renderTextEditor' | 'onAddToDocument'> {
  calendarSnapshot?: CalendarSnapshot
  version: string; path: string; tabId: string; trees: PageNode[]
  composition: CanvasCompositionAPI; drafts: DocumentDraftAPI
  documentPreview: DocumentPreviewSource; linkPreview?: LinkPreviewSource
  renderBlockEditor?: (host: CardEditorHost) => ReactNode
  refreshCanvas(): Promise<void>
  openDraft(draftId: string): Promise<void>
}
export function CanvasCompositionSurface(props: CanvasCompositionSurfaceProps) {
  const intent = useRef<CanvasComposeInput | null>(null)
  const generation = useRef(0)
  const [saving, setSaving] = useState<DocumentDraft | null>(null), [error, setError] = useState('')
  useLayoutEffect(() => {
    const current = generation.current
    intent.current = null; setSaving(null); setError('')
    return () => { generation.current = current + 1 }
  }, [props.canvas.ready.id])
  const add = async (nodeIds: string[]) => {
    const current = generation.current
    // Keep the operation after a failed/lost reply. Main owns durable restart recovery.
    if (!intent.current) intent.current = { operationId: crypto.randomUUID(), objectId: props.canvas.ready.id,
      expectedVersion: props.version, nodeIds, tabId: props.tabId, title: '画板草稿' }
    const result = await props.composition.compose(intent.current)
    if (generation.current !== current) return
    if (!result.ok) {
      if (['unconfirmed_selection', 'unsaved_canvas', 'invalid_selection'].includes(result.code)) intent.current = null
      throw new Error(result.message)
    }
    await props.refreshCanvas()
    if (generation.current !== current) return
    await props.openDraft(result.value.draftId)
    if (generation.current === current) intent.current = null
  }
  const showSave = async (draftId: string) => {
    const current = generation.current
    const result = await props.drafts.read(draftId)
    if (generation.current !== current) return
    if (!result.ok) throw new Error(result.message)
    if (!result.value) throw new Error('草稿已不存在')
    setSaving(result.value); setError('')
  }
  const finish = async (draft: DocumentDraft, request: NonNullable<DocumentDraft['finalize']>['request']) => {
    const currentGeneration = generation.current
    const result = await props.drafts.finalize(draft.draftId, draft.revision, request)
    if (generation.current !== currentGeneration) return { ok: false as const, code: 'view_changed', message: '已切换画板，保存结果可在原草稿中恢复' }
    if (result.ok) await props.refreshCanvas()
    else {
      const current = await props.drafts.read(draft.draftId)
      if (generation.current !== currentGeneration) return { ok: false as const, code: 'view_changed', message: '已切换画板，保存结果可在原草稿中恢复' }
      if (current.ok && current.value?.finalize) setSaving(current.value)
      setError(result.message)
    }
    return generation.current === currentGeneration ? result : { ok: false as const, code: 'view_changed', message: '已切换画板，保存结果可在原草稿中恢复' }
  }
  return <>
    <CanvasSurface {...props} onAddToDocument={add}
      renderTextEditor={({ node, commit }) => node.type === 'text' ? <TextCard key={node.id} canvasPath={props.path} node={node} commit={commit} renderEditor={props.renderBlockEditor} /> : null}
      renderCard={node => {
        const mark = <ScheduleMark canvasId={props.canvas.ready.id} nodeId={node.id} snapshot={props.calendarSnapshot} report={e => setError(String(e))} />
        if (node.ready.kind === 'document') return <><DocumentCard node={node} source={props.documentPreview} />{mark}</>
        if (node.type === 'text' && ['text', 'note'].includes(node.ready.kind)) return <><CardMarkdown text={node.text} />{mark}</>
        if (node.ready.ref?.kind === 'event') return <EventCard reference={node.ready.ref} snapshot={props.calendarSnapshot} />
        if (node.type === 'link') return <LinkCard node={node} source={props.linkPreview} open={props.onOpenNode ? () => props.onOpenNode!(node) : undefined} />
        if (node.ready.kind === 'draft' && node.ready.draftId) return <article data-canvas-ui>
          <strong>{node.type === 'text' ? node.text : '草稿'}</strong>
          <button onClick={() => void props.openDraft(node.ready.draftId!).catch(e => setError(String(e)))}>打开草稿</button>
          <button onClick={() => void showSave(node.ready.draftId!).catch(e => setError(String(e)))}>保存到…</button>
        </article>
        return undefined
      }} />
    {error && <p role="alert">{error}</p>}
    {saving && (saving.finalize ? <section aria-label="继续保存" data-canvas-ui>
      <p>{saving.finalize.publishedReceipt ? '文档已保存，画板待完成' : '保存尚未完成'}</p>
      <button onClick={() => void finish(saving, saving.finalize!.request).then(result => { if (result.ok) setSaving(null) }).catch(e => setError(String(e)))}>重试</button>
      <button onClick={() => setSaving(null)}>关闭</button>
    </section> : <SaveToPicker trees={props.trees} initialTitle={saving.title}
      sourceCanvas={{ title: props.canvas.ready.title || '画板', path: props.path }} onCancel={() => setSaving(null)}
      onConfirm={selection => {
        // X/ may not exist yet. Main creates it through the canvas parent identity.
        const { parentPath, parentObjectId, ...rest } = selection
        const request = parentPath === props.path.replace(/\.canvas$/i, '') ? { ...rest, parentObjectId: props.canvas.ready.id }
          : { ...rest, ...(parentObjectId ? { parentObjectId } : { parentPath }) }
        return finish(saving, request)
      }} />)}
  </>
}
