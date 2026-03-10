import type { AgentArtifact, ChatAttachment, ConversationScope } from './types'
import { buildActiveDocumentContext } from './documentActions'
import { useMode } from '../../stores/useMode'
import { useDesignSession } from '../../stores/useDesignSession'
import { coerceDesignLayoutDigest, formatDesignLayoutDigest, type DesignLayoutDigest } from '../../../shared/design-agent'

export type MultimodalBlock = { type: 'text' | 'image' | 'video'; text?: string; base64?: string; mimeType?: string }

function normalizeAttachmentType(value: unknown): ChatAttachment['type'] {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'image') return 'image'
  if (normalized === 'video') return 'video'
  if (normalized === 'text') return 'text'
  if (normalized === 'spreadsheet') return 'spreadsheet'
  return 'other'
}

function normalizeAttachmentSource(value: unknown): ChatAttachment['source'] {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'browser-tab') return 'browser-tab'
  if (normalized === 'skill-folder') return 'skill-folder'
  if (normalized === 'design-project') return 'design-project'
  if (normalized === 'file') return 'file'
  return 'channel'
}

export function extractAttachmentsFromMeta(meta?: Record<string, unknown>): ChatAttachment[] | undefined {
  const raw = meta?.attachments
  if (!Array.isArray(raw) || raw.length === 0) return undefined

  const attachments = raw
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const name = String(record.name || '').trim()
      const path = String(record.path || '').trim()
      if (!name || !path) return null
      return {
        id: String(record.id || `remote-attachment-${index}`),
        name,
        path,
        type: normalizeAttachmentType(record.type),
        size: Number(record.size || 0),
        ext: String(record.ext || ''),
        source: normalizeAttachmentSource(record.source),
        url: typeof record.url === 'string' ? record.url : undefined,
        dirty: typeof record.dirty === 'boolean' ? record.dirty : undefined,
        saveStatus: typeof record.saveStatus === 'string' ? record.saveStatus : undefined,
        snapshotHash: typeof record.snapshotHash === 'string' ? record.snapshotHash : undefined,
        selectionSummary: typeof record.selectionSummary === 'string' ? record.selectionSummary : undefined,
        selectedElementCount: typeof record.selectedElementCount === 'number' ? Number(record.selectedElementCount) : undefined,
        selectionBounds: record.selectionBounds && typeof record.selectionBounds === 'object'
          ? record.selectionBounds as ChatAttachment['selectionBounds']
          : undefined,
        currentToolContext: typeof record.currentToolContext === 'string' ? record.currentToolContext : undefined,
        layoutDigest: coerceDesignLayoutDigest(record.layoutDigest),
        latestReviewSummary: typeof record.latestReviewSummary === 'string' ? record.latestReviewSummary : undefined,
        repairScope: typeof record.repairScope === 'string' ? record.repairScope as ChatAttachment['repairScope'] : undefined,
      }
    })
    .filter(Boolean) as ChatAttachment[]

  return attachments.length > 0 ? attachments : undefined
}

function formatBrowserTabReference(payload: {
  name?: string
  title?: string
  url?: string
  heading?: string
  selection?: string
  excerpt?: string
}): string {
  const lines = [
    '### 浏览页面引用',
    `- 标题: ${payload.title || payload.name || '网页标签'}`,
    payload.url ? `- 链接: ${payload.url}` : null,
    payload.heading ? `- 主标题: ${payload.heading}` : null,
    payload.selection ? `- 当前选中文本: ${payload.selection.slice(0, 2400)}` : null,
    payload.excerpt ? `- 页面摘要: ${payload.excerpt.slice(0, 6000)}` : null,
  ].filter(Boolean)

  return lines.join('\n')
}

