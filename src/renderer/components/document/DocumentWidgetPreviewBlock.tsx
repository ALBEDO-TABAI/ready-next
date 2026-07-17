import { memo } from 'react'

import type { DocumentWidgetData } from '../../../shared/document-widget-parse'
import { recordDocumentPerformanceCounter } from '../../../shared/document-performance-diagnostics'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import DocumentWidgetCardShell from './DocumentWidgetCardShell'
import WidgetRenderer from './WidgetRenderer'

export interface DocumentWidgetPreviewBlockProps {
  renderIdentity: string
  widget: DocumentWidgetData
  renderCode: string
  widgetState: DocumentWidgetPersistedState | null
  widgetStateSignature: string
  preferManualPreview: boolean
  canEdit: boolean
  onWidgetRename?: (currentTitle: string, widgetCode: string, nextTitle: string) => void
  onWidgetQuote?: (title: string, widgetCode: string) => void
  onWidgetExport?: (title: string, widgetCode: string, widgetState?: DocumentWidgetPersistedState | null) => void
  onWidgetEdit?: (widget: DocumentWidgetData) => void
  onWidgetStateChange?: (title: string, widgetCode: string, widgetState: DocumentWidgetPersistedState) => void
}

export function areDocumentWidgetPreviewBlockPropsEqual(
  previous: DocumentWidgetPreviewBlockProps,
  next: DocumentWidgetPreviewBlockProps,
): boolean {
  return previous.renderIdentity === next.renderIdentity
    && previous.widgetStateSignature === next.widgetStateSignature
    && previous.preferManualPreview === next.preferManualPreview
    && previous.canEdit === next.canEdit
    && previous.onWidgetRename === next.onWidgetRename
    && previous.onWidgetQuote === next.onWidgetQuote
    && previous.onWidgetExport === next.onWidgetExport
    && previous.onWidgetEdit === next.onWidgetEdit
    && previous.onWidgetStateChange === next.onWidgetStateChange
}

function DocumentWidgetPreviewBlock({
  widget,
  renderCode,
  widgetState,
  preferManualPreview,
  canEdit,
  onWidgetRename,
  onWidgetQuote,
  onWidgetExport,
  onWidgetEdit,
  onWidgetStateChange,
}: DocumentWidgetPreviewBlockProps) {
  recordDocumentPerformanceCounter('widgetBlockRenders')
  const title = widget.title || 'widget'
  return (
    <DocumentWidgetCardShell
      title={title}
      onRenameTitle={onWidgetRename ? (nextTitle) => onWidgetRename(title, widget.widgetCode, nextTitle) : undefined}
      onQuote={onWidgetQuote ? () => onWidgetQuote(title, widget.widgetCode) : undefined}
      onExport={onWidgetExport ? () => onWidgetExport(title, renderCode, widgetState) : undefined}
      onEdit={canEdit && onWidgetEdit ? () => onWidgetEdit(widget) : undefined}
      dataReadyWidgetTitle={widget.title || ''}
      previewClassName="ready-doc-widget-card-preview ready-doc-widget-card-preview-static"
    >
      <WidgetRenderer
        title={widget.title}
        widgetCode={renderCode}
        preferManualPreview={preferManualPreview}
        widgetState={widgetState}
        onWidgetStateChange={onWidgetStateChange
          ? (state) => onWidgetStateChange(title, widget.widgetCode, state)
          : undefined}
      />
    </DocumentWidgetCardShell>
  )
}

export default memo(DocumentWidgetPreviewBlock, areDocumentWidgetPreviewBlockPropsEqual)
