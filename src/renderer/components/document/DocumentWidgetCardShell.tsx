import { Download, MessageSquareQuote, Pencil } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

interface DocumentWidgetCardActionProps {
  label: string
  icon: ReactNode
  onClick?: () => void
}

function DocumentWidgetCardAction({
  label,
  icon,
  onClick,
}: DocumentWidgetCardActionProps) {
  return (
    <button
      type="button"
      className="ready-doc-widget-primary-action"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick?.()
      }}
    >
      <span className="ready-doc-widget-primary-action-icon">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

interface DocumentWidgetCardShellProps {
  title: string
  /** 文档内第几张卡（从 1 开始）；有值时题注显示 FIG 编号。 */
  figureIndex?: number | null
  modeLabel?: string | null
  hint?: string | null
  onRenameTitle?: (nextTitle: string) => void | Promise<void>
  onQuote?: () => void
  onExport?: () => void
  onEdit?: () => void
  /** 题注里常驻的状态入口（如“启用交互预览”），不随悬停隐藏。 */
  captionStatus?: ReactNode
  children: ReactNode
  dataReadyWidgetTitle?: string
  previewClassName?: string
  /** 卡片画幅（widget-canvas 的 data-widget-size）；窄画幅时题注与卡片同宽居中。 */
  canvasSize?: string | null
}

function formatFigureIndex(index: number): string {
  return `FIG ${String(index).padStart(2, '0')}`
}

export default function DocumentWidgetCardShell({
  title,
  figureIndex,
  modeLabel,
  hint,
  onRenameTitle,
  onQuote,
  onExport,
  onEdit,
  captionStatus,
  children,
  dataReadyWidgetTitle,
  previewClassName,
  canvasSize,
}: DocumentWidgetCardShellProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)

  useEffect(() => {
    setDraftTitle(title)
  }, [title])

  const commitTitle = async () => {
    const normalizedTitle = draftTitle.trim()
    setEditingTitle(false)
    if (!onRenameTitle || !normalizedTitle || normalizedTitle === title) {
      setDraftTitle(title)
      return
    }

    try {
      await onRenameTitle(normalizedTitle)
    } catch {
      setDraftTitle(title)
    }
  }

  // 卡片先于题注：读者先看到内容，题注（编号 + 名称）与操作作为图注落在卡下，
  // 操作只在悬停或键盘聚焦时浮现，阅读态保持安静。
  return (
    <figure
      className="ready-doc-widget-card"
      contentEditable={false}
      data-ready-widget-title={dataReadyWidgetTitle || title}
      data-widget-size={canvasSize || undefined}
    >
      <div className={previewClassName || 'ready-doc-widget-card-preview'}>
        {children}
      </div>

      <figcaption className="ready-doc-widget-card-header">
        <div className="ready-doc-widget-card-meta">
          {typeof figureIndex === 'number' && figureIndex > 0 ? (
            <span className="ready-doc-widget-card-index">{formatFigureIndex(figureIndex)}</span>
          ) : null}
          {editingTitle ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => {
                void commitTitle()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitTitle()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraftTitle(title)
                  setEditingTitle(false)
                }
              }}
              className="ready-doc-widget-card-title-input"
              aria-label="卡片名称"
            />
          ) : (
            <button
              type="button"
              className="ready-doc-widget-card-title-pill"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (!onRenameTitle) return
                setEditingTitle(true)
              }}
              title={onRenameTitle ? '单击重命名卡片' : title}
            >
              <span className="ready-doc-widget-card-title">{title}</span>
            </button>
          )}

          {captionStatus}

          {(modeLabel || hint) ? (
            <div className="ready-doc-widget-card-subline">
              {modeLabel ? <span className="ready-doc-widget-card-badge">{modeLabel}</span> : null}
              {hint ? <span className="ready-doc-widget-card-hint">{hint}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="ready-doc-widget-card-actions">
          {onEdit ? (
            <DocumentWidgetCardAction
              label="编辑"
              icon={<Pencil size={12} strokeWidth={1.8} />}
              onClick={onEdit}
            />
          ) : null}
          <DocumentWidgetCardAction
            label="引用"
            icon={<MessageSquareQuote size={12} strokeWidth={1.8} />}
            onClick={onQuote}
          />
          <DocumentWidgetCardAction
            label="导出"
            icon={<Download size={12} strokeWidth={1.8} />}
            onClick={onExport}
          />
        </div>
      </figcaption>
    </figure>
  )
}
