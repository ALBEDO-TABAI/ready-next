import { buildToolParamSchema, normalizeAnthropicToolSchema, normalizeOpenAIToolSchema, type ToolParamSchemaSpec } from './tool-schema'
import { FEISHU_SCHEMAS } from './schemas/feishu-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

type ToolParam = ToolParamSchemaSpec

interface FeishuToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic'
  params: ToolParam[]
}

interface FeishuToolContext {
  sidecarManager?: {
    feishuDocRead: (channelId: string, docToken: string, docType: string) => Promise<Record<string, unknown>>
    feishuDocCreate: (channelId: string, title: string, docType: string, content: unknown, folderToken?: string) => Promise<Record<string, unknown>>
    feishuDocUpdate: (channelId: string, docToken: string, docType: string, updates: unknown) => Promise<Record<string, unknown>>
    feishuDocList: (channelId: string, folderToken?: string, docType?: string, limit?: number) => Promise<Record<string, unknown>>
    feishuMessageSend: (channelId: string, chatId: string, content: unknown, msgType: string) => Promise<Record<string, unknown>>
    feishuMessageGetContext: (channelId: string, chatId: string, limit?: number, startTime?: string, endTime?: string) => Promise<Record<string, unknown>>
    feishuMessageReply: (channelId: string, messageId: string, content: unknown, msgType: string) => Promise<Record<string, unknown>>
    feishuCalendarListEvents: (channelId: string, calendarId: string, startTime: string, endTime: string, limit?: number) => Promise<Record<string, unknown>>
    feishuCalendarCreateEvent: (channelId: string, event: Record<string, unknown>) => Promise<Record<string, unknown>>
    feishuCalendarUpdateEvent: (channelId: string, eventId: string, calendarId: string | undefined, updates: Record<string, unknown>) => Promise<Record<string, unknown>>
    feishuCalendarDeleteEvent: (channelId: string, eventId: string, calendarId?: string) => Promise<Record<string, unknown>>
    feishuChatList: (channelId: string, limit?: number) => Promise<Record<string, unknown>>
    feishuChatGetMembers: (channelId: string, chatId: string) => Promise<Record<string, unknown>>
    feishuChatGetInfo: (channelId: string, chatId: string) => Promise<Record<string, unknown>>
    feishuFileUpload: (channelId: string, filePath: string, fileType: string, parentToken?: string) => Promise<Record<string, unknown>>
    feishuFileDownload: (channelId: string, fileToken: string, savePath: string) => Promise<Record<string, unknown>>
  } | null
  channelId?: string
}

/**
 * Feishu Plugin Tools
 *
 * Provides comprehensive Feishu integration capabilities including:
 * - Document operations (read, create, update, list)
 * - Message operations (send, get context, reply)
 * - Calendar operations (list, create, update, delete events)
 * - Group chat operations (list, get members, get info)
 * - File operations (upload, download)
 */

