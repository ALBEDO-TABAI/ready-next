import type { ChatAttachment, ConversationScope } from './types'
import { buildActiveDocumentContext } from './documentActions'
import { useMode } from '../../stores/useMode'

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
  if (normalized === 'document-quote') return 'document-quote'
  if (normalized === 'document-widget-target') return 'document-widget-target'
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
        isDirectory: Boolean(record.isDirectory),
        size: Number(record.size || 0),
        ext: String(record.ext || ''),
        source: normalizeAttachmentSource(record.source),
        url: typeof record.url === 'string' ? record.url : undefined,
        title: typeof record.title === 'string' ? record.title : undefined,
        documentTitle: typeof record.documentTitle === 'string' ? record.documentTitle : undefined,
        widgetTitle: typeof record.widgetTitle === 'string' ? record.widgetTitle : undefined,
        widgetCode: typeof record.widgetCode === 'string' ? record.widgetCode : undefined,
        widgetMode: typeof record.widgetMode === 'string' ? record.widgetMode : undefined,
        selection: typeof record.selection === 'string' ? record.selection : undefined,
        lineStart: typeof record.lineStart === 'number' ? Number(record.lineStart) : undefined,
        lineEnd: typeof record.lineEnd === 'number' ? Number(record.lineEnd) : undefined,
        sectionTitle: typeof record.sectionTitle === 'string' ? record.sectionTitle : undefined,
        dirty: typeof record.dirty === 'boolean' ? record.dirty : undefined,
        saveStatus: typeof record.saveStatus === 'string' ? record.saveStatus : undefined,
        snapshotHash: typeof record.snapshotHash === 'string' ? record.snapshotHash : undefined,
        selectionSummary: typeof record.selectionSummary === 'string' ? record.selectionSummary : undefined,
        selectedElementCount: typeof record.selectedElementCount === 'number' ? Number(record.selectedElementCount) : undefined,
        selectionBounds: record.selectionBounds && typeof record.selectionBounds === 'object'
          ? record.selectionBounds as ChatAttachment['selectionBounds']
          : undefined,
        currentToolContext: typeof record.currentToolContext === 'string' ? record.currentToolContext : undefined,
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

function formatDocumentQuoteReference(payload: {
  name: string
  path: string
  title?: string
  sectionTitle?: string
  lineStart?: number
  lineEnd?: number
  selection?: string
}): string {
  const lineLabel = payload.lineStart && payload.lineEnd
    ? payload.lineStart === payload.lineEnd
      ? `第 ${payload.lineStart} 行`
      : `第 ${payload.lineStart}-${payload.lineEnd} 行`
    : null

  return [
    '### 文档引用',
    `- 文档: ${payload.title || payload.name}`,
    `- 路径: ${payload.path}`,
    payload.sectionTitle ? `- 章节: ${payload.sectionTitle}` : null,
    lineLabel ? `- 位置: ${lineLabel}` : null,
    payload.selection ? '' : null,
    payload.selection ? '```quote' : null,
    payload.selection ? payload.selection.slice(0, 5000) : null,
    payload.selection ? '```' : null,
  ].filter(Boolean).join('\n')
}

function formatDocumentWidgetTargetReference(payload: {
  name: string
  path: string
  documentTitle?: string
  widgetTitle?: string
  widgetCode?: string
  widgetMode?: string
}): string {
  return [
    '### Widget 更新上下文',
    `- 文档: ${payload.documentTitle || '(未保存草稿)'}`,
    `- 路径: ${payload.path}`,
    `- 目标 widget: ${payload.widgetTitle || payload.name}`,
    payload.widgetMode ? `- 当前模式: ${payload.widgetMode}` : null,
    '- 约束: 这是现有 widget 更新入口。优先使用 document_update_widget，不要新增第二个同类 widget，修改后保存文档。',
    '',
    '```show-widget',
    JSON.stringify({
      title: payload.widgetTitle || payload.name,
      widget_code: payload.widgetCode || '',
    }),
    '```',
  ].filter(Boolean).join('\n')
}

function formatFolderReference(payload: {
  name: string
  path: string
}): string {
  return [
    '### 文件夹引用',
    `- 名称: ${payload.name}`,
    `- 路径: ${payload.path}`,
    '- 用途: 如果要读取或产出文件，请基于这个目录路径继续定位具体文件。',
  ].join('\n')
}

/**
 * Build lightweight environment context (no task prompts)
 * This provides environment information only, not task instructions
 */
