import type { CalendarSnapshot } from '../../../shared/calendar/commands'
import type { CanvasNode } from '../../../shared/ready-canvas'
import { ScheduleCardDialog } from '../../modules/calendar/linkage/ScheduleCardDialog'
import { flushCanvasWrites, trackCanvasWrite } from '../../modules/canvas/pending-writes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasOpen } from '../../../main/modules/board-engine/canvas-service'
import { graphicSvg, sha256, type CanvasOperation } from '../../../shared/ready-canvas'
import type { PageNode } from '../../../shared/document-pages'
import { isReadyBoardFile } from '../../../shared/ready-board'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import { CanvasCompositionSurface } from '../../modules/canvas/composition/CanvasCompositionSurface'
import { canvasDocumentPreview } from '../../modules/canvas/composition/document-preview'
import { useCanvasNavigation } from '../../modules/canvas/navigation'
import { openReadyRef } from '../../modules/workbench/open-ready-ref'
import { drafts } from '../../modules/document/drafts/runtime'
import { toLocalFileUrl } from '../../utils/dragDrop'
import './surface/surface.css'
import { addBoardSelectionToAgentInput } from '../../modules/agent/chat-input-bridge'
import { BoardNewItems } from './BoardNewItems'
import { boardAncestors } from './board-ancestors'
import { READY_REF_MIME } from '../../modules/calendar/linkage/transfer'
import { ReadyRefSchema } from '../../../shared/ready-ref'
import { openInCurrentTab } from '../../modules/document/ink/layout-state'
import { boardMarkdown } from '../../modules/canvas/export'
import { captureDocumentPreviewHtml } from '../document/document-export-capture'
import { showToast } from '../ui'

