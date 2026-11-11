import { dropAgentReference } from '../../../../modules/agent/drop-reference'
import { READY_REF_MIME } from '../../../../../shared/ready-ref'
import { showToast } from '../../../ui'
import { useCallback } from 'react'
import type { DragEvent } from 'react'
import { useAgent, type ChatAttachment } from '../../../../stores/useAgent'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from '../../../../modules/agent/composer-authority'
import { createLocalPathAttachment, getPathBasename } from '../attachments-helpers'

export interface UseAttachmentIntakeParams {
  addAttachments: (attachments: ChatAttachment[]) => void
  setInputValue: (value: string) => void
  setIsDragOver: (value: boolean) => void
  focusInputWithResize: () => void
}

export interface AttachmentIntakeHandle {
  handleDrop: (e: DragEvent) => Promise<void>
  handleDragOver: (e: DragEvent) => void
  handleDragLeave: (e: DragEvent) => void
}

export function useAttachmentIntake(params: UseAttachmentIntakeParams): AttachmentIntakeHandle {
  const { addAttachments, setIsDragOver, focusInputWithResize } = params

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      const composerAuthority = captureComposerAuthority(useAgent.getState())

      if (e.dataTransfer.types.includes(READY_REF_MIME)) {
        try {
          if (await dropAgentReference(e.dataTransfer, addAttachments)) focusInputWithResize()
        } catch (error) { showToast(error instanceof Error ? error.message : String(error), { tone: 'bad' }) }
        return
      }

      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      const newAttachments = await Promise.all(
        files.map(async (file) => {
          const path =
            typeof window !== 'undefined' && window.electronAPI
              ? window.electronAPI.getFilePathFromDrop(file)
              : file.name
          if (!path) return null

          let isDirectory = false
          if (window.electronAPI?.document?.stat) {
            const statResult = await window.electronAPI.document.stat(path).catch(() => null)
            isDirectory = statResult?.data?.isDirectory ?? statResult?.stat?.isDirectory ?? false
          }

          return createLocalPathAttachment({
            name: file.name || getPathBasename(path),
            path,
            ext: file.name.split('.').pop(),
            size: file.size,
            isDirectory
          })
        })
      )
      if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
      addAttachments(newAttachments.filter(Boolean) as ChatAttachment[])
      focusInputWithResize()
    },
    [addAttachments, focusInputWithResize, setIsDragOver]
  )

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [setIsDragOver])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [setIsDragOver])

  return { handleDrop, handleDragOver, handleDragLeave }
}
