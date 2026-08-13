import { createHash } from 'node:crypto'

import { buildToolParamSchema, normalizeAnthropicToolSchema, normalizeOpenAIToolSchema, type ToolParamSchemaSpec } from './tool-schema'
import { FEISHU_SCHEMAS } from './schemas/feishu-schemas'
import { zodObjectToParamList } from './zod-param-derivation'
import {
  FEISHU_TOOL_ERROR_KINDS,
  type FeishuToolErrorKind,
} from '../agent-control/contracts/error-kinds'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'

type ToolParam = ToolParamSchemaSpec

interface FeishuToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic'
  params: ToolParam[]
}

export interface FeishuReadAuthority {
  channelId: string
  docToken: string
  docType: string
  allowedToolName: 'feishu_doc_read'
  channelIdentityDigest: string
  expectedResultDigest: string
}

export interface FeishuToolContext {
  sidecarManager?: {
    listChannels: () => Promise<Record<string, unknown>>
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
  feishuReadAuthority?: FeishuReadAuthority | null
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]))
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex')
}

export function digestFeishuReadResult(value: unknown): string {
  return sha256Canonical(value)
}

export function digestFeishuChannelSnapshot(value: unknown): string {
  const channel = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const config = channel?.config && typeof channel.config === 'object' && !Array.isArray(channel.config)
    ? channel.config as Record<string, unknown>
    : null
  if (!channel || channel.type !== 'feishu-app' || channel.enabled !== true
    || typeof channel.id !== 'string' || !channel.id.trim()
    || !config || typeof config.appId !== 'string' || !config.appId.trim()
    || typeof config.appSecret !== 'string' || !config.appSecret.trim()) {
    throw new Error('codex_external_read_feishu_channel_invalid')
  }
  return sha256Canonical({
    id: channel.id,
    type: channel.type,
    enabled: channel.enabled,
    appId: config.appId,
    appSecret: config.appSecret,
    domain: typeof config.domain === 'string' && config.domain.trim()
      ? config.domain.replace(/\/+$/, '')
      : 'https://open.feishu.cn',
  })
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

function toStructuredOutput(
  tool: FeishuToolDef,
  message: string,
  extra?: Record<string, unknown>,
): ToolExecutionOutput {
  const data = {
    module: 'feishu',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  }
  return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
}

const KNOWN_FEISHU_ERROR_KINDS = new Set<string>(
  Object.values(FEISHU_TOOL_ERROR_KINDS).map((entry) => entry.code),
)

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  }
  return null
}

