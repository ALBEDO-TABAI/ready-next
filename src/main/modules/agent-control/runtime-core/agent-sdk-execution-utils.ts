import { type AgentInputItem } from '@openai/agents'
import { hasLocalSendImFileIntent } from '../../../../shared/remote-im-file-intent'
import {} from '../compaction/compact-agent-input'
import type { RunMessage } from '../contracts/run-contracts'
import type { TurnTerminalReason } from './turn-frame'

import { resolveDocumentTargetGuard } from './agent-sdk-document-utils'
import { hasCurrentTurnAttachmentContext } from './agent-sdk-foundation-utils'
import {
  parseAttachmentReferences,
  parseEnvelopeResourceReferences,
  primaryInstructionText
} from './agent-sdk-input-context-utils'

// ── Group G: Tool and execution helpers (lines 1801-2122) ──

export function throwIfAbortSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = signal.reason instanceof Error ? signal.reason : new Error('aborted')
  error.name = 'AbortError'
  throw error
}

export async function waitForAbortableRetryDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAbortSignalAborted(signal)
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (timer) clearTimeout(timer)
      timer = null
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
  throwIfAbortSignalAborted(signal)
}

export function recoverLooseXmlToolCallText(text: string): {
  visibleText: string
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
} {
  const start = text.search(/<tool_call>/i)
  if (start < 0) return { visibleText: text, toolCalls: [] }
  const endMatch = /<\/tool_call>/i.exec(text.slice(start))
  const blockEnd = endMatch ? start + endMatch.index + endMatch[0].length : text.length
  const block = text.slice(start, blockEnd)
  const before = text.slice(0, start).trim()
  const after = endMatch ? text.slice(blockEnd).trim() : ''
  const fnMatch = /<function=([^>\s]+)\s*>/i.exec(block)
  if (!fnMatch) return { visibleText: text, toolCalls: [] }
  const name = String(fnMatch[1] || '').trim()
  if (!name) return { visibleText: text, toolCalls: [] }
  const fnBodyStart = (fnMatch.index || 0) + fnMatch[0].length
  const fnClose = /<\/function>/i.exec(block.slice(fnBodyStart))
  const fnBody = fnClose
    ? block.slice(fnBodyStart, fnBodyStart + fnClose.index)
    : block.slice(fnBodyStart)
  const paramRegex = /<parameter=([^>\s]+)\s*>/gi
  const starts: Array<{ key: string; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = paramRegex.exec(fnBody)) !== null) {
    const key = String(match[1] || '').trim()
    if (!key) continue
    starts.push({ key, start: match.index, end: match.index + match[0].length })
  }
  const args: Record<string, unknown> = {}
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index]
    const nextStart = starts[index + 1]?.start ?? fnBody.length
    const rawValue = fnBody.slice(current.end, nextStart)
    const explicitEnd = rawValue.search(new RegExp(`</parameter>`, 'i'))
    const value = (explicitEnd >= 0 ? rawValue.slice(0, explicitEnd) : rawValue)
      .replace(/<\/function>\s*$/i, '')
      .replace(/<\/tool_call>\s*$/i, '')
      .trim()
    args[current.key] = value
  }
  return {
    visibleText: [before, after].filter(Boolean).join('\n').trim(),
    toolCalls: [{ name, args }]
  }
}

export function shouldSuppressVisibleTextOnToolCall(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return true
  return /^(?:now|let me|good,|okay,|ok,|i will|i'll|i need|next,|然后|接下来|现在|我先|我会|让我|好的)[\s\S]{0,240}$/i.test(
    normalized
  )
}

export function hasLocalDocumentResource(message: RunMessage, requestEnvelope?: unknown): boolean {
  const references = collectLocalDocumentReferences(message, requestEnvelope)
  return references.length > 0
}

export function hasCurrentDocumentContextResource(requestEnvelope?: unknown): boolean {
  return parseEnvelopeResourceReferences(requestEnvelope).resources.some(
    (reference) => reference.kind === 'document_context' || reference.source === 'current_document'
  )
}

export function shouldPreferCurrentDocumentRead(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  if (!hasCurrentDocumentContextResource(requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (/(?:当前|这份|这个|本文档|打开的|编辑器|当前打开|当前项目计划文档)/.test(primary)) {
    return true
  }
  const nonCurrentResources = envelopeRefs.resources.filter(
    (reference) =>
      reference.kind !== 'document_context' &&
      reference.source !== 'current_document' &&
      /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name)
  )
  return nonCurrentResources.length === 0 && parseAttachmentReferences(message).length === 0
}

function collectLocalDocumentReferences(
  message: RunMessage,
  requestEnvelope?: unknown
): Array<{ name: string; path: string }> {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const references: Array<{ name: string; path: string; kind?: string; source?: string }> = [
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ]
  return references.filter((reference) =>
    reference.kind !== 'rss_reference' && (reference.kind === 'folder_reference'
    || reference.source === 'folder_reference'
    || /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name))
  )
}

