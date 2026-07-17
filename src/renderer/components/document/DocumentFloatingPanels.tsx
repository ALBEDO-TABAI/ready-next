import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  ListTree,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react'
import {
  buildDocumentOutline,
  getExcerptForLine,
  getOutlineNodeForLine,
  resolveDocumentMarkLocation,
  type DocumentMarkKind,
  type DocumentMarkRecord,
  type DocumentOutlineNode,
  type DocumentOutlineSnapshot,
} from '../../../shared/document-side-panels'
import { LiquidSurfaceLayer } from '../ui/liquid-glass/LiquidFloatingPanel'
import './documentFloatingPanels.css'

type MarkTab = 'bookmark' | 'note'
const PANEL_EXIT_ANIMATION_MS = 180
const MARK_DRAFTS_KEY = 'ready-document-mark-drafts-v1'
const MAX_MARK_DRAFTS = 200
const EMPTY_DOCUMENT_OUTLINE: DocumentOutlineSnapshot = {
  contentHash: '0',
  generatedAt: new Date(0).toISOString(),
  lineCount: 1,
  wordCount: 0,
  nodes: [],
}

type MarkDraftCacheEntry = {
  documentPath: string
  groupName: string
  noteDraft: string
  markTab: MarkTab
  updatedAt: number
}

interface DocumentFloatingPanelsProps {
  documentPath: string | null
  documentTitle: string
  content: string
  activeLine: number | null
  outlineOpen: boolean
  marksOpen: boolean
  onToggleOutline: () => void
  onToggleMarks: () => void
  onReveal: (lineStart: number, lineEnd?: number | null) => void
  showToggles?: boolean
}

function normalizeGroupName(value: string): string {
  return value.trim() || '默认'
}

function formatLineRange(start: number | null, end?: number | null): string {
  if (!start) return '未定位'
  if (end && end > start) return `L${start}-${end}`
  return `L${start}`
}

function buildMarkDraft(
  kind: DocumentMarkKind,
  documentPath: string,
  documentTitle: string,
  outline: DocumentOutlineSnapshot,
  content: string,
  activeLine: number | null,
  groupName: string,
  noteText: string,
) {
  const lineStart = activeLine || outline.nodes[0]?.lineStart || 1
  const node = getOutlineNodeForLine(outline, lineStart)
  const excerpt = getExcerptForLine(content, lineStart)
  const lineEnd = node?.lineEnd && node.lineStart === lineStart ? node.lineEnd : lineStart
  const title = kind === 'bookmark'
    ? (node?.title || excerpt || documentTitle || '书签')
    : (node?.title ? `关于 ${node.title}` : documentTitle || '新笔记')
  const anchorProgress = node
    ? Math.max(0, Math.min(1, (lineStart - node.lineStart) / Math.max(1, node.lineEnd - node.lineStart + 1)))
    : null

  return {
    kind,
    documentPath,
    title,
    groupName: normalizeGroupName(groupName),
    noteText: kind === 'note' ? noteText.trim() : null,
    excerpt,
    lineStart,
    lineEnd,
    anchorTitle: node?.anchorTitle ?? null,
    anchorOrdinal: node?.anchorOrdinal ?? null,
    anchorProgress,
  }
}

