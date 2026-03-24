import { Code2, Copy, MessageSquareQuote, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import WidgetRenderer from './WidgetRenderer'

interface DocumentWidgetBlockCardProps {
  title: string
  modeLabel: string
  widgetCode: string
  sourceVisible: boolean
  onToggleSource: () => void
  onCopySource: () => void
  onDelete: () => void
  onRequestAgentUpdate?: (title: string, widgetCode: string) => void
}

export default function DocumentWidgetBlockCard({
  title,
  modeLabel,
  widgetCode,
  sourceVisible,
  onToggleSource,
  onCopySource,
  onDelete,
  onRequestAgentUpdate,
}: DocumentWidgetBlockCardProps) {
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 2500)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  return (
    <div className="ready-doc-widget-card" contentEditable={false}>
      <div className="ready-doc-widget-card-header">
        <div className="ready-doc-widget-card-meta">
          <div className="ready-doc-widget-card-title">{title}</div>
          <div className="ready-doc-widget-card-subline">
            <span className="ready-doc-widget-card-badge">{modeLabel}</span>
            <span className="ready-doc-widget-card-hint">
              {sourceVisible ? '源码已展开，可直接在下方编辑' : '源码已折叠，保留文档整洁'}
            </span>
          </div>
        </div>

        <div className="ready-doc-widget-card-actions">
          {onRequestAgentUpdate ? (
            <button
              type="button"
              className="ready-doc-widget-card-action"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onRequestAgentUpdate(title, widgetCode)
              }}
            >
              <MessageSquareQuote size={13} strokeWidth={2} />
              <span>让 agent 更新</span>
            </button>
          ) : null}
          <button type="button" className="ready-doc-widget-card-action" onClick={onToggleSource}>
            <Code2 size={13} strokeWidth={2} />
            <span>{sourceVisible ? '隐藏源码' : '查看源码'}</span>
          </button>
          <button
            type="button"
            className="ready-doc-widget-card-action"
            onClick={() => {
              onCopySource()
              setCopied(true)
            }}
          >
            <Copy size={13} strokeWidth={2} />
            <span>{copied ? '已复制' : '复制源码'}</span>
          </button>
          <button
            type="button"
            className="ready-doc-widget-card-action danger"
            onClick={() => {
              if (confirmDelete) {
                onDelete()
                setConfirmDelete(false)
                return
              }
              setConfirmDelete(true)
            }}
          >
            <Trash2 size={13} strokeWidth={2} />
            <span>{confirmDelete ? '确认删除' : '删除'}</span>
          </button>
        </div>
      </div>

      <div className="ready-doc-widget-card-preview">
        <WidgetRenderer widgetCode={widgetCode} />
      </div>
    </div>
  )
}
