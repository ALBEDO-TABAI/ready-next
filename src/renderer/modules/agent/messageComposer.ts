import type { ChatAttachment, ConversationScope } from './types'
import { buildActiveDocumentContext } from './documentActions'
import { useMode } from '../../stores/useMode'
import { refreshDocumentWidgetTargetSnapshot } from './widget-target-attachment'
import {
  normalizeProviderId,
  resolveAIConfigCapabilities,
  type AIModelConfig,
} from '../../../shared/ai-providers'

export type MultimodalBlock = { type: 'text' | 'image' | 'video'; text?: string; base64?: string; mimeType?: string }

export interface AttachmentInputFailure {
  id: string
  name: string
  path: string
  reason: string
}

export interface ComposedAgentInputDiagnostics {
  inputIncludedCount: number
  inputFailedCount: number
  inputFailures: AttachmentInputFailure[]
}

export interface ComposedAgentInputResult {
  message: string | MultimodalBlock[]
  diagnostics: ComposedAgentInputDiagnostics
}

interface RendererAIConfigForCapabilities {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  modelIds?: string[]
  displayName?: string
  agentProtocol?: 'anthropic' | 'openai'
  wireApi?: 'chat/completions' | 'responses'
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  toolUseMode?: 'auto' | 'on' | 'off'
  visionMode?: 'auto' | 'on' | 'off'
  nativeVideoMode?: 'auto' | 'on' | 'off'
  endpointId?: string
}

function normalizeRendererAIConfigForCapabilities(config: RendererAIConfigForCapabilities | null | undefined): AIModelConfig | null {
  if (!config) return null
  const provider = normalizeProviderId(config.provider, config.baseUrl)
  if (!provider) return null
  return {
    provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    modelIds: config.modelIds,
    agentProtocol: config.agentProtocol,
    wireApi: config.wireApi,
    reasoningEffort: config.reasoningEffort,
    toolUseMode: config.toolUseMode,
    visionMode: config.visionMode,
    nativeVideoMode: config.nativeVideoMode,
    endpointId: config.endpointId,
    displayName: config.displayName,
  }
}

function shouldKeepDocumentWidgetTargetAttachment(content: string, attachment: ChatAttachment): { kept: boolean; reason: string } {
  const normalized = content.trim()
  if (!normalized) return { kept: false, reason: 'empty_content' }

  const widgetTitle = String(attachment.widgetTitle || attachment.title || attachment.name || '').trim()
  if (widgetTitle && normalized.toLowerCase().includes(widgetTitle.toLowerCase())) {
    return { kept: true, reason: 'title_mention' }
  }

  if (/更新当前文档里的\s+.+widget[:：]?/i.test(normalized)) {
    return { kept: true, reason: 'widget_phrase' }
  }

  const hasWidgetSubject = /(widget|show-widget|卡片|信息卡|图表|组件)/i.test(normalized)
  const hasEditVerb = /(更新|修改|调整|优化|替换|删除|新增|插入|改|去掉|拿掉|补上|统一|恢复|重写|保存|修正|恢复|还原|找回|回到|对齐)/i.test(normalized)
  if (hasWidgetSubject && hasEditVerb) {
    return { kept: true, reason: 'subject_and_verb' }
  }

  if (/^(再|继续|把|让|统一|改|调整|优化|去掉|移除|淡一点|浅一点|更.*一点|收紧|拉开|简化|原本|重新|回到|还原|对齐)/.test(normalized)) {
    return { kept: true, reason: 'pronoun_prefix' }
  }

  if (/(原本|之前|上一次|先前|刚才).{0,16}(设计|风格|尺寸|样式|大小|布局|丢了|没了|掉了|乱了|错了)/.test(normalized)) {
    return { kept: true, reason: 'meta_correction' }
  }

  return { kept: false, reason: 'no_match' }
}