function hasNonTargetLocalDocumentResource(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  const target = resolveDocumentTargetGuard(message, requestEnvelope)
  const targetPath = target?.targetPath || ''
  return collectLocalDocumentReferences(message, requestEnvelope).some((reference) => {
    const key = reference.path || reference.name
    return key && key !== targetPath
  })
}

export function shouldUseLocalDocumentToolSet(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  if (!hasLocalDocumentResource(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (
    hasLocalSendImFileIntent(primary, {
      hasAttachmentContext: hasCurrentTurnAttachmentContext(message, requestEnvelope)
    })
  ) {
    return false
  }
  if (
    /(?:网页|浏览器|网站|url|https?:\/\/|www\.|网上|网络|搜索|检索|最新|今天|新闻|官网|公告|source|citation|research|search|latest|today|news)/i.test(
      primary
    )
  ) {
    return false
  }
  return /(?:文档|文稿|章节|段落|部分|人物关系|关系图|信息卡|卡片|图表|写入|整理|生成|保存|编辑|改写|润色|排版|@\[[^\]]+\.(?:md|markdown|txt|docx?)\])/i.test(
    primary
  )
}

export function shouldRequireLocalDocumentExcerpt(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  if (!shouldUseLocalDocumentToolSet(message, requestEnvelope)) return false
  if (!hasNonTargetLocalDocumentResource(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (
    /(?:根据|基于|读取|读完|参考|原文|章节|部分|前\s*[一二三四五六七八九十\d]+\s*(?:章|节|部分)|第\s*[一二三四五六七八九十\d]+\s*(?:章|节|部分)|证据|出处|来源)/i.test(
      primary
    )
  ) {
    return true
  }
  const documentResourceKeys = new Set(
    [...envelopeRefs.resources, ...parseAttachmentReferences(message)]
      .filter((reference) => /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name))
      .map((reference) => reference.path || reference.name)
  )
  return documentResourceKeys.size > 1 && /(?:总结|梳理|分析|人物|关系)/i.test(primary)
}

export function shouldRequireLocalDocumentWriteOutput(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  if (!shouldUseLocalDocumentToolSet(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  return /(?:新建|创建|另存|保存|写入|写到|写进|整理到|放到|输出到|目录下|文件夹下|@\[[^\]]+\](?:目录|文件夹)|生成(?:一个|一份)?.{0,20}文档|文档.{0,12}(?:保存|写好|写完)|笔记.{0,12}保存)/i.test(
    primary
  )
}

export function buildLocalDocumentExcerptInstruction(
  required: boolean,
  preferCurrentDocumentRead = false
): string {
  if (!required) return ''
  if (preferCurrentDocumentRead) {
    return [
      '本轮是当前编辑器文档依据任务：生成结论前必须先调用 document_read_section 读取当前打开文档的指定章节或片段。',
      '如果用户限定"第 N 章 / 第 N 部分 / 某节 / 某章节"，优先调用 document_read_section，tabId 传 current，range 传 section:N、chapter:N 或 full。',
      '不要因为当前文档路径不在工作区索引里，就要求用户粘贴原文；当前编辑器已打开的内容应通过 document_read_section 读取。',
      '只有用户明确引用其他附件或工作区文件时，才用 file_locate / file_read_excerpt。',
      '只根据读取到的片段写结果；不要使用附件外信息。',
      '如果用户要求写入或保存文档，读取到足够依据后要优先执行真实文档修改并保存。'
    ].join('\n')
  }
  return [
    '本轮是本地文档依据任务：生成结论前必须先调用 file_read_excerpt 读取用户指定章节或片段。',
    '如果用户限定"前几章/某几章"，先用 file_locate 定位章节，再用 file_read_excerpt 读取对应章节正文。',
    '如果用户要求学习、总结、重排或分析整篇长文，优先顺序大块读取：第一次不要传 lineStart/lineEnd，让 file_read_excerpt 返回默认大块和 nextLine；如果 truncated=true，再从 nextLine 接着读。',
    '不要反复读取互相重叠的小行段；只有核对特定章节、标题或引用时才缩小范围。',
    '只根据读取到的片段写结果；不要使用书本常识、后续剧情或附件外信息。不确定的关系要标注"不确定"。',
    '不要写"后续待展开""后续剧情""日后""未来"等超出指定章节的提示语；章节外内容一律省略。',
    '如果用户要求新建、写入或保存文档，读取到足够章节依据后要优先写入并保存目标文档；不要为了读完整本或整章而无限继续读取。',
    '除非用户明确要求 widget、信息卡、卡片或交互式图表，否则关系图优先用 Markdown 表格、文本框图或 Mermaid，不要生成 show-widget。'
  ].join('\n')
}

export function buildLocalDocumentExcerptRepairInput(preferCurrentDocumentRead = false): string {
  if (preferCurrentDocumentRead) {
    return [
      '系统检查：你还没有成功读取当前编辑器文档正文，上一轮不能算完成。',
      '请先调用 document_read_section 读取当前打开文档的相关章节或片段，再基于读取内容重新生成结果。',
      '如果刚才 file_locate 或 file_read_excerpt 因工作区索引失败，不要让用户粘贴原文；改用 document_read_section 读取当前编辑器内容。',
      '如果已经写入了目标文档，请用读取后的依据修正并替换为可靠版本，然后保存。'
    ].join('\n')
  }
  return [
    '系统检查：你还没有成功读取用户指定文档正文，上一轮不能算完成。',
    '请先调用 file_read_excerpt 读取相关章节或片段，再基于读取内容重新生成结果。',
    '如果已经写入了目标文档，请用读取后的依据修正并替换为可靠版本，然后保存。'
  ].join('\n')
}

export function toSdkInput(message: RunMessage): string | AgentInputItem[] {
  if (typeof message === 'string') return message

  const content = message.map((block) => {
    if (block.type === 'image' && block.base64) {
      return {
        type: 'input_image',
        image: `data:${block.mimeType || 'image/png'};base64,${block.base64}`,
        detail: 'auto'
      }
    }
    const fallbackText =
      block.type === 'video'
        ? '[视频附件已接收；当前 SDK 实验路径会先把视频作为附件说明处理。]'
        : block.text || ''
    return {
      type: 'input_text',
      text: fallbackText
    }
  })

  return [
    {
      role: 'user',
      content
    } as AgentInputItem
  ]
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message))
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function raceWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<'settled' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function defaultFetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal
  })
}