export function buildEnvironmentContext(): string | null {
  const mode = useMode.getState().workbenchMode
  if (mode === 'browser') return null

  const contexts: string[] = []

  // Document mode environment info
  if (mode === 'document') {
    contexts.push([
      '## 环境信息',
      '- 当前模式: 文档模式',
    ].join('\n'))
  }

  return contexts.length > 0 ? contexts.join('\n\n') : null
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
      isDirectory: attachment.isDirectory,
      size: attachment.size,
      ext: attachment.ext,
      source: attachment.source,
      url: attachment.url,
      title: attachment.title,
      documentTitle: attachment.documentTitle,
      widgetTitle: attachment.widgetTitle,
      widgetCode: attachment.widgetCode,
      widgetMode: attachment.widgetMode,
      selection: attachment.selection,
      lineStart: attachment.lineStart,
      lineEnd: attachment.lineEnd,
      sectionTitle: attachment.sectionTitle,
    }))
}

export async function persistAssistantMessage(
  scopeId: string,
  responseMessageId: string,
  content: string,
  scope: ConversationScope | null,
  extraMeta?: Record<string, unknown>,
): Promise<void> {
  if (!content.trim()) return
  await persistMessage(scopeId, responseMessageId, 'assistant', content, {
    sourceKind: scope?.sourceKind || 'local',
    sourceId: scope?.sourceId || 'app',
    threadKey: scope?.threadKey || scopeId,
    direction: 'assistant-output',
    ...(extraMeta || {}),
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
  const environmentContext = buildEnvironmentContext()
  const activeWorkbenchContext = activeDocContext || environmentContext
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
            '如果需要执行这个 skill，请优先直接调用真实的 `skill_* / skill_get_state / skill_submit_*` 工具，不要把 `/skill ...` 当作普通文本回复。',
          ].filter(Boolean)
          blocks.push({ type: 'text', text: `\n\n${skillLines.join('\n')}` })
          continue
        }

        if (att.source === 'document-quote') {
          blocks.push({
            type: 'text',
            text: `\n\n${formatDocumentQuoteReference({
              name: att.name,
              path: att.path,
              title: att.title,
              sectionTitle: att.sectionTitle,
              lineStart: att.lineStart,
              lineEnd: att.lineEnd,
              selection: att.selection,
            })}`,
          })
          continue
        }

        if (att.source === 'document-widget-target') {
          blocks.push({
            type: 'text',
            text: `\n\n${formatDocumentWidgetTargetReference({
              name: att.name,
              path: att.path,
              documentTitle: att.documentTitle,
              widgetTitle: att.widgetTitle,
              widgetCode: att.widgetCode,
              widgetMode: att.widgetMode,
            })}`,
          })
          continue
        }

        if (att.isDirectory) {
          blocks.push({
            type: 'text',
            text: `\n\n${formatFolderReference({
              name: att.name,
              path: att.path,
            })}`,
          })
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
      const poolFile = [...filePool].reverse().find((f) => f.name === fileName)
      if (!poolFile) continue
      try {
        if (poolFile.source === 'skill-folder') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n--- 引用技能目录: ${poolFile.name} ---\n路径: ${poolFile.skillFolderPath || poolFile.path}\n${poolFile.skillId ? `skillId: ${poolFile.skillId}\n` : ''}如果需要执行它，请优先直接调用真实的 skill_* 工具，不要只输出 /skill 文本命令。`,
          )
          continue
        }

        if (poolFile.isDirectory) {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n${formatFolderReference({
              name: poolFile.name,
              path: poolFile.path,
            })}`,
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

        if (poolFile.source === 'document-widget-target') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n${formatDocumentWidgetTargetReference({
              name: poolFile.name,
              path: poolFile.path,
              documentTitle: poolFile.documentTitle,
              widgetTitle: poolFile.widgetTitle,
              widgetCode: poolFile.widgetCode,
              widgetMode: poolFile.widgetMode,
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
        } else {
          finalMessage = appendTextBlock(
            finalMessage,
            [
              `\n\n--- 引用文件: ${fileName} ---`,
              `- 类型: ${poolFile.type}`,
              `- 路径: ${poolFile.path}`,
              poolFile.type === 'video' || poolFile.type === 'image'
                ? '- 如果需要调用技能、脚本或文档工具，请优先使用这个本地路径作为输入。'
                : '',
            ].filter(Boolean).join('\n'),
          )
        }
      } catch {
        /* skip */
      }
    }
  }

  return finalMessage
}
