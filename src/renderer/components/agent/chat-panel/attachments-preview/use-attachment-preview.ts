import { useCallback } from 'react'
import { openReadyRef } from '../../../../modules/workbench/open-ready-ref'

import {
  useAgent,
  type AttachmentPreviewState,
  type ChatAttachment,
} from '../../../../stores/useAgent'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from '../../../../modules/agent/composer-authority'
import {
  formatDesignAttachmentSummary,
  formatDocumentQuoteAttachmentSummary,
  formatDocumentWidgetTargetSummary,
  formatFolderAttachmentSummary,
} from '../attachment-summary'

interface UseAttachmentPreviewParams {
  setActiveAttachmentPreview: (preview: AttachmentPreviewState | null) => void
  setAttachmentPreviewLoading: (loading: boolean) => void
}

export function useAttachmentPreview({
  setActiveAttachmentPreview,
  setAttachmentPreviewLoading,
}: UseAttachmentPreviewParams): (attachment: ChatAttachment) => Promise<void> {
  return useCallback(async (attachment: ChatAttachment) => {
    if (!attachment.path) return
    const composerAuthority = captureComposerAuthority(useAgent.getState())
    if (attachment.source === 'calendar-event') {
      try { await openReadyRef(attachment.path) }
      catch (error) {
        if (isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) {
          setActiveAttachmentPreview({ attachment, mode: 'file', error: error instanceof Error ? error.message : String(error) })
        }
      }
      return
    }
    if (attachment.source === 'rss-reference') {
      setActiveAttachmentPreview({ attachment, mode: 'text' })
      return
    }
    if (attachment.source === 'document-quote') {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatDocumentQuoteAttachmentSummary(attachment),
      })
      return
    }
    if (attachment.source === 'document-widget-target') {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatDocumentWidgetTargetSummary(attachment),
      })
      return
    }
    if (attachment.source === 'design-project') {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatDesignAttachmentSummary(attachment),
      })
      return
    }
    if (attachment.isDirectory) {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatFolderAttachmentSummary(attachment),
      })
      return
    }
    if (attachment.type === 'image') {
      setActiveAttachmentPreview({ attachment, mode: 'image' })
      return
    }
    if (attachment.type === 'video') {
      setActiveAttachmentPreview({ attachment, mode: 'video' })
      return
    }
    if (attachment.type === 'text') {
      setAttachmentPreviewLoading(true)
      try {
        const result = await window.electronAPI.chat.readFileForAI(attachment.path)
        if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
        if (result.success && result.data?.type === 'text') {
          setActiveAttachmentPreview({
            attachment,
            mode: 'text',
            content: result.data.content || '',
          })
        } else {
          setActiveAttachmentPreview({
            attachment,
            mode: 'file',
            error: result.error || '无法读取附件内容',
          })
        }
      } finally {
        if (isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) {
          setAttachmentPreviewLoading(false)
        }
      }
      return
    }
    setActiveAttachmentPreview({ attachment, mode: 'file' })
  }, [setActiveAttachmentPreview, setAttachmentPreviewLoading])
}