const FEISHU_TOOLS: FeishuToolDef[] = [
  // ============================================================
  // Document Operations
  // ============================================================
  {
    name: 'feishu_doc_read',
    description: '读取飞书文档内容。支持飞书文档、电子表格、多维表格等。',
    action: 'feishu.docRead',
    intent: 'read_feishu_document',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_read) as ToolParam[],
  },
  {
    name: 'feishu_doc_create',
    description: '创建新的飞书文档。',
    action: 'feishu.docCreate',
    intent: 'create_feishu_document',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_create) as ToolParam[],
  },
  {
    name: 'feishu_doc_update',
    description: '更新飞书文档内容。',
    action: 'feishu.docUpdate',
    intent: 'update_feishu_document',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_update) as ToolParam[],
  },
  {
    name: 'feishu_doc_list',
    description: '列出可访问的飞书文档。',
    action: 'feishu.docList',
    intent: 'list_feishu_documents',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_list) as ToolParam[],
  },

  // ============================================================
  // Message Operations
  // ============================================================
  {
    name: 'feishu_message_send',
    description: '发送消息到飞书群聊或用户。',
    action: 'feishu.messageSend',
    intent: 'send_feishu_message',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_message_send) as ToolParam[],
  },
  {
    name: 'feishu_message_get_context',
    description: '获取飞书群聊的历史消息上下文。',
    action: 'feishu.messageGetContext',
    intent: 'get_feishu_message_context',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_message_get_context) as ToolParam[],
  },
  {
    name: 'feishu_message_reply',
    description: '回复飞书消息。',
    action: 'feishu.messageReply',
    intent: 'reply_feishu_message',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_message_reply) as ToolParam[],
  },

  // ============================================================
  // Calendar Operations
  // ============================================================
  {
    name: 'feishu_calendar_list_events',
    description: '列出飞书日历事件。',
    action: 'feishu.calendarListEvents',
    intent: 'list_feishu_calendar_events',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_list_events) as ToolParam[],
  },
  {
    name: 'feishu_calendar_create_event',
    description: '创建飞书日历事件。',
    action: 'feishu.calendarCreateEvent',
    intent: 'create_feishu_calendar_event',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_create_event) as ToolParam[],
  },
  {
    name: 'feishu_calendar_update_event',
    description: '更新飞书日历事件。',
    action: 'feishu.calendarUpdateEvent',
    intent: 'update_feishu_calendar_event',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_update_event) as ToolParam[],
  },
  {
    name: 'feishu_calendar_delete_event',
    description: '删除飞书日历事件。',
    action: 'feishu.calendarDeleteEvent',
    intent: 'delete_feishu_calendar_event',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_delete_event) as ToolParam[],
  },

  // ============================================================
  // Group Chat Operations
  // ============================================================
  {
    name: 'feishu_chat_list',
    description: '列出可访问的飞书群聊。',
    action: 'feishu.chatList',
    intent: 'list_feishu_chats',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_chat_list) as ToolParam[],
  },
  {
    name: 'feishu_chat_get_members',
    description: '获取飞书群聊成员列表。',
    action: 'feishu.chatGetMembers',
    intent: 'get_feishu_chat_members',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_chat_get_members) as ToolParam[],
  },
  {
    name: 'feishu_chat_get_info',
    description: '获取飞书群聊信息。',
    action: 'feishu.chatGetInfo',
    intent: 'get_feishu_chat_info',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_chat_get_info) as ToolParam[],
  },

  // ============================================================
  // File Operations
  // ============================================================
  {
    name: 'feishu_file_upload',
    description: '上传文件到飞书。',
    action: 'feishu.fileUpload',
    intent: 'upload_feishu_file',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_file_upload) as ToolParam[],
  },
  {
    name: 'feishu_file_download',
    description: '从飞书下载文件。',
    action: 'feishu.fileDownload',
    intent: 'download_feishu_file',
    executionKind: 'deterministic',
    params: zodObjectToParamList(FEISHU_SCHEMAS.feishu_file_download) as ToolParam[],
  },
]

function toStructuredResult(tool: FeishuToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    module: 'feishu',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  })
}

export function getFeishuAnthropicTools(): Array<Record<string, unknown>> {
  return FEISHU_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((p) => [p.name, buildToolParamSchema(p)])),
      required: tool.params.filter((p) => p.required).map((p) => p.name),
    },
  }))
}

export function getFeishuOpenAITools(): Array<Record<string, unknown>> {
  return FEISHU_TOOLS.map((tool) => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((p) => [p.name, buildToolParamSchema(p)])),
        required: tool.params.filter((p) => p.required).map((p) => p.name),
      },
    },
  }))
}