export function classifySdkRuntimeError(error: unknown): {
  terminalReason: TurnTerminalReason
  userMessagePrefix: string
} {
  const message = errorMessage(error)
  if (
    /(?:owner_local_session_source_cursor_mismatch|browser_route_clean_boundary_missing|checkpoint_sdk_source_prefix_mismatch)/.test(
      message
    )
  ) {
    return {
      terminalReason: 'persistence_failed',
      userMessagePrefix: 'SDK 会话保存失败'
    }
  }
  if (
    /(?:api key|authentication|unauthorized|invalid.*key|forbidden|401|403|只支持 OpenAI 协议)/i.test(
      message
    )
  ) {
    return {
      terminalReason: 'blocked_config',
      userMessagePrefix: 'SDK 配置失败'
    }
  }
  if (
    /(?:context[\s_-]*(?:length|window)|maximum context|prompt (?:is )?too long|too many tokens|context_length_exceeded|request too large|http 413|\b413\b)/i.test(
      message
    )
  ) {
    return {
      terminalReason: 'context_overflow',
      userMessagePrefix: 'SDK 上下文已超限'
    }
  }
  if (extractSdkMissingToolName(error)) {
    return {
      terminalReason: 'blocked_tool_error',
      userMessagePrefix: 'SDK 工具未注册'
    }
  }
  if (
    /(?:quota|rate limit|429|fetch failed|network|timeout|timed out|ENOTFOUND|ECONN|ETIMEDOUT)/i.test(
      message
    )
  ) {
    return {
      terminalReason: 'blocked_external',
      userMessagePrefix: 'SDK 外部服务暂时不可用'
    }
  }
  return {
    terminalReason: 'blocked_external',
    userMessagePrefix: 'SDK 请求失败'
  }
}

export function extractSdkMissingToolName(error: unknown): string | null {
  const message = errorMessage(error)
  const quoted = message.match(/Tool\s+["'`]([^"'`]+)["'`]\s+not found in agent/i)
  if (quoted?.[1]) return quoted[1].trim()
  const bare = message.match(/Tool\s+([A-Za-z0-9_.:-]+)\s+not found in agent/i)
  return bare?.[1]?.trim() || null
}