function formatDesignProjectReference(payload: {
  name?: string
  path?: string
  dirty?: boolean
  saveStatus?: string
  snapshotHash?: string
  selectionSummary?: string
  selectedElementCount?: number
  selectionBounds?: ChatAttachment['selectionBounds']
  currentToolContext?: string
  layoutDigest?: DesignLayoutDigest | null
  latestReviewSummary?: string
  repairScope?: ChatAttachment['repairScope']
}): string {
  const lines = [
    '### 当前设计画布上下文',
    `- 项目: ${payload.name || '设计草稿'}`,
    payload.path && payload.path.startsWith('/') ? `- 文件: ${payload.path}` : '- 文件: (未保存草稿)',
    payload.dirty ? '- 状态: 有未保存更改' : payload.saveStatus ? `- 状态: ${payload.saveStatus}` : null,
    payload.selectionSummary ? `- 选择状态: ${payload.selectionSummary}` : null,
    typeof payload.selectedElementCount === 'number' ? `- 选择元素数: ${payload.selectedElementCount}` : null,
    payload.selectionBounds ? `- 选择边界: (${payload.selectionBounds.x}, ${payload.selectionBounds.y}) ${payload.selectionBounds.w}x${payload.selectionBounds.h}` : null,
    payload.currentToolContext ? `- 当前工具: ${payload.currentToolContext}` : null,
    payload.snapshotHash ? `- 快照哈希: ${payload.snapshotHash}` : null,
    payload.latestReviewSummary ? `- 最近复查: ${payload.latestReviewSummary}` : null,
    payload.repairScope ? `- 修正范围: ${payload.repairScope}` : null,
    ...formatDesignLayoutDigest(payload.layoutDigest),
    '- 这是设计画布引用，不是文档；涉及封面、海报、版式、布局时应优先调用 design_* 工具。',
  ].filter(Boolean)

  return lines.join('\n')
}

export function buildActiveDesignContext(): string | null {
  const mode = useMode.getState().workbenchMode
  if (mode !== 'design') return null

  const designState = useDesignSession.getState()
  const lines = [
    '### 当前设计画布上下文',
    `- 项目: ${designState.activeFile?.split(/[\\/]/).pop() || '设计草稿'}`,
    designState.activeFile ? `- 文件: ${designState.activeFile}` : '- 文件: (未保存草稿)',
    designState.isDirty ? '- 状态: 有未保存更改' : designState.saveStatus ? `- 状态: ${designState.saveStatus}` : null,
    designState.selectionSummary ? `- 选择状态: ${designState.selectionSummary}` : null,
    typeof designState.selectedElementCount === 'number' ? `- 选择元素数: ${designState.selectedElementCount}` : null,
    designState.selectionBounds ? `- 选择边界: (${designState.selectionBounds.x}, ${designState.selectionBounds.y}) ${designState.selectionBounds.w}x${designState.selectionBounds.h}` : null,
    designState.currentToolContext ? `- 当前工具: ${designState.currentToolContext}` : null,
    designState.snapshotHash ? `- 快照哈希: ${designState.snapshotHash}` : null,
    designState.latestReviewSummary ? `- 最近复查: ${designState.latestReviewSummary}` : null,
    designState.repairScope ? `- 修正范围: ${designState.repairScope}` : null,
    ...formatDesignLayoutDigest(designState.layoutDigest),
    '- 这是设计画布上下文，不是文档编辑上下文；如果用户要新建封面、海报、版式或视觉框架，应优先调用 design_* 工具。',
  ].filter(Boolean)

  return lines.join('\n')
}

export async function persistMessage(
  conversationId: string,
  id: string,
  role: string,
  content: string,
  meta?: Record<string, unknown>,
) {
  if (typeof window === 'undefined' || !window.electronAPI?.chat) return
  try {
    await window.electronAPI.chat.saveMessage({
      id,
      conversationId,
      role,
      content,
      timestamp: new Date().toISOString(),
      meta,
    })
  } catch {
    /* ignore persistence errors */
  }
}

export function serializePersistedAttachments(attachments: ChatAttachment[]): Array<Record<string, unknown>> {
  return attachments
    .filter((attachment) => {
      if (!attachment?.path || !attachment.name) return false
      if (attachment.source === 'browser-tab') return false
      if (attachment.source === 'skill-folder') return false
      return true
    })
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      type: attachment.type,
      size: attachment.size,
      ext: attachment.ext,
      source: attachment.source,
      url: attachment.url,
      dirty: attachment.dirty,
      saveStatus: attachment.saveStatus,
      snapshotHash: attachment.snapshotHash,
      selectionSummary: attachment.selectionSummary,
      selectedElementCount: attachment.selectedElementCount,
      selectionBounds: attachment.selectionBounds,
      currentToolContext: attachment.currentToolContext,
      layoutDigest: attachment.layoutDigest,
      latestReviewSummary: attachment.latestReviewSummary,
      repairScope: attachment.repairScope,
    }))
}