function confirmed<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
export default function CanvasDocument({ tab }: { tab: DocTab }) {
  const [opened, setOpened] = useState<CanvasOpen | null>(null), current = useRef<CanvasOpen | null>(null)
  const [root, setRoot] = useState(''), [trees, setTrees] = useState<PageNode[]>([]), [error, setError] = useState('')
  const pending = useRef(false), generation = useRef(0), importId = useRef(crypto.randomUUID())
  const target = useCanvasNavigation(state => state.target)
  const [calendarSnapshot, setCalendarSnapshot] = useState<CalendarSnapshot>(), [scheduling, setScheduling] = useState<CanvasNode | null>(null)
  const api = window.electronAPI
  const refreshCalendar = useCallback(async () => {
    const result = await api.calendar.snapshot()
    if (!result.success || !result.data) throw new Error(result.error || '无法读取日程')
    setCalendarSnapshot(result.data)
  }, [api])
  useEffect(() => {
    let disposed = false, ticket = 0
    const reload = async () => { const current = ++ticket; try { const result = await api.calendar.snapshot(); if (!result.success || !result.data) throw new Error(result.error || '无法读取日程'); if (!disposed && current === ticket) setCalendarSnapshot(result.data) } catch (cause) { if (!disposed && current === ticket) setError(String(cause)) } }
    const off = api.calendar.onChanged(() => { void reload() }); void reload()
    return () => { disposed = true; off() }
  }, [api])
  const refresh = useCallback(async () => {
    const before = current.current, epoch = generation.current
    if (!before) return
    const next = confirmed(await api.canvas.read(before.handleId))
    if (epoch === generation.current) { current.current = next; setOpened(next) }
  }, [api])
  useEffect(() => {
    const epoch = ++generation.current
    let handle: string | undefined
    current.current = null; setOpened(null); setScheduling(null); setError('')
    const load = async () => {
      const state = await api.vault.get()
      if (state.status !== 'ready') throw new Error('请先配置资料库')
      if (epoch !== generation.current) return
      setRoot(state.root)
      const tree = await api.documentPages.tree({ path: state.root, kind: 'vault' })
      if (!tree.ok) throw new Error(tree.message)
      if (epoch !== generation.current) return
      setTrees([tree.value])
      if (isReadyBoardFile(tab.path)) return
      if (!tab.objectId) throw new Error('画板身份尚未确认')
      const value = confirmed(await api.canvas.open(tab.objectId)); handle = value.handleId
      if (epoch !== generation.current) { confirmed(await api.canvas.release(handle)); handle = undefined; return }
      current.current = value; setOpened(value)
    }
    void load().catch(cause => { if (epoch === generation.current) setError(String(cause)) })
    const stop = api.canvas.onChanged(() => { if (!pending.current) void refresh().catch(cause => setError(String(cause))) })
    const stopVault = api.vault.onChanged(() => { generation.current++; current.current = null; setOpened(null); setError('资料库已切换，请重新打开当前画板') })
    return () => { generation.current = epoch + 1; stop(); stopVault(); if (handle) void flushCanvasWrites().then(() => api.canvas.release(handle!)).catch(cause => console.error('[canvas] release', cause)) }
  }, [api, tab.objectId, tab.path, refresh])
  const write = (operations: CanvasOperation[]) => trackCanvasWrite((async () => {
    const before = current.current
    if (!before || pending.current) throw new Error('画板正在处理另一项修改')
    pending.current = true
    try {
      const result = confirmed(await api.canvas.write({ objectId: before.objectId, handleId: before.handleId,
        expectedVersion: before.version, operationId: crypto.randomUUID(), commands: operations }))
      if (result.state !== 'completed') throw new Error(result.state === 'conflict' ? result.conflict.message : result.state === 'recovery-required' ? result.message : '画板修改尚未保存')
      await refresh()
    } finally { pending.current = false }
  })())
  const run = (work: () => Promise<void>) => { setError(''); void work().catch(cause => setError(String(cause))) }
  const openDraft = async (id: string) => {
    const result = await api.documentDrafts.read(id)
    if (!result.ok) throw new Error(result.message)
    if (!result.value) throw new Error('草稿不存在')
    const state = useDocTabs.getState(), tabId = state.tabs.find(item => item.draftId === id)?.id ?? state.createBackgroundTab({ title: result.value.title })
    await drafts.attach(tabId, result.value)
    state.setActiveTab(tabId)
  }
  const previews = useMemo(() => opened ? canvasDocumentPreview(api.canvasComposition, opened.objectId) : null, [api, opened?.objectId]) // eslint-disable-line react-hooks/exhaustive-deps
  const links = useMemo(() => ({ read: async (url: string) => { const result = await api.linkPreview.get(url); if (!result.success || !result.data) throw new Error(result.error || '预览失败'); return result.data } }), [api])
  const pages = trees.flatMap(function flatten(node): PageNode[] { return [node, ...node.children.flatMap(flatten)] }).filter(node => node.kind === 'page')
  if (isReadyBoardFile(tab.path)) return <section className="p-4" aria-label="旧画板转换">
    <p>这是旧画板。转换为新画板后继续编辑，原文件保持不变。</p>
    <button disabled={!root} onClick={() => run(async () => {
      const sourcePath = tab.path!
      if (!sourcePath.startsWith(root + '/')) throw new Error('请先将导入源放入当前资料库')
      const result = confirmed(await api.canvas.import({ operationId: importId.current, kind: 'readyboard', sourcePath,
        targetPath: sourcePath.slice(root.length + 1).replace(/\.readyboard$/i, '.canvas') }))
      if (result.status !== 'complete') throw new Error(`转换缺少素材：${result.incomplete.map(item => item.reason).join('；')}`)
      await openReadyRef({ kind: 'canvas', id: result.objectId }, 'document')
    })}>转换为 .canvas</button>{error && <p role="alert">{error}</p>}
  </section>
  if (!opened || !previews) return <p role={error ? 'alert' : 'status'}>{error || '正在打开画板…'}</p>
  const add = (node: Parameters<typeof write>[0][number]) => run(() => write([node]))
  const frame = (at: { x: number; y: number }, height = 120) => ({ id: crypto.randomUUID(), x: Math.round(at.x - 130), y: Math.round(at.y - 40), width: 260, height })
  // Dropped onto the stage: FastCard items (through Main's transfer) and pages from the sidebar (a document card).
  const dropData = (data: DataTransfer, at: { x: number; y: number }) => {
    const fastCard = data.getData('application/x-ready-fastcard')
    if (fastCard) {
      const { itemIds, operationId } = JSON.parse(fastCard) as { itemIds: string[]; operationId: string }
      run(async () => {
        const result = await api.fastCard.transfer({ operationId, itemIds, target: { kind: 'existing', objectId: opened.objectId }, position: at })
        if (!result.success) throw new Error(result.error || 'FastCard 没有放到画板上')
        await refresh()
      })
      return true
    }
    const raw = data.getData(READY_REF_MIME)
    const ref = raw ? ReadyRefSchema.safeParse(JSON.parse(raw)) : null
    const pageRef = ref?.success && ref.data.kind === 'page' ? ref.data : null
    if (pageRef) {
      const page = pages.find(item => item.objectId === pageRef.id)
      if (!page) { setError('这一页不在当前资料库里'); return true }
      add({ type: 'addNode', node: { ...frame(at, 180), type: 'file', file: page.path.slice(root.length + 1), ready: { kind: 'document', ref: { kind: 'page', id: page.objectId } } } })
      return true
    }
    return false
  }
  const ancestors = boardAncestors(trees, root, opened.path)
  // 导出 (W4 §2.2): the chosen cards or the whole board as Markdown (with its assets) or PDF, through the document export.
  const exportBoard = async (kind: 'md' | 'pdf', ids: string[]) => {
    const title = opened.canvas.ready.title || opened.path.split('/').pop()!.replace(/\.canvas$/i, '')
    const sourcePath = `${root}/${opened.path}`, content = boardMarkdown(opened.canvas, opened.path, ids.length ? new Set(ids) : undefined)
    const result = kind === 'md'
      ? await api.document.exportMarkdownBundle({ content, sourcePath, suggestedName: title })
      : await api.document.exportPdf({ html: await captureDocumentPreviewHtml({ content, notePath: sourcePath, title }), suggestedName: title, sourcePath })
    if (result.success) showToast(kind === 'md' ? '已导出 Markdown' : '已导出 PDF')
    else if (!result.canceled) throw new Error(result.error || '导出失败')
  }
  return <div className="flex flex-col flex-1 min-h-0" data-testid="canvas-document">
    {error && <p role="alert" className="canvas-document-error">{error.replace(/^Error:\s*/, '')}</p>}
    {scheduling && calendarSnapshot && <ScheduleCardDialog key={scheduling.id} objectId={opened.objectId} nodeId={scheduling.id} version={opened.version}
      title={scheduling.type === 'text' ? scheduling.text.slice(0, 120) : scheduling.ready.preview?.title || '卡片日程'} snapshot={calendarSnapshot}
      close={() => setScheduling(null)} saved={refreshCalendar} />}
    <CanvasCompositionSurface calendarSnapshot={calendarSnapshot} onScheduleNode={node => { if (!calendarSnapshot) setError('日程尚未加载'); else setScheduling(node) }} canvas={opened.canvas} path={`${root}/${opened.path}`} version={opened.version} tabId={tab.id}
      trees={trees} composition={api.canvasComposition} drafts={api.documentDrafts} documentPreview={previews} linkPreview={links}
      refreshCanvas={refresh} openDraft={openDraft} onOperations={write}
      revealNode={target?.objectId === opened.objectId ? target : undefined}
      prepareGraphic={async draft => `${opened.path.slice(0, -7)}.assets/${sha256(graphicSvg(draft.graphic, draft.width, draft.height))}.svg`}
      resolveAsset={path => toLocalFileUrl(`${root}/${path}`)}
      onOpenNode={node => { if (node.ready.ref) run(() => openReadyRef(node.ready.ref!, 'document')); else if (node.type === 'link') run(() => openReadyRef({ kind: 'web', url: node.url }, 'document')) }}
      onNavigateSubcanvas={node => { if (node.type === 'file') openInCurrentTab(`${root}/${node.file}`); else if (node.ready.ref) run(() => openReadyRef(node.ready.ref!, 'document')) }}
      breadcrumbs={ancestors.map(node => ({ id: node.objectId, title: node.title }))}
      onNavigateAncestor={id => { const node = ancestors.find(item => item.objectId === id); if (node) openInCurrentTab(node.path) }}
      extraNewItems={(at, close) => <BoardNewItems at={at} close={close} pages={pages} root={root} boardPath={opened.path} add={node => write([{ type: 'addNode', node }])} report={cause => setError(String(cause))} />}
      acceptsDrop={types => types.includes('application/x-ready-fastcard')} onDropData={dropData} onExport={exportBoard}
      onAskAI={nodeIds => addBoardSelectionToAgentInput({ title: opened.canvas.ready.title || '画板', objectId: opened.objectId }, nodeIds)} />
  </div>
}
