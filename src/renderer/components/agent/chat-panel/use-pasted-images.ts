import { useCallback, useEffect, useState, type ClipboardEvent } from 'react'
import { MAX_PASTED_IMAGE_BYTES } from '../../../../shared/chat-pasted-image'
import { useAgent } from '../../../stores/useAgent'
import { captureComposerAuthority, isComposerAuthorityCurrent } from '../../../modules/agent/composer-authority'
import { createLocalPathAttachment } from './attachments-helpers'

export function usePastedImages() {
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const composerKey = useAgent((state) => `${state.activeSessionId}:${state.composerAuthorityRevision}`)
  useEffect(() => setError(null), [composerKey])
  const onPaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return // Let the browser paste ordinary text, including image URLs.
    event.preventDefault()
    const authority = captureComposerAuthority(useAgent.getState())
    setError(null)
    setPending((value) => value + 1)
    try {
      for (const file of files) {
        if (file.size > MAX_PASTED_IMAGE_BYTES) throw new Error('图片不能超过 20 MB')
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) return
        const result = await window.electronAPI.chat.savePastedImage(bytes)
        if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) return
        if (!result.success || !result.data) throw new Error(result.error || '图片粘贴失败，请重试')
        useAgent.getState().addAttachments([createLocalPathAttachment(result.data)])
      }
    } catch (cause) {
      if (isComposerAuthorityCurrent(useAgent.getState(), authority)) {
        setError(cause instanceof Error ? cause.message : '图片粘贴失败，请重试')
      }
    } finally {
      setPending((value) => value - 1)
    }
  }, [])
  return { onPaste, isPasting: pending > 0, pasteError: error }
}