export async function persistAssistantMessage(
  scopeId: string,
  responseMessageId: string,
  content: string,
  scope: ConversationScope | null,
): Promise<void> {
  if (!content.trim()) return
  await persistMessage(scopeId, responseMessageId, 'assistant', content, {
    sourceKind: scope?.sourceKind || 'local',
    sourceId: scope?.sourceId || 'app',
    threadKey: scope?.threadKey || scopeId,
    direction: 'assistant-output',
  })
}

function appendTextBlock(target: string | MultimodalBlock[], text: string): string | MultimodalBlock[] {
  if (typeof target === 'string') return `${target}${text}`
  target.push({ type: 'text', text })
  return target
}

export async function buildComposedAgentInput(params: {
  content: string
  attachments: ChatAttachment[]
  filePool: ChatAttachment[]
}): Promise<string | MultimodalBlock[]> {
  const { content, attachments, filePool } = params
  const activeDocContext = buildActiveDocumentContext()
  const activeDesignContext = buildActiveDesignContext()
  const activeWorkbenchContext = activeDesignContext || activeDocContext
  const baseUserMessage = activeWorkbenchContext ? `${content}\n\n${activeWorkbenchContext}` : content
  let finalMessage: string | MultimodalBlock[] = baseUserMessage

  if (typeof window === 'undefined' || !window.electronAPI) {
    return finalMessage
  }

  const aiConfigRes = await window.electronAPI.settings.getAIConfig().catch(() => ({ success: false } as const))
  const aiConfig = aiConfigRes.success ? aiConfigRes.data : null
  const normalizedBaseUrl = aiConfig?.baseUrl?.replace(/\/+$/, '') || ''
  const isKimiCoding = !!aiConfig && normalizedBaseUrl.includes('api.kimi.com/coding')
  const supportsNativeVideo = !!aiConfig && (isKimiCoding || (aiConfig.provider !== 'anthropic' && !normalizedBaseUrl.includes('/coding')))

  if (attachments.length > 0) {
    const blocks: MultimodalBlock[] = []
    if (baseUserMessage) blocks.push({ type: 'text', text: baseUserMessage })

    for (const att of attachments) {
      try {
        if (att.source === 'skill-folder') {
          const skillLines = [
            '### 技能目录引用',
            `- 名称: ${att.name}`,
            att.skillId ? `- skillId: ${att.skillId}` : null,
            `- 路径: ${att.skillFolderPath || att.path}`,
            '如果需要立即执行，可使用命令：/skill <skillId> <action> <JSON参数>',
          ].filter(Boolean)
          blocks.push({ type: 'text', text: `\n\n${skillLines.join('\n')}` })
          continue
        }

        if (att.source === 'browser-tab') {
          let snapshot = {
            title: att.title || att.name,
            url: att.url || att.path,
            heading: att.heading || '',
            selection: att.selection || '',
            excerpt: att.excerpt || '',
          }

          if (window.electronAPI.browser?.getTabContext && att.browserTabId) {
            const contextResult = await window.electronAPI.browser.getTabContext(att.browserTabId)
            if (contextResult.success && contextResult.data) {
              snapshot = {
                title: contextResult.data.title || snapshot.title,
                url: contextResult.data.url || snapshot.url,
                heading: contextResult.data.heading || snapshot.heading,
                selection: contextResult.data.selection || snapshot.selection,
                excerpt: contextResult.data.excerpt || snapshot.excerpt,
              }
            }
          }

          blocks.push({
            type: 'text',
            text: `\n\n${formatBrowserTabReference({
              name: att.name,
              title: snapshot.title,
              url: snapshot.url,
              heading: snapshot.heading,
              selection: snapshot.selection,
              excerpt: snapshot.excerpt,
            })}`,
          })
          continue
        }

        if (att.source === 'design-project') {
          blocks.push({
            type: 'text',
            text: `\n\n${formatDesignProjectReference({
              name: att.name,
              path: att.path,
              dirty: att.dirty,
              saveStatus: att.saveStatus,
              snapshotHash: att.snapshotHash,
              selectionSummary: att.selectionSummary,
              currentToolContext: att.currentToolContext,
              layoutDigest: att.layoutDigest,
            })}`,
          })
          continue
        }

        if (att.type === 'video' && !supportsNativeVideo) {
          blocks.push({
            type: 'text',
            text: `\n\n--- 附件: ${att.name} ---\n[当前模型接口暂不支持原生视频输入，已自动降级为文件描述]\n本地视频路径: ${att.path}`,
          })
          continue
        }

        const fileResult = await window.electronAPI.chat.readFileForAI(att.path)
        if (fileResult.success && fileResult.data) {
          if (fileResult.data.type === 'image' && fileResult.data.base64) {
            blocks.push({ type: 'image', base64: fileResult.data.base64, mimeType: fileResult.data.mimeType || 'image/png' })
          } else if (fileResult.data.type === 'video' && fileResult.data.base64) {
            blocks.push({ type: 'video', base64: fileResult.data.base64, mimeType: fileResult.data.mimeType || 'video/mp4' })
          } else if (fileResult.data.type === 'text') {
            blocks.push({
              type: 'text',
              text: `\n\n--- 附件: ${att.name} ---\n- 路径: ${att.path}\n${fileResult.data.content?.slice(0, 10000) || ''}`,
            })
          }
        }
      } catch {
        /* skip failed files */
      }
    }

    const hasMediaBlocks = blocks.some((b) => b.type === 'image' || b.type === 'video')
    finalMessage = hasMediaBlocks ? blocks : blocks.map((b) => b.text || '').join('')
  }

  const atRefs = content.match(/@\[([^\]]+)\]/g)
  if (atRefs && filePool.length > 0) {
    for (const ref of atRefs) {
      const fileName = ref.slice(2, -1)
      const poolFile = filePool.find((f) => f.name === fileName)
      if (!poolFile) continue
      try {
        if (poolFile.source === 'skill-folder') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n--- 引用技能目录: ${poolFile.name} ---\n路径: ${poolFile.skillFolderPath || poolFile.path}\n${poolFile.skillId ? `skillId: ${poolFile.skillId}\n` : ''}可使用 /skill 命令执行相关动作。`,
          )
          continue
        }

        if (poolFile.source === 'browser-tab') {
          let snapshot = {
            title: poolFile.title || poolFile.name,
            url: poolFile.url || poolFile.path,
            heading: poolFile.heading || '',
            selection: poolFile.selection || '',
            excerpt: poolFile.excerpt || '',
          }

          if (window.electronAPI.browser?.getTabContext && poolFile.browserTabId) {
            const contextResult = await window.electronAPI.browser.getTabContext(poolFile.browserTabId)
            if (contextResult.success && contextResult.data) {
              snapshot = {
                title: contextResult.data.title || snapshot.title,
                url: contextResult.data.url || snapshot.url,
                heading: contextResult.data.heading || snapshot.heading,
                selection: contextResult.data.selection || snapshot.selection,
                excerpt: contextResult.data.excerpt || snapshot.excerpt,
              }
            }
          }

          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n--- 引用网页: ${poolFile.name} ---\n${formatBrowserTabReference({
              name: poolFile.name,
              title: snapshot.title,
              url: snapshot.url,
              heading: snapshot.heading,
              selection: snapshot.selection,
              excerpt: snapshot.excerpt,
            })}`,
          )
          continue
        }

        if (poolFile.source === 'design-project') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n--- 引用设计项目: ${poolFile.name} ---\n${formatDesignProjectReference({
              name: poolFile.name,
              path: poolFile.path,
              dirty: poolFile.dirty,
              saveStatus: poolFile.saveStatus,
              snapshotHash: poolFile.snapshotHash,
              selectionSummary: poolFile.selectionSummary,
              currentToolContext: poolFile.currentToolContext,
              layoutDigest: poolFile.layoutDigest,
            })}`,
          )
          continue
        }

        const fileResult = await window.electronAPI.chat.readFileForAI(poolFile.path)
        if (fileResult.success && fileResult.data && fileResult.data.type === 'text') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n--- 引用文件: ${fileName} ---\n- 路径: ${poolFile.path}\n${fileResult.data.content?.slice(0, 10000) || ''}`,
          )
        }
      } catch {
        /* skip */
      }
    }
  }

  return finalMessage
}

export function createArtifactReference(path: string, artifact?: AgentArtifact | null): AgentArtifact[] {
  return artifact ? [artifact] : []
}