export function filterAttachmentsForComposedAgentInput(content: string, attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments
    .map((attachment) => {
      if (attachment.source !== 'document-widget-target') return attachment
      const verdict = shouldKeepDocumentWidgetTargetAttachment(content, attachment)
      try {
        const widgetTitle = String(attachment.widgetTitle || attachment.title || attachment.name || '').trim()
        console.debug('[widget_sticky]', JSON.stringify({
          kept: verdict.kept,
          reason: verdict.reason,
          widgetTitle,
          widgetId: attachment.widgetId || null,
          tabId: attachment.tabId || null,
          contentPreview: content.trim().slice(0, 120),
        }))
      } catch { /* debug log is advisory */ }
      if (!verdict.kept) return null
      return refreshDocumentWidgetTargetSnapshot(attachment)
    })
    .filter((attachment): attachment is ChatAttachment => Boolean(attachment))
}

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
  if (normalized === 'document-tab') return 'document-tab'
  if (normalized === 'document-quote') return 'document-quote'
  if (normalized === 'document-widget-target') return 'document-widget-target'
  if (normalized === 'calendar-event') return 'calendar-event'
  if (normalized === 'generated-image') return 'generated-image'
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
        tabId: typeof record.tabId === 'string' ? record.tabId : undefined,
        widgetTitle: typeof record.widgetTitle === 'string' ? record.widgetTitle : undefined,
        widgetId: typeof record.widgetId === 'string' ? record.widgetId : undefined,
        widgetCode: typeof record.widgetCode === 'string' ? record.widgetCode : undefined,
        widgetMode: typeof record.widgetMode === 'string' ? record.widgetMode : undefined,
        selection: typeof record.selection === 'string' ? record.selection : undefined,
        lineStart: typeof record.lineStart === 'number' ? Number(record.lineStart) : undefined,
        lineEnd: typeof record.lineEnd === 'number' ? Number(record.lineEnd) : undefined,
        sectionTitle: typeof record.sectionTitle === 'string' ? record.sectionTitle : undefined,
        excerpt: typeof record.excerpt === 'string' ? record.excerpt : undefined,
        eventId: typeof record.eventId === 'string' ? record.eventId : undefined,
        startTime: typeof record.startTime === 'string' ? record.startTime : undefined,
        endTime: typeof record.endTime === 'string' ? record.endTime : undefined,
        calendarId: typeof record.calendarId === 'string' ? record.calendarId : undefined,
        description: typeof record.description === 'string' ? record.description : undefined,
        location: typeof record.location === 'string' ? record.location : undefined,
        allDay: typeof record.allDay === 'boolean' ? record.allDay : undefined,
        contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
        platform: Array.isArray(record.platform)
          ? record.platform.filter((item): item is string => typeof item === 'string')
          : typeof record.platform === 'string'
            ? record.platform
            : undefined,
        publishStatus: typeof record.publishStatus === 'string' ? record.publishStatus : undefined,
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

function formatDocumentTabReference(payload: {
  name: string
  path: string
  title?: string
  excerpt?: string
  dirty?: boolean
  saveStatus?: string
}): string {
  const content = String(payload.excerpt || '').trim()
  return [
    `--- 引用文件: ${payload.title || payload.name} ---`,
    `- 路径: ${payload.path}`,
    '- 来源: 文档标签页',
    payload.dirty ? '- 状态: 有未保存修改' : payload.saveStatus ? `- 状态: ${payload.saveStatus}` : null,
    content ? '' : null,
    content ? '--- 文档内容开始 ---' : null,
    content ? content.slice(0, 12000) : null,
    content ? '--- 文档内容结束 ---' : null,
  ].filter(Boolean).join('\n')
}

