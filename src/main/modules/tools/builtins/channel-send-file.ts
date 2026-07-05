/**
 * Phase I（2026-07-05）—— `channel_send_file`：远程 IM 会话的文件直达回传。
 *
 * 真机实锚：用户在微信里说「把今天…的视听报告发我」，模型定位到了 PDF，
 * 却只能回答"我这边当前没有直接重发附件的 IM 工具"——出站附件此前只有
 * run 收口时的 proofRefs 收集器（要求 present_file 证据 + 意图正则），模型
 * 既没有工具、也不知道那条暗道。本工具给模型一条显式、即时、可回读的
 * 发送路径。
 *
 * 安全形状：发送目标**锁死为当前 scope 绑定的渠道线程**（就是提出请求的
 * 那个微信对话），参数里没有任何收件人寻址——不存在发给第三方的可能，
 * 故确认档位走默认 M4（与收集器的"意图正则=同意"同级）。文件校验镜像
 * 收集器（绝对路径/存在/常规文件/≤100MB/非 run_state.json）。
 */

import { existsSync, statSync } from 'fs'
import { basename, isAbsolute } from 'path'

import { ToolDomainError } from '../tool-errors'
import { CHANNEL_OUTBOUND_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import { getChannelOutboundSender } from '../../agent-control/channel-outbound-bridge'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'

export const CHANNEL_OUTBOUND_TOOL_NAMES = ['channel_send_file'] as const

const MAX_CHANNEL_FILE_BYTES = 100 * 1024 * 1024
const BLOCKED_BASENAMES = new Set(['run_state.json', 'delivery_report.json'])

const CHANNEL_SEND_FILE_DESCRIPTION =
  '把本机文件作为附件直接发送到当前远程 IM 会话线程（即正在对话的这个微信/渠道线程）。'
  + '用户在远程会话里要求"发我 / 传我 / 再发一次某文件"时使用；发送目标固定为当前线程，无法指定其他收件人。'
  + 'path 必须是本机绝对路径（≤100MB）。发送结果（成功/失败原因）会作为工具结果返回。'

const CHANNEL_SEND_FILE_PARAMS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '要发送文件的本机绝对路径（如 /Users/.../report.pdf）',
    },
    caption: {
      type: 'string',
      description: '可选：随附件一起发送的一句说明文字',
    },
  },
  required: ['path'],
} as const

export function getChannelOutboundAnthropicTools(): Array<Record<string, unknown>> {
  return [{
    name: 'channel_send_file',
    description: CHANNEL_SEND_FILE_DESCRIPTION,
    input_schema: CHANNEL_SEND_FILE_PARAMS,
  }]
}

export function getChannelOutboundOpenAITools(): Array<Record<string, unknown>> {
  return [{
    type: 'function',
    function: {
      name: 'channel_send_file',
      description: CHANNEL_SEND_FILE_DESCRIPTION,
      parameters: CHANNEL_SEND_FILE_PARAMS,
    },
  }]
}

export interface ChannelSendFileContext {
  scopeId?: string
  sessionId?: string
}

export async function executeChannelSendFile(
  args: Record<string, unknown>,
  ctx: ChannelSendFileContext,
): Promise<ToolExecutionOutput> {
  const scopeId = String(ctx.scopeId || ctx.sessionId || '').trim()
  const sender = getChannelOutboundSender()
  if (!scopeId || !sender) {
    throw new ToolDomainError(
      CHANNEL_OUTBOUND_ERROR_KINDS.scopeUnbound.code,
      '当前会话没有绑定远程渠道线程（或渠道回传通道未就绪），channel_send_file 仅在远程 IM 会话中可用。',
      { scopeId: scopeId || null },
    )
  }
  const path = String(args.path || '').trim()
  const caption = typeof args.caption === 'string' ? args.caption.trim().slice(0, 500) : ''
  if (!path || !isAbsolute(path)) {
    throw new ToolDomainError(
      CHANNEL_OUTBOUND_ERROR_KINDS.fileInvalid.code,
      `path 必须是本机绝对路径（收到：${path.slice(0, 120) || '空'}）。`,
      { path: path.slice(0, 200) },
    )
  }
  if (!existsSync(path)) {
    throw new ToolDomainError(
      CHANNEL_OUTBOUND_ERROR_KINDS.fileInvalid.code,
      `文件不存在：${path.slice(0, 200)}。先用 file_search/file_locate 确认真实路径。`,
      { path: path.slice(0, 200) },
    )
  }
  const stat = statSync(path)
  const name = basename(path)
  if (!stat.isFile() || stat.size <= 0 || BLOCKED_BASENAMES.has(name)) {
    throw new ToolDomainError(
      CHANNEL_OUTBOUND_ERROR_KINDS.fileInvalid.code,
      `不是可发送的常规文件：${name}。`,
      { path: path.slice(0, 200) },
    )
  }
  if (stat.size > MAX_CHANNEL_FILE_BYTES) {
    throw new ToolDomainError(
      CHANNEL_OUTBOUND_ERROR_KINDS.fileInvalid.code,
      `文件超过渠道附件上限（${Math.round(stat.size / 1024 / 1024)}MB > 100MB）：${name}。`,
      { path: path.slice(0, 200), size: stat.size },
    )
  }

  const delivery = await sender(scopeId, { path, ...(caption ? { caption } : {}) })
  if (!delivery.success) {
    throw new ToolDomainError(
      CHANNEL_OUTBOUND_ERROR_KINDS.deliveryFailed.code,
      `附件发送失败：${String(delivery.error || '渠道未返回原因')}。可稍后重试；若持续失败请告知用户在本机会话获取文件。`,
      { path: path.slice(0, 200), error: String(delivery.error || '').slice(0, 300) },
    )
  }
  const sizeLabel = stat.size >= 1024 * 1024
    ? `${(stat.size / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(stat.size / 1024))}KB`
  return createToolExecutionOutput(
    `已把文件发送到当前远程会话：${name}（${sizeLabel}）${caption ? `，附言：${caption}` : ''}`,
    {
      shape: 'json',
      data: {
        ok: true,
        name,
        path,
        size: stat.size,
        ...(delivery.channelId ? { channelId: delivery.channelId } : {}),
      },
    },
  )
}