function OutlineRow({
  node,
  active,
  selected,
  onReveal,
}: {
  node: DocumentOutlineNode
  active: boolean
  selected: boolean
  onReveal: (node: DocumentOutlineNode) => void
}) {
  return (
    <button
      type="button"
      className={`document-panel-row document-outline-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      style={{ paddingLeft: 10 + node.depth * 14 }}
      onClick={() => onReveal(node)}
      title={`${node.title} · ${formatLineRange(node.lineStart, node.lineEnd)}`}
    >
      <span className="document-panel-row__main">
        <span className="document-panel-row__title">{node.title}</span>
        <span className="document-panel-row__summary">{node.summary}</span>
      </span>
      <span className="document-panel-row__meta">{formatLineRange(node.lineStart, node.lineEnd)}</span>
    </button>
  )
}

function groupMarks(marks: DocumentMarkRecord[]): Array<[string, DocumentMarkRecord[]]> {
  const groups = new Map<string, DocumentMarkRecord[]>()
  marks.forEach((mark) => {
    const groupName = normalizeGroupName(mark.groupName)
    groups.set(groupName, [...(groups.get(groupName) || []), mark])
  })
  return Array.from(groups.entries())
}

function readMarkDraftStore(): MarkDraftCacheEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(MARK_DRAFTS_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is MarkDraftCacheEntry => (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as MarkDraftCacheEntry).documentPath === 'string' &&
      typeof (item as MarkDraftCacheEntry).groupName === 'string' &&
      typeof (item as MarkDraftCacheEntry).noteDraft === 'string' &&
      ((item as MarkDraftCacheEntry).markTab === 'bookmark' || (item as MarkDraftCacheEntry).markTab === 'note') &&
      typeof (item as MarkDraftCacheEntry).updatedAt === 'number'
    ))
  } catch {
    // silent-catch: corrupted mark draft cache should reset to an empty cache.
    return []
  }
}

function readMarkDraft(documentPath: string): MarkDraftCacheEntry | null {
  return readMarkDraftStore().find((item) => item.documentPath === documentPath) || null
}

function saveMarkDraft(next: MarkDraftCacheEntry): void {
  try {
    const rest = readMarkDraftStore().filter((item) => item.documentPath !== next.documentPath)
    window.localStorage?.setItem(
      MARK_DRAFTS_KEY,
      JSON.stringify([next, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MARK_DRAFTS)),
    )
  } catch {
    // silent-catch: draft persistence is best-effort; mark creation still writes to the database.
  }
}

export function DocumentPanelToggleButtons({
  outlineOpen,
  marksOpen,
  onToggleOutline,
  onToggleMarks,
  rail = false,
}: {
  outlineOpen: boolean
  marksOpen: boolean
  onToggleOutline: () => void
  onToggleMarks: () => void
  rail?: boolean
}) {
  return (
    <div
      className={`document-floating-toggles${rail ? ' document-floating-toggles--rail' : ''}`}
      aria-label="文档辅助面板"
    >
      <button
        type="button"
        className={`document-floating-toggle${outlineOpen ? ' is-active' : ''}`}
        onClick={onToggleOutline}
        title="内容速览"
        aria-pressed={outlineOpen}
      >
        <ListTree className="h-[14px] w-[14px]" strokeWidth={2} />
      </button>
      <button
        type="button"
        className={`document-floating-toggle${marksOpen ? ' is-active' : ''}`}
        onClick={onToggleMarks}
        title="书签和笔记"
        aria-pressed={marksOpen}
      >
        <Bookmark className="h-[14px] w-[14px]" strokeWidth={2} />
      </button>
    </div>
  )
}

export default function DocumentFloatingPanels({
  documentPath,
  documentTitle,
  content,
  activeLine,
  outlineOpen,
  marksOpen,
  onToggleOutline,
  onToggleMarks,
  onReveal,
  showToggles = true,
}: DocumentFloatingPanelsProps) {
  const [outline, setOutline] = useState(EMPTY_DOCUMENT_OUTLINE)
  const [outlineContent, setOutlineContent] = useState('')
  const [outlineLoading, setOutlineLoading] = useState(false)
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null)
  const [marks, setMarks] = useState<DocumentMarkRecord[]>([])
  const [marksLoading, setMarksLoading] = useState(false)
  const [markTab, setMarkTab] = useState<MarkTab>('bookmark')
  const [groupName, setGroupName] = useState('默认')
  const [noteDraft, setNoteDraft] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [outlinePanelRendered, setOutlinePanelRendered] = useState(outlineOpen)
  const [outlinePanelClosing, setOutlinePanelClosing] = useState(false)
  const [marksPanelRendered, setMarksPanelRendered] = useState(marksOpen)
  const [marksPanelClosing, setMarksPanelClosing] = useState(false)
  const marksRequestSeqRef = useRef(0)
  const skipNextDraftSaveRef = useRef(false)

  useEffect(() => {
    if (outlineOpen) {
      setOutlinePanelRendered(true)
      setOutlinePanelClosing(false)
      return undefined
    }
    if (!outlinePanelRendered) return undefined
    setOutlinePanelClosing(true)
    const timer = window.setTimeout(() => {
      setOutlinePanelRendered(false)
      setOutlinePanelClosing(false)
    }, PANEL_EXIT_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [outlineOpen, outlinePanelRendered])

  useEffect(() => {
    if (marksOpen) {
      setMarksPanelRendered(true)
      setMarksPanelClosing(false)
      return undefined
    }
    if (!marksPanelRendered) return undefined
    setMarksPanelClosing(true)
    const timer = window.setTimeout(() => {
      setMarksPanelRendered(false)
      setMarksPanelClosing(false)
    }, PANEL_EXIT_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [marksOpen, marksPanelRendered])

  useEffect(() => {
    if (!outlineOpen && !marksOpen) return undefined
    setOutlineLoading(true)
    const timer = window.setTimeout(() => {
      setOutline(buildDocumentOutline(content))
      setOutlineContent(content)
      setOutlineLoading(false)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [content, marksOpen, outlineOpen])

  const loadMarks = useCallback(async () => {
    if (!documentPath || !window.electronAPI?.document?.listMarks) {
      marksRequestSeqRef.current += 1
      setMarks([])
      return
    }
    const requestSeq = marksRequestSeqRef.current + 1
    marksRequestSeqRef.current = requestSeq
    setMarksLoading(true)
    try {
      const result = await window.electronAPI.document.listMarks({ documentPath })
      if (marksRequestSeqRef.current === requestSeq) {
        setMarks(result.success ? (result.data || []) : [])
      }
    } finally {
      if (marksRequestSeqRef.current === requestSeq) {
        setMarksLoading(false)
      }
    }
  }, [documentPath])

  useEffect(() => {
    if (!marksOpen) return
    void loadMarks()
  }, [loadMarks, marksOpen])

  useEffect(() => {
    if (!documentPath) {
      skipNextDraftSaveRef.current = true
      setGroupName('默认')
      setNoteDraft('')
      setMarkTab('bookmark')
      return
    }
    const draft = readMarkDraft(documentPath)
    skipNextDraftSaveRef.current = true
    setGroupName(draft?.groupName || '默认')
    setNoteDraft(draft?.noteDraft || '')
    setMarkTab(draft?.markTab || 'bookmark')
  }, [documentPath])

  useEffect(() => {
    if (!documentPath) return
    if (skipNextDraftSaveRef.current) {
      skipNextDraftSaveRef.current = false
      return
    }
    saveMarkDraft({
      documentPath,
      groupName: normalizeGroupName(groupName),
      noteDraft,
      markTab,
      updatedAt: Date.now(),
    })
  }, [documentPath, groupName, markTab, noteDraft])

  const currentOutlineNode = useMemo(() => getOutlineNodeForLine(outline, activeLine), [activeLine, outline])
  const visibleMarks = useMemo(() => marks.filter((mark) => mark.kind === markTab), [markTab, marks])
  const resolvedMarks = useMemo(() => {
    if (!marksPanelRendered) return new Map()
    return new Map(marks.map((mark) => [mark.id, resolveDocumentMarkLocation(mark, outlineContent, outline)]))
  }, [marks, marksPanelRendered, outline, outlineContent])

  const revealOutlineNode = useCallback((node: DocumentOutlineNode) => {
    setSelectedOutlineId(node.id)
    onReveal(node.lineStart, node.lineEnd)
  }, [onReveal])

  const createMark = useCallback(async (kind: DocumentMarkKind) => {
    if (!documentPath || !window.electronAPI?.document?.createMark) return
    if (kind === 'note' && noteDraft.trim().length === 0) return
    const draft = buildMarkDraft(
      kind,
      documentPath,
      documentTitle,
      outline,
      content,
      activeLine,
      groupName,
      noteDraft,
    )
    const result = await window.electronAPI.document.createMark(draft)
    if (result.success && result.data) {
      setMarks((prev) => [result.data as DocumentMarkRecord, ...prev])
      if (kind === 'note') setNoteDraft('')
      setMarkTab(kind)
    }
  }, [activeLine, content, documentPath, documentTitle, groupName, noteDraft, outline])

  const deleteMark = useCallback(async (id: string) => {
    if (!window.electronAPI?.document?.deleteMark) return
    const result = await window.electronAPI.document.deleteMark({ id })
    if (result.success) {
      setMarks((prev) => prev.filter((mark) => mark.id !== id))
    }
  }, [])

  const updateMarkGroup = useCallback(async (mark: DocumentMarkRecord) => {
    if (!window.electronAPI?.document?.updateMark) return
    const nextGroup = window.prompt('移动到分组', mark.groupName)
    if (nextGroup === null) return
    const result = await window.electronAPI.document.updateMark({
      id: mark.id,
      patch: { groupName: normalizeGroupName(nextGroup) },
    })
    if (result.success && result.data) {
      setMarks((prev) => prev.map((item) => item.id === mark.id ? result.data as DocumentMarkRecord : item))
    }
  }, [])

  const renameGroup = useCallback(async (currentGroup: string) => {
    if (!window.electronAPI?.document?.updateMark) return
    const nextGroup = window.prompt('重命名分组', currentGroup)
    if (nextGroup === null) return
    const normalized = normalizeGroupName(nextGroup)
    const targets = visibleMarks.filter((mark) => normalizeGroupName(mark.groupName) === currentGroup)
    const updated: DocumentMarkRecord[] = []
    for (const mark of targets) {
      const result = await window.electronAPI.document.updateMark({
        id: mark.id,
        patch: { groupName: normalized },
      })
      if (result.success && result.data) updated.push(result.data)
    }
    if (updated.length > 0) {
      const byId = new Map(updated.map((mark) => [mark.id, mark]))
      setMarks((prev) => prev.map((mark) => byId.get(mark.id) || mark))
    }
  }, [visibleMarks])

  const revealMark = useCallback((mark: DocumentMarkRecord) => {
    const location = resolvedMarks.get(mark.id)
    if (!location || location.status === 'stale' || !location.lineStart) return
    onReveal(location.lineStart, location.lineEnd)
  }, [onReveal, resolvedMarks])

  const toggleGroupCollapsed = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  return (
    <>
      {showToggles && (
        <DocumentPanelToggleButtons
          outlineOpen={outlineOpen}
          marksOpen={marksOpen}
          onToggleOutline={onToggleOutline}
          onToggleMarks={onToggleMarks}
        />
      )}

      {outlinePanelRendered && (
        <aside
          className={`document-floating-panel document-floating-panel--left ready-app-liquid-panel${outlinePanelClosing ? ' is-closing' : ''}`}
          aria-label="内容速览"
        >
          <LiquidSurfaceLayer
            className="ready-liquid-popover__lens ready-app-liquid-panel__lens"
            radius={12}
            withProjection={false}
            blur={3}
            frost={0}
            saturation={1.06}
            brightness={1.12}
            contrast={0.68}
          />
          <header className="document-floating-panel__header">
            <div>
              <div className="document-floating-panel__title">内容速览</div>
              <div className="document-floating-panel__hint">
                {outline.lineCount} 行 · {outline.wordCount} 字符点
              </div>
            </div>
            <div className="document-floating-panel__header-actions">
              <button
                type="button"
                className="document-floating-icon-button"
                onClick={onToggleOutline}
                title="收回内容速览"
                aria-label="收回内容速览"
              >
                <X className="h-[14px] w-[14px]" strokeWidth={1.8} />
              </button>
            </div>
          </header>
          <div className="document-floating-panel__body">
            {outlineLoading && (
              <div className="document-floating-empty">正在整理文档结构...</div>
            )}
            {!outlineLoading && outline.nodes.length === 0 && (
              <div className="document-floating-empty">这篇文档暂时没有可预览的结构。</div>
            )}
            {!outlineLoading && outline.nodes.map((node) => (
              <OutlineRow
                key={node.id}
                node={node}
                active={currentOutlineNode?.id === node.id}
                selected={selectedOutlineId === node.id}
                onReveal={revealOutlineNode}
              />
            ))}
          </div>
        </aside>
      )}

      {marksPanelRendered && (
        <aside
          className={`document-floating-panel document-floating-panel--right ready-app-liquid-panel${marksPanelClosing ? ' is-closing' : ''}`}
          aria-label="书签和笔记"
        >
          <LiquidSurfaceLayer
            className="ready-liquid-popover__lens ready-app-liquid-panel__lens"
            radius={12}
            withProjection={false}
            blur={3}
            frost={0}
            saturation={1.06}
            brightness={1.12}
            contrast={0.68}
          />
          <header className="document-floating-panel__header">
            <div>
              <div className="document-floating-panel__title">书签 / 笔记</div>
              <div className="document-floating-panel__hint">
                {documentPath ? '跟随当前文档保存' : '保存前需打开本地文档'}
              </div>
            </div>
            <div className="document-floating-panel__header-actions">
              <button
                type="button"
                className="document-floating-icon-button"
                onClick={onToggleMarks}
                title="收回书签和笔记"
                aria-label="收回书签和笔记"
              >
                <X className="h-[14px] w-[14px]" strokeWidth={1.8} />
              </button>
            </div>
          </header>

            <div className="document-mark-tabs" role="tablist" aria-label="文档标记类型">
              <button
                type="button"
                role="tab"
                className={markTab === 'bookmark' ? 'is-active' : ''}
                onClick={() => setMarkTab('bookmark')}
              >
                <Bookmark className="h-[13px] w-[13px]" strokeWidth={1.8} />
                书签
              </button>
              <button
                type="button"
                role="tab"
                className={markTab === 'note' ? 'is-active' : ''}
                onClick={() => setMarkTab('note')}
              >
                <StickyNote className="h-[13px] w-[13px]" strokeWidth={1.8} />
                笔记
              </button>
            </div>

            <div className="document-mark-create">
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="分组"
                aria-label="分组"
              />
              {markTab === 'note' ? (
                <textarea
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="写一条笔记..."
                  aria-label="笔记内容"
                />
              ) : null}
              <button
                type="button"
                onClick={() => void createMark(markTab)}
                disabled={!documentPath || (markTab === 'note' && noteDraft.trim().length === 0)}
              >
                <Plus className="h-[13px] w-[13px]" strokeWidth={2} />
                {markTab === 'bookmark' ? '添加书签' : '添加笔记'}
              </button>
            </div>

            <div className="document-floating-panel__body document-floating-panel__body--marks">
            {marksLoading && <div className="document-floating-empty">正在读取标记...</div>}
            {!marksLoading && visibleMarks.length === 0 && (
              <div className="document-floating-empty">
                {markTab === 'bookmark' ? '还没有书签。' : '还没有笔记。'}
              </div>
            )}
            {!marksLoading && groupMarks(visibleMarks).map(([group, groupItems]) => {
              const collapsed = collapsedGroups.has(group)
              return (
                <section key={group} className="document-mark-group">
                  <div className="document-mark-group__header">
                    <button type="button" onClick={() => toggleGroupCollapsed(group)}>
                      {collapsed ? <ChevronRight className="h-[13px] w-[13px]" /> : <ChevronDown className="h-[13px] w-[13px]" />}
                      <span>{group}</span>
                      <span>{groupItems.length}</span>
                    </button>
                    <button
                      type="button"
                      className="document-mark-group__edit"
                      onClick={() => void renameGroup(group)}
                      title="重命名分组"
                    >
                      <Pencil className="h-[12px] w-[12px]" strokeWidth={1.8} />
                    </button>
                  </div>
                  {!collapsed && groupItems.map((mark) => {
                    const location = resolvedMarks.get(mark.id)
                    const stale = location?.status === 'stale'
                    return (
                      <div
                        key={mark.id}
                        role="button"
                        tabIndex={stale ? -1 : 0}
                        className={`document-panel-row document-mark-row${stale ? ' is-stale' : ''}`}
                        onClick={() => revealMark(mark)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            revealMark(mark)
                          }
                        }}
                        aria-disabled={stale}
                        title={stale ? '原位置需要重新定位' : `${mark.title} · ${formatLineRange(location?.lineStart ?? mark.lineStart, location?.lineEnd ?? mark.lineEnd)}`}
                      >
                        <span className="document-panel-row__main">
                          <span className="document-panel-row__title">{mark.title}</span>
                          {markTab === 'note' && mark.noteText ? (
                            <span className="document-panel-row__summary">{mark.noteText}</span>
                          ) : (
                            <span className="document-panel-row__summary">{mark.excerpt || '无摘录'}</span>
                          )}
                        </span>
                        <span className="document-panel-row__meta">
                          {stale ? '需定位' : formatLineRange(location?.lineStart ?? mark.lineStart, location?.lineEnd ?? mark.lineEnd)}
                        </span>
                        <span className="document-panel-row__actions">
                          <span
                            role="button"
                            tabIndex={-1}
                            onClick={(event) => {
                              event.stopPropagation()
                              void updateMarkGroup(mark)
                            }}
                            title="移动分组"
                          >
                            <Pencil className="h-[12px] w-[12px]" strokeWidth={1.8} />
                          </span>
                          <span
                            role="button"
                            tabIndex={-1}
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteMark(mark.id)
                            }}
                            title="删除"
                          >
                            <Trash2 className="h-[12px] w-[12px]" strokeWidth={1.8} />
                          </span>
                        </span>
                      </div>
                    )
                  })}
                </section>
              )
            })}
            </div>
        </aside>
      )}
    </>
  )
}
