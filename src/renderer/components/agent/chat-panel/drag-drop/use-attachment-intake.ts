import { createReadyContextAttachment } from '../../../../modules/agent/chat-input-bridge'
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
  const { addAttachments, setInputValue, setIsDragOver, focusInputWithResize } = params

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      const composerAuthority = captureComposerAuthority(useAgent.getState())

      const readyRaw = e.dataTransfer.getData('application/x-ready-drag')
      if (readyRaw) {
        try {
          const data = JSON.parse(readyRaw) as {
            type:
              | 'file'
              | 'folder'
              | 'batch'
              | 'browser-tab'
              | 'doc-tab'
              | 'design-project'
              | 'video-project'
              | 'calendar-event'
              | 'skill-folder'
            path?: string
            name: string
            url?: string
            tabId?: string
            ext?: string
            size?: number
            title?: string
            heading?: string
            selection?: string
            excerpt?: string
            eventId?: string
            startTime?: string
            endTime?: string
            allDay?: boolean
            location?: string
            calendarId?: string
            description?: string
            projectId?: string
            duration?: number
            videoClipCount?: number
            subtitleClipCount?: number
            audioClipCount?: number
            dirty?: boolean
            saveStatus?: string
            snapshotHash?: string
            selectionSummary?: string
            currentToolContext?: string
            layoutDigest?: unknown
            source?: 'system' | 'imported'
            skillId?: string
            defaultCommand?: string
            items?: Array<{
              type?: 'file' | 'folder'
              path?: string
              name?: string
              ext?: string
              size?: number
              isDirectory?: boolean
            }>
          }

          if (data.type === 'batch' && Array.isArray(data.items)) {
            const attachments = data.items
              .filter((item) => item.path && item.name)
              .map((item) => createLocalPathAttachment({
                name: item.name || getPathBasename(item.path || ''),
                path: item.path || '',
                ext: item.ext,
                size: item.size,
                isDirectory: item.type === 'folder' || item.isDirectory === true
              }))
            if (attachments.length > 0) {
              addAttachments(attachments)
              focusInputWithResize()
            }
          } else if (data.type === 'skill-folder' && data.path) {
            const inferredSkillId = data.skillId

            addAttachments([
              {
                id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: data.name,
                path: data.path,
                type: 'text',
                size: 0,
                ext: '.skill',
                source: 'skill-folder',
                skillId: inferredSkillId,
                skillFolderPath: data.path
              }
            ])

            const mention = `@[${data.name}]`
            const currentInput = useAgent.getState().inputValue
            const trimmedEnd = currentInput.replace(/\s+$/, '')
            const next = trimmedEnd.length === 0 ? mention : `${trimmedEnd} ${mention}`
            setInputValue(`${next} `)
            focusInputWithResize()
          } else if (data.type === 'browser-tab' && data.tabId) {
            const attachment = await createReadyContextAttachment({ ...data, type: 'browser-tab' })
            if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
            addAttachments([attachment])
            focusInputWithResize()
          } else if (data.type === 'design-project') {
            const designData = data as typeof data & {
              selectedElementCount?: number
              selectionBounds?: { x: number; y: number; w: number; h: number }
              latestReviewSummary?: string
              repairScope?: string
            }
            const fallbackPath =
              data.path && data.path.startsWith('/')
                ? data.path
                : `design-project://${encodeURIComponent(data.name || 'draft')}#${encodeURIComponent(String(data.snapshotHash || Date.now()))}`
            addAttachments([
              {
                id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: data.name || '设计草稿',
                path: fallbackPath,
                type: 'text',
                size: 0,
                ext: '.tldr',
                source: 'design-project',
                dirty: typeof data.dirty === 'boolean' ? data.dirty : undefined,
                saveStatus: typeof data.saveStatus === 'string' ? data.saveStatus : undefined,
                snapshotHash: typeof data.snapshotHash === 'string' ? data.snapshotHash : undefined,
                selectionSummary:
                  typeof data.selectionSummary === 'string' ? data.selectionSummary : undefined,
                selectedElementCount:
                  typeof designData.selectedElementCount === 'number'
                    ? designData.selectedElementCount
                    : undefined,
                selectionBounds:
                  designData.selectionBounds && typeof designData.selectionBounds === 'object'
                    ? (designData.selectionBounds as { x: number; y: number; w: number; h: number })
                    : undefined,
                currentToolContext:
                  typeof data.currentToolContext === 'string' ? data.currentToolContext : undefined,
                latestReviewSummary:
                  typeof designData.latestReviewSummary === 'string'
                    ? designData.latestReviewSummary
                    : undefined,
                repairScope:
                  designData.repairScope === 'run-owned' || designData.repairScope === 'selected'
                    ? designData.repairScope
                    : undefined
              }
            ])
            focusInputWithResize()
          } else if (data.type === 'video-project') {
            const lines = [
              '### 剪辑项目引用',
              `- 项目: ${data.name}`,
              data.path ? `- 关联文件: ${data.path}` : null,
              typeof data.duration === 'number' ? `- 时长: ${data.duration.toFixed(1)} 秒` : null,
              typeof data.videoClipCount === 'number'
                ? `- 视频轨片段: ${data.videoClipCount}`
                : null,
              typeof data.subtitleClipCount === 'number'
                ? `- 字幕轨片段: ${data.subtitleClipCount}`
                : null,
              typeof data.audioClipCount === 'number'
                ? `- 音频轨片段: ${data.audioClipCount}`
                : null
            ].filter(Boolean)
            const currentInput = useAgent.getState().inputValue
            const snippet = lines.join('\n')
            setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
            focusInputWithResize()
          } else if (data.type === 'calendar-event') {
            const attachment = await createReadyContextAttachment({ ...data, type: 'calendar-event' })
            if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
            if (attachment) addAttachments([attachment])
            focusInputWithResize()
          } else if (data.type === 'doc-tab') {
            const attachment = await createReadyContextAttachment({ ...data, type: 'doc-tab', content: data.selection })
            if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
            addAttachments([attachment])
            focusInputWithResize()
          } else if (
            (data.type === 'file' || data.type === 'folder') &&
            data.path
          ) {
            addAttachments([
              createLocalPathAttachment({
                name: data.name,
                path: data.path,
                ext: data.ext,
                size: data.size,
                isDirectory: data.type === 'folder'
              })
            ])
            focusInputWithResize()
          }
        } catch {
          /* ignore malformed data */
        }
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
    [addAttachments, focusInputWithResize, setInputValue, setIsDragOver]
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
