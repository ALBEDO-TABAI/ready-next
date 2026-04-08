import { Download, MessageSquareQuote } from 'lucide-react'
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
  modeLabel?: string | null
  hint?: string | null
  onRenameTitle?: (nextTitle: string) => void | Promise<void>
  onQuote?: () => void
  onExport?: () => void
  extraActions?: ReactNode
  children: ReactNode
  contentEditable?: boolean
  dataReadyWidgetTitle?: string
  previewClassName?: string
}

export default function DocumentWidgetCardShell({
  title,
  modeLabel,
  hint,
  onRenameTitle,
  onQuote,
  onExport,
  extraActions,
  children,
  contentEditable = false,
  dataReadyWidgetTitle,
  previewClassName,
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

  return (
    <div
      className="ready-doc-widget-card"
      contentEditable={contentEditable}
      data-ready-widget-title={dataReadyWidgetTitle || title}
    >
      <div className="ready-doc-widget-card-header">
        <div className="ready-doc-widget-card-meta">
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

          {(modeLabel || hint) ? (
            <div className="ready-doc-widget-card-subline">
              {modeLabel ? <span className="ready-doc-widget-card-badge">{modeLabel}</span> : null}
              {hint ? <span className="ready-doc-widget-card-hint">{hint}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="ready-doc-widget-card-actions">
          <DocumentWidgetCardAction
            label="引用"
            icon={<MessageSquareQuote size={13} strokeWidth={2} />}
            onClick={onQuote}
          />
          <DocumentWidgetCardAction
            label="导出"
            icon={<Download size={13} strokeWidth={2} />}
            onClick={onExport}
          />
          {extraActions}
        </div>
      </div>

      <div className={previewClassName || 'ready-doc-widget-card-preview'}>
        {children}
      </div>
    </div>
  )
}