export async function executeFeishuTool(
  toolName: string,
  args: Record<string, unknown>,
  context: FeishuToolContext
): Promise<string> {
  const tool = FEISHU_TOOLS.find((t) => t.name === toolName)
  if (!tool) {
    return toStructuredResult({ name: toolName } as FeishuToolDef, `Unknown Feishu tool: ${toolName}`)
  }

  if (!context.sidecarManager) {
    return toStructuredResult(tool, 'Feishu sidecar manager not available')
  }

  const channelId = String(args.channel_id || context.channelId || '')
  if (!channelId) {
    return toStructuredResult(tool, 'Feishu channel_id is required')
  }

  try {
    let result: Record<string, unknown>

    switch (tool.action) {
      // Document operations
      case 'feishu.docRead':
        result = await context.sidecarManager.feishuDocRead(
          channelId,
          String(args.doc_token),
          String(args.doc_type)
        )
        break

      case 'feishu.docCreate':
        result = await context.sidecarManager.feishuDocCreate(
          channelId,
          String(args.title),
          String(args.doc_type),
          args.content,
          args.folder_token ? String(args.folder_token) : undefined
        )
        break

      case 'feishu.docUpdate':
        result = await context.sidecarManager.feishuDocUpdate(
          channelId,
          String(args.doc_token),
          String(args.doc_type),
          args.updates
        )
        break

      case 'feishu.docList':
        result = await context.sidecarManager.feishuDocList(
          channelId,
          args.folder_token ? String(args.folder_token) : undefined,
          args.doc_type ? String(args.doc_type) : undefined,
          args.limit ? Number(args.limit) : undefined
        )
        break

      // Message operations
      case 'feishu.messageSend':
        result = await context.sidecarManager.feishuMessageSend(
          channelId,
          String(args.chat_id),
          args.content,
          String(args.msg_type)
        )
        break

      case 'feishu.messageGetContext':
        result = await context.sidecarManager.feishuMessageGetContext(
          channelId,
          String(args.chat_id),
          args.limit ? Number(args.limit) : undefined,
          args.start_time ? String(args.start_time) : undefined,
          args.end_time ? String(args.end_time) : undefined
        )
        break

      case 'feishu.messageReply':
        result = await context.sidecarManager.feishuMessageReply(
          channelId,
          String(args.message_id),
          args.content,
          String(args.msg_type)
        )
        break

      // Calendar operations
      case 'feishu.calendarListEvents':
        result = await context.sidecarManager.feishuCalendarListEvents(
          channelId,
          args.calendar_id ? String(args.calendar_id) : '',
          String(args.start_time),
          String(args.end_time),
          args.limit ? Number(args.limit) : undefined
        )
        break

      case 'feishu.calendarCreateEvent':
        result = await context.sidecarManager.feishuCalendarCreateEvent(
          channelId,
          args as Record<string, unknown>
        )
        break

      case 'feishu.calendarUpdateEvent':
        result = await context.sidecarManager.feishuCalendarUpdateEvent(
          channelId,
          String(args.event_id),
          args.calendar_id ? String(args.calendar_id) : undefined,
          args.updates as Record<string, unknown>
        )
        break

      case 'feishu.calendarDeleteEvent':
        result = await context.sidecarManager.feishuCalendarDeleteEvent(
          channelId,
          String(args.event_id),
          args.calendar_id ? String(args.calendar_id) : undefined
        )
        break

      // Chat operations
      case 'feishu.chatList':
        result = await context.sidecarManager.feishuChatList(
          channelId,
          args.limit ? Number(args.limit) : undefined
        )
        break

      case 'feishu.chatGetMembers':
        result = await context.sidecarManager.feishuChatGetMembers(
          channelId,
          String(args.chat_id)
        )
        break

      case 'feishu.chatGetInfo':
        result = await context.sidecarManager.feishuChatGetInfo(
          channelId,
          String(args.chat_id)
        )
        break

      // File operations
      case 'feishu.fileUpload':
        result = await context.sidecarManager.feishuFileUpload(
          channelId,
          String(args.file_path),
          String(args.file_type),
          args.parent_token ? String(args.parent_token) : undefined
        )
        break

      case 'feishu.fileDownload':
        result = await context.sidecarManager.feishuFileDownload(
          channelId,
          String(args.file_token),
          String(args.save_path)
        )
        break

      default:
        return toStructuredResult(tool, `Unimplemented Feishu action: ${tool.action}`)
    }

    return toStructuredResult(tool, 'Success', result)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return toStructuredResult(tool, `Error: ${errorMessage}`)
  }
}
