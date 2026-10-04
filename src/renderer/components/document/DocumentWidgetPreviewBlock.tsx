import { memo, useEffect, useMemo, useState } from 'react'

import type { DocumentWidgetData } from '../../../shared/document-widget-parse'
import { recordDocumentPerformanceCounter } from '../../../shared/document-performance-diagnostics'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import DocumentWidgetCardShell from './DocumentWidgetCardShell'
import WidgetRenderer from './WidgetRenderer'
import { widgetHasInteractiveRuntime, widgetNeedsManualPreview } from './widget-card-helpers'

export interface DocumentWidgetPreviewBlockProps {
  renderIdentity: string
  /** 文档内卡片序号（从 1 开始），用于题注 FIG 编号。 */
  figureIndex?: number | null
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
    && previous.figureIndex === next.figureIndex
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
  figureIndex,
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
  // 组件较多或单卡过重时先以静态投影呈现；只有带交互运行时的卡才需要题注里的启用入口。
  const manualPreviewRequired = preferManualPreview || widgetNeedsManualPreview(renderCode)
  const hasInteractiveRuntime = useMemo(() => widgetHasInteractiveRuntime(renderCode), [renderCode])
  const canvasSize = useMemo(() => renderCode.match(/data-widget-size="([a-z_0-9]+)"/)?.[1] ?? null, [renderCode])
  const [previewEnabled, setPreviewEnabled] = useState(() => !manualPreviewRequired)
  useEffect(() => {
    setPreviewEnabled(!manualPreviewRequired)
  }, [manualPreviewRequired, renderCode])
  return (
    <DocumentWidgetCardShell
      title={title}
      figureIndex={figureIndex}
      canvasSize={canvasSize}
      onRenameTitle={onWidgetRename ? (nextTitle) => onWidgetRename(title, widget.widgetCode, nextTitle) : undefined}
      onQuote={onWidgetQuote ? () => onWidgetQuote(title, widget.widgetCode) : undefined}
      onExport={onWidgetExport ? () => onWidgetExport(title, renderCode, widgetState) : undefined}
      onEdit={canEdit && onWidgetEdit ? () => onWidgetEdit(widget) : undefined}
      dataReadyWidgetTitle={widget.title || ''}
      captionStatus={!previewEnabled && hasInteractiveRuntime ? (
        <button
          type="button"
          className="ready-doc-widget-card-activate"
          title={preferManualPreview ? '文档里的组件较多，这张卡先以静态方式呈现' : '这张卡内容较重，先以静态方式呈现'}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreviewEnabled(true)
          }}
        >
          <span className="ready-doc-widget-card-activate-dot" aria-hidden="true" />
          启用交互预览
        </button>
      ) : null}
      previewClassName="ready-doc-widget-card-preview ready-doc-widget-card-preview-static"
    >
      <WidgetRenderer
        title={widget.title}
        widgetCode={renderCode}
        preferManualPreview={preferManualPreview}
        previewEnabled={previewEnabled}
        widgetState={widgetState}
        onWidgetStateChange={onWidgetStateChange
          ? (state) => onWidgetStateChange(title, widget.widgetCode, state)
          : undefined}
      />
    </DocumentWidgetCardShell>
  )
}

export default memo(DocumentWidgetPreviewBlock, areDocumentWidgetPreviewBlockPropsEqual)