function firstMessage(record: Record<string, unknown>): string {
  for (const key of ['error', 'message', 'msg', 'detail']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return 'Feishu operation failed'
}

function classifyFeishuFailure(record: Record<string, unknown>): FeishuToolErrorKind {
  const explicit = typeof record.errorKind === 'string' ? record.errorKind.trim() : ''
  if (KNOWN_FEISHU_ERROR_KINDS.has(explicit)) return explicit as FeishuToolErrorKind

  const status = firstNumber(record, ['status_code', 'statusCode', 'http_status', 'httpStatus', 'status'])
  const code = firstNumber(record, ['feishu_code', 'feishuCode', 'code'])
  const message = firstMessage(record).toLowerCase()

  if (status === 401 || code === 401 || /unauthori[sz]ed|invalid (?:access )?token|token (?:is )?expired|auth(?:entication)? required|not authenticated/.test(message)) {
    return FEISHU_TOOL_ERROR_KINDS.authRequired.code
  }
  if (status === 403 || code === 403 || /permission denied|forbidden|no permission|access denied/.test(message)) {
    return FEISHU_TOOL_ERROR_KINDS.permissionDenied.code
  }
  if (status === 404 || code === 404 || /not found|does not exist|resource missing/.test(message)) {
    return FEISHU_TOOL_ERROR_KINDS.notFound.code
  }
  if (status === 429 || code === 429 || /rate.?limit|too many requests|throttl/.test(message)) {
    return FEISHU_TOOL_ERROR_KINDS.rateLimited.code
  }
  if ((status !== null && status >= 500 && status <= 599) || (code !== null && code >= 500 && code <= 599)) {
    return FEISHU_TOOL_ERROR_KINDS.upstreamUnavailable.code
  }
  if (/network|econn|socket|dns|enotfound|eai_again|fetch failed|connection (?:reset|refused)|timed? ?out/.test(message)) {
    return FEISHU_TOOL_ERROR_KINDS.networkError.code
  }
  return FEISHU_TOOL_ERROR_KINDS.operationFailed.code
}

function failureOutput(
  tool: FeishuToolDef,
  errorKind: FeishuToolErrorKind,
  message: string,
  extra?: Record<string, unknown>,
): ToolExecutionOutput {
  return toStructuredOutput(tool, message, {
    ...(extra || {}),
    success: false,
    ok: false,
    errorKind,
    message,
  })
}

function successOutput(tool: FeishuToolDef, result: Record<string, unknown>): ToolExecutionOutput {
  const data = { ...result }
  delete data.errorKind
  return toStructuredOutput(tool, 'Success', {
    ...data,
    success: true,
    ok: true,
    message: 'Success',
  })
}

function authorityMatches(
  authority: FeishuReadAuthority,
  toolName: string,
  args: Record<string, unknown>,
  channelId: string,
): boolean {
  return toolName === authority.allowedToolName
    && channelId === authority.channelId
    && typeof args.doc_token === 'string'
    && args.doc_token === authority.docToken
    && typeof args.doc_type === 'string'
    && args.doc_type === authority.docType
}

async function currentFeishuChannelIdentityMatches(
  authority: FeishuReadAuthority,
  sidecarManager: NonNullable<FeishuToolContext['sidecarManager']>,
): Promise<boolean> {
  try {
    const listed = await sidecarManager.listChannels()
    const channels = Array.isArray(listed.channels) ? listed.channels : []
    const current = channels.find((candidate) => candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).id === authority.channelId)
    return Boolean(current) && digestFeishuChannelSnapshot(current) === authority.channelIdentityDigest
  } catch {
    return false
  }
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
): Promise<ToolExecutionOutput> {
  const tool = FEISHU_TOOLS.find((t) => t.name === toolName)
  if (!tool) {
    return failureOutput(
      {
        name: toolName,
        description: '',
        action: 'feishu.unknown',
        intent: 'unknown_feishu_operation',
        executionKind: 'deterministic',
        params: [],
      },
      FEISHU_TOOL_ERROR_KINDS.invalidRequest.code,
      `Unknown Feishu tool: ${toolName}`,
    )
  }

  const channelId = String(args.channel_id || context.channelId || '')
  if (!channelId) {
    return failureOutput(
      tool,
      FEISHU_TOOL_ERROR_KINDS.invalidRequest.code,
      'Feishu channel_id is required',
    )
  }

  if (context.feishuReadAuthority && !authorityMatches(context.feishuReadAuthority, toolName, args, channelId)) {
    return failureOutput(
      tool,
      FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code,
      'Feishu read authority does not match this request',
    )
  }

  if (!context.sidecarManager) {
    return failureOutput(
      tool,
      FEISHU_TOOL_ERROR_KINDS.sidecarUnavailable.code,
      'Feishu sidecar manager not available',
    )
  }

  if (context.feishuReadAuthority
    && !await currentFeishuChannelIdentityMatches(context.feishuReadAuthority, context.sidecarManager)) {
    return failureOutput(
      tool,
      FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code,
      'Feishu channel identity changed after this read was authorized',
    )
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
        if (context.feishuReadAuthority && result.success !== false
          && digestFeishuReadResult(result) !== context.feishuReadAuthority.expectedResultDigest) {
          return failureOutput(
            tool,
            FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code,
            'Feishu document content does not match the authorized resource version',
          )
        }
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
        return failureOutput(
          tool,
          FEISHU_TOOL_ERROR_KINDS.invalidRequest.code,
          `Unimplemented Feishu action: ${tool.action}`,
        )
    }

    if (result.success === false || result.ok === false) {
      const errorKind = classifyFeishuFailure(result)
      return failureOutput(tool, errorKind, firstMessage(result), result)
    }

    return successOutput(tool, result)
  } catch (error) {
    const errorRecord: Record<string, unknown> = error && typeof error === 'object'
      ? {
          ...(error as unknown as Record<string, unknown>),
          message: error instanceof Error ? error.message : String(error),
        }
      : { message: String(error) }
    const errorMessage = firstMessage(errorRecord)
    return failureOutput(tool, classifyFeishuFailure(errorRecord), errorMessage, errorRecord)
  }
}