function formatDocumentWidgetTargetReference(payload: {
  name: string
  path: string
  documentTitle?: string
  tabId?: string
  widgetTitle?: string
  widgetId?: string
  widgetCode?: string
  widgetMode?: string
}): string {
  return [
    '### Widget 更新上下文',
    `- 文档: ${payload.documentTitle || '(未保存草稿)'}`,
    `- 路径: ${payload.path}`,
    payload.tabId ? `- 标签页ID: ${payload.tabId}` : null,
    `- 目标 widget: ${payload.widgetTitle || payload.name}`,
    payload.widgetId ? `- widgetId: ${payload.widgetId}` : null,
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

function formatCalendarEventReference(payload: {
  title?: string
  name?: string
  eventId?: string
  startTime?: string
  endTime?: string
  calendarId?: string
  description?: string
  location?: string
  allDay?: boolean
  contentType?: string
  platform?: string[] | string
  publishStatus?: string
}): string {
  const platform = Array.isArray(payload.platform)
    ? payload.platform.join(', ')
    : String(payload.platform || '').trim()
  return [
    '### 日程事件引用',
    `- 标题: ${payload.title || payload.name || '日程'}`,
    payload.eventId ? `- eventId: ${payload.eventId}` : null,
    payload.startTime || payload.endTime ? `- 时间: ${payload.startTime || '?'} - ${payload.endTime || '?'}` : null,
    payload.calendarId ? `- 日历: ${payload.calendarId}` : null,
    payload.location ? `- 地点: ${payload.location}` : null,
    typeof payload.allDay === 'boolean' ? `- 全天: ${payload.allDay ? '是' : '否'}` : null,
    payload.contentType ? `- 类型: ${payload.contentType}` : null,
    platform ? `- 平台: ${platform}` : null,
    payload.publishStatus ? `- 状态: ${payload.publishStatus}` : null,
    payload.description ? `- 备注: ${payload.description.slice(0, 2000)}` : null,
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
): Promise<{ success: boolean; error?: string }> {
  if (typeof window === 'undefined' || !window.electronAPI?.chat) {
    return { success: false, error: 'chat ipc unavailable' }
  }
  try {
    const result = await window.electronAPI.chat.saveMessage({
      id,
      conversationId,
      role,
      content,
      timestamp: new Date().toISOString(),
      meta,
    })
    if (!result?.success) {
      return { success: false, error: result?.error || 'message persist failed' }
    }
    return { success: true }
  } catch {
    return { success: false, error: 'message persist failed' }
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
      tabId: attachment.tabId,
      widgetTitle: attachment.widgetTitle,
      widgetId: attachment.widgetId,
      widgetCode: attachment.widgetCode,
      widgetMode: attachment.widgetMode,
      selection: attachment.selection,
      lineStart: attachment.lineStart,
      lineEnd: attachment.lineEnd,
      sectionTitle: attachment.sectionTitle,
      excerpt: attachment.excerpt,
      eventId: attachment.eventId,
      startTime: attachment.startTime,
      endTime: attachment.endTime,
      calendarId: attachment.calendarId,
      description: attachment.description,
      location: attachment.location,
      allDay: attachment.allDay,
      contentType: attachment.contentType,
      platform: attachment.platform,
      publishStatus: attachment.publishStatus,
    }))
}

export async function persistAssistantMessage(
  scopeId: string,
  responseMessageId: string,
  content: string,
  scope: ConversationScope | null,
  extraMeta?: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  if (!content.trim()) return { success: true }
  return persistMessage(scopeId, responseMessageId, 'assistant', content, {
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
  return (await buildComposedAgentInputWithDiagnostics(params)).message
}

export async function buildComposedAgentInputWithDiagnostics(params: {
  content: string
  attachments: ChatAttachment[]
  filePool: ChatAttachment[]
}): Promise<ComposedAgentInputResult> {
  const { content, attachments, filePool } = params
  const effectiveAttachments = filterAttachmentsForComposedAgentInput(content, attachments)
  const diagnostics: ComposedAgentInputDiagnostics = {
    inputIncludedCount: 0,
    inputFailedCount: 0,
    inputFailures: [],
  }
  const markIncluded = () => {
    diagnostics.inputIncludedCount += 1
  }
  const markFailed = (att: ChatAttachment, reason: string) => {
    diagnostics.inputFailedCount += 1
    diagnostics.inputFailures.push({
      id: att.id,
      name: att.name,
      path: att.path,
      reason,
    })
  }
  const activeDocContext = buildActiveDocumentContext()
  const environmentContext = buildEnvironmentContext()
  const activeWorkbenchContext = activeDocContext || environmentContext
  const baseUserMessage = activeWorkbenchContext ? `${content}\n\n${activeWorkbenchContext}` : content
  let finalMessage: string | MultimodalBlock[] = baseUserMessage

  if (typeof window === 'undefined' || !window.electronAPI) {
    return { message: finalMessage, diagnostics }
  }

  const aiConfigRes = window.electronAPI.settings?.getAIConfig
    ? await window.electronAPI.settings.getAIConfig().catch(() => ({ success: false } as const))
    : ({ success: false } as const)
  const aiConfig = aiConfigRes.success ? aiConfigRes.data : null
  const capabilities = resolveAIConfigCapabilities(normalizeRendererAIConfigForCapabilities(aiConfig))
  const supportsNativeVideo = capabilities?.supportsNativeVideo === true

  if (effectiveAttachments.length > 0) {
    const blocks: MultimodalBlock[] = []
    if (baseUserMessage) blocks.push({ type: 'text', text: baseUserMessage })

    for (const att of effectiveAttachments) {
      try {
        if (att.source === 'skill-folder') {
          const skillLines = [
            '### 技能目录引用',
            `- 名称: ${att.name}`,
            att.skillId ? `- skillId: ${att.skillId}` : null,
            '- 状态: 已安装到 Ready 托管区；不要把它当作普通 workspace 文件路径读取。',
            '如果需要执行这个 skill，请优先直接调用当前工具列表里真实存在的 `skill_*` 工具，不要把 `/skill ...` 当作普通文本回复。',
          ].filter(Boolean)
          blocks.push({ type: 'text', text: `\n\n${skillLines.join('\n')}` })
          markIncluded()
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
          markIncluded()
          continue
        }

        if (att.source === 'document-tab') {
          blocks.push({
            type: 'text',
            text: `\n\n${formatDocumentTabReference({
              name: att.name,
              path: att.path,
              title: att.title || att.documentTitle,
              excerpt: att.excerpt,
              dirty: att.dirty,
              saveStatus: att.saveStatus,
            })}`,
          })
          markIncluded()
          continue
        }

        if (att.source === 'document-widget-target') {
          blocks.push({
            type: 'text',
            text: `\n\n${formatDocumentWidgetTargetReference({
              name: att.name,
              path: att.path,
              documentTitle: att.documentTitle,
              tabId: att.tabId,
              widgetTitle: att.widgetTitle,
              widgetId: att.widgetId,
              widgetCode: att.widgetCode,
              widgetMode: att.widgetMode,
            })}`,
          })
          markIncluded()
          continue
        }

        if (att.source === 'calendar-event') {
          blocks.push({
            type: 'text',
            text: `\n\n${formatCalendarEventReference({
              title: att.title,
              name: att.name,
              eventId: att.eventId,
              startTime: att.startTime,
              endTime: att.endTime,
              calendarId: att.calendarId,
              description: att.description,
              location: att.location,
              allDay: att.allDay,
              contentType: att.contentType,
              platform: att.platform,
              publishStatus: att.publishStatus,
            })}`,
          })
          markIncluded()
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
          markIncluded()
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
          markIncluded()
          continue
        }

        if (att.type === 'video' && !supportsNativeVideo) {
          blocks.push({
            type: 'text',
            text: `\n\n--- 附件: ${att.name} ---\n- 路径: ${att.path}\n- 类型: video\n[当前模型接口暂不支持原生视频输入，已自动降级为文件描述]`,
          })
          markIncluded()
          continue
        }

        const fileResult = await window.electronAPI.chat.readFileForAI(att.path)
        if (fileResult.success && fileResult.data) {
          if (fileResult.data.type === 'image' && fileResult.data.base64) {
            blocks.push({
              type: 'text',
              text: `\n\n--- 附件: ${att.name} ---\n- 路径: ${att.path}\n- 类型: image`,
            })
            blocks.push({ type: 'image', base64: fileResult.data.base64, mimeType: fileResult.data.mimeType || 'image/png' })
            markIncluded()
          } else if (fileResult.data.type === 'video' && fileResult.data.base64) {
            blocks.push({
              type: 'text',
              text: `\n\n--- 附件: ${att.name} ---\n- 路径: ${att.path}\n- 类型: video`,
            })
            blocks.push({ type: 'video', base64: fileResult.data.base64, mimeType: fileResult.data.mimeType || 'video/mp4' })
            markIncluded()
          } else if (fileResult.data.type === 'text') {
            blocks.push({
              type: 'text',
              text: `\n\n--- 附件: ${att.name} ---\n- 路径: ${att.path}\n${fileResult.data.content?.slice(0, 10000) || ''}`,
            })
            markIncluded()
          } else {
            markFailed(att, 'unsupported_file_result')
          }
        } else {
          markFailed(att, fileResult.error || 'read_file_failed')
        }
      } catch (error) {
        markFailed(att, error instanceof Error ? error.message : String(error))
      }
    }

    const hasMediaBlocks = blocks.some((b) => b.type === 'image' || b.type === 'video')
    finalMessage = hasMediaBlocks ? blocks : blocks.map((b) => b.text || '').join('')
  }

  const atRefs = content.match(/@\[([^\]]+)\]/g)
  if (atRefs && filePool.length > 0) {
    const isAlreadyAttached = (candidate: ChatAttachment) => effectiveAttachments.some((attachment) => (
      attachment.source === candidate.source &&
      attachment.path === candidate.path &&
      attachment.name === candidate.name
    ))

    for (const ref of atRefs) {
      const fileName = ref.slice(2, -1)
      const poolFile = [...filePool].reverse().find((f) => f.name === fileName)
      if (!poolFile) continue
      if (isAlreadyAttached(poolFile)) continue
      try {
        if (poolFile.source === 'skill-folder') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n--- 引用技能目录: ${poolFile.name} ---\n${poolFile.skillId ? `skillId: ${poolFile.skillId}\n` : ''}状态: 已安装到 Ready 托管区；不要把它当作普通 workspace 文件路径读取。\n如果需要执行它，请优先直接调用真实的 skill_* 工具，不要只输出 /skill 文本命令。`,
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
              tabId: poolFile.tabId,
              widgetTitle: poolFile.widgetTitle,
              widgetId: poolFile.widgetId,
              widgetCode: poolFile.widgetCode,
              widgetMode: poolFile.widgetMode,
            })}`,
          )
          continue
        }

        if (poolFile.source === 'document-quote') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n${formatDocumentQuoteReference({
              name: poolFile.name,
              path: poolFile.path,
              title: poolFile.title,
              sectionTitle: poolFile.sectionTitle,
              lineStart: poolFile.lineStart,
              lineEnd: poolFile.lineEnd,
              selection: poolFile.selection,
            })}`,
          )
          continue
        }

        if (poolFile.source === 'document-tab') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n${formatDocumentTabReference({
              name: poolFile.name,
              path: poolFile.path,
              title: poolFile.title || poolFile.documentTitle,
              excerpt: poolFile.excerpt,
              dirty: poolFile.dirty,
              saveStatus: poolFile.saveStatus,
            })}`,
          )
          continue
        }

        if (poolFile.source === 'calendar-event') {
          finalMessage = appendTextBlock(
            finalMessage,
            `\n\n${formatCalendarEventReference({
              title: poolFile.title,
              name: poolFile.name,
              eventId: poolFile.eventId,
              startTime: poolFile.startTime,
              endTime: poolFile.endTime,
              calendarId: poolFile.calendarId,
              description: poolFile.description,
              location: poolFile.location,
              allDay: poolFile.allDay,
              contentType: poolFile.contentType,
              platform: poolFile.platform,
              publishStatus: poolFile.publishStatus,
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

  return { message: finalMessage, diagnostics }
}
