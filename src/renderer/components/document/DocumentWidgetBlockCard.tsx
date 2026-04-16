import { Code2, Copy, Eye, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import DocumentWidgetCardShell from './DocumentWidgetCardShell'
import WidgetRenderer from './WidgetRenderer'

interface DocumentWidgetBlockCardProps {
  title: string
  widgetCode: string
  preferManualPreview?: boolean
  sourceVisible: boolean
  onToggleSource: () => void
  onCopySource: () => void
  onDelete: () => void
  onRenameTitle?: (nextTitle: string) => void
  onQuoteToAgent?: (title: string, widgetCode: string) => void
  onExport?: (title: string, widgetCode: string) => void
  onRequestPreview?: (title: string) => void
}

export default function DocumentWidgetBlockCard({
  title,
  widgetCode,
  preferManualPreview = false,
  sourceVisible,
  onToggleSource,
  onCopySource,
  onDelete,
  onRenameTitle,
  onQuoteToAgent,
  onExport,
  onRequestPreview,
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
    <DocumentWidgetCardShell
      title={title}
      onRenameTitle={onRenameTitle}
      onQuote={() => onQuoteToAgent?.(title, widgetCode)}
      onExport={() => onExport?.(title, widgetCode)}
      extraActions={
        <>
          {onRequestPreview ? (
            <button
              type="button"
              className="ready-doc-widget-card-action"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onRequestPreview(title)
              }}
            >
              <Eye size={13} strokeWidth={2} />
              <span>预览</span>
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
        </>
      }
      contentEditable={false}
    >
      <WidgetRenderer widgetCode={widgetCode} preferManualPreview={preferManualPreview} />
    </DocumentWidgetCardShell>
  )
}
