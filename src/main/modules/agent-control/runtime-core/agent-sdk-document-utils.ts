import { readFile } from 'fs/promises'
import { basename } from 'path'
import { findDocumentVisualSyntaxIssue } from '../../../../shared/document-visual-syntax'
import {} from '../compaction/compact-agent-input'
import { TARGET_DOCUMENT_ERROR_KINDS } from '../contracts/error-kinds'
import type { RunMessage } from '../contracts/run-contracts'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput
} from '../tools-runtime/tool-result-types'
import type {
  DocumentTargetGuard,
  ObservedDocumentSaveState,
  ObservedDocumentToolTarget
} from './agent-sdk-types'

import {
  normalizedReferenceName,
  parseAttachmentReferences,
  parseEnvelopeResourceReferences,
  primaryInstructionText
} from './agent-sdk-input-context-utils'
import { asRecord } from './agent-sdk-model-message-utils'
import { readStructuredResultRecord } from './agent-sdk-provider-utils'
import { readTextField } from './agent-sdk-runtime-outcome-utils'

// ── Group F: Document target helpers (lines 1361-1799) ──

function findAttachmentByMention(
  attachments: Array<{ name: string; path: string }>,
  mention: string
): { name: string; path: string } | null {
  const wanted = normalizedReferenceName(mention)
  return (
    attachments.find((attachment) => {
      const name = normalizedReferenceName(attachment.name)
      const fileName = normalizedReferenceName(basename(attachment.path))
      return name === wanted || fileName === wanted
    }) || null
  )
}

function isEditableDocumentPath(path: string): boolean {
  return /\.(?:md|markdown|txt|docx?)$/i.test(path)
}

function collectUniqueEditableAttachments(
  attachments: Array<{ name: string; path: string }>
): Array<{ name: string; path: string }> {
  const seen = new Set<string>()
  const result: Array<{ name: string; path: string }> = []
  for (const attachment of attachments) {
    if (!isEditableDocumentPath(attachment.path)) continue
    const key = attachment.path || attachment.name
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(attachment)
  }
  return result
}

function isImplicitSingleDocumentEditInstruction(primary: string): boolean {
  return /(?:修复|修正|修一下|修改|改一下|改成|改写|编辑|润色|优化|替换|删除|删掉|调整|排版)/.test(
    primary
  )
}

export function resolveDocumentTargetGuard(
  message: RunMessage,
  requestEnvelope?: unknown
): DocumentTargetGuard | null {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  const attachments = [...envelopeRefs.resources, ...parseAttachmentReferences(message)]
  if (attachments.length === 0) return null

  const targetPatterns = [
    /(?:在|到|写(?:入|到)|放(?:到|在)|整理(?:到|进)|生成(?:到|在)|保存(?:到|在))@\[(.+?)\](?:里|中|内|下面)?/g,
    /@\[(.+?)\](?:里|中|内|下面).{0,12}(?:生成|写入|整理|制作|放|保存)/g,
    /把@\[(.+?)\].{0,18}(?:改得|改成|改写|编辑|润色|优化|整理成|写成|删掉|删除)/g
  ]
  for (const pattern of targetPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(primary)) !== null) {
      const attachment = findAttachmentByMention(attachments, match[1] || '')
      if (!attachment) continue
      if (!isEditableDocumentPath(attachment.path)) continue
      return {
        targetName: attachment.name,
        targetPath: attachment.path,
        opened: false,
        preserveExistingContent: shouldPreserveExistingDocumentContent(primary)
      }
    }
  }
  const editableAttachments = collectUniqueEditableAttachments(attachments)
  if (editableAttachments.length === 1 && isImplicitSingleDocumentEditInstruction(primary)) {
    const attachment = editableAttachments[0]
    return {
      targetName: attachment.name,
      targetPath: attachment.path,
      opened: false,
      preserveExistingContent: shouldPreserveExistingDocumentContent(primary)
    }
  }
  return null
}

export function buildDocumentTargetInstruction(guard: DocumentTargetGuard | null): string {
  if (!guard) return ''
  const preservedSnippets =
    guard.preserveExistingContent && guard.requiredPreservedSnippets?.length
      ? [
          '本轮还要求保留目标文档已有内容。以下原有片段必须原样留在最终文档中：',
          ...guard.requiredPreservedSnippets.slice(0, 8).map((snippet) => `- ${snippet}`),
          '如果需要在某个小节下面补充内容，优先把新增内容插入到原有片段之后；不要用替换操作删除原有片段。'
        ].join('\n')
      : ''
  return [
    `本轮用户已明确目标文档：${guard.targetName} (${guard.targetPath})。`,
    '任何写入、追加、插入 widget 或保存前，必须把该路径作为目标文档处理；不要新建临时文档来替代这个目标。',
    '如果需要改内容，先使用 document_open_tab 打开该路径，再执行内容修改，最后调用 document_save_tab 保存。',
    '在目标文档实际写入并保存前，不要用"我将要写入/我准备插入"作为最终回复。',
    '确认目标文档已有结果并保存后，直接用中文说明完成位置，不要继续重复切换标签或重复写入。',
    preservedSnippets
  ].join('\n')
}

function shouldPreserveExistingDocumentContent(primaryInstruction: string): boolean {
  return /(?:保留(?:原有|已有|原文|原来的|现有).{0,12}(?:内容|笔记|段落|章节|说明)?|不要(?:覆盖|删除|替换)|不能(?:覆盖|删除|替换)|不可(?:覆盖|删除|替换)|不(?:覆盖|删除)|追加|插入|补充到|整理到|放到|写入已有|已有(?:文档|笔记|内容)|原有(?:文档|笔记|内容|段落|章节))/.test(
    primaryInstruction
  )
}

function collectRequiredPreservedSnippets(content: string): string[] {
  const seen = new Set<string>()
  const snippets: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s/.test(trimmed)) continue
    if (trimmed.length < 4 || trimmed.length > 240) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    snippets.push(trimmed)
    if (snippets.length >= 40) break
  }
  if (snippets.length > 0) return snippets
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || seen.has(trimmed)) continue
    if (trimmed.length < 2 || trimmed.length > 240) continue
    seen.add(trimmed)
    snippets.push(trimmed)
    if (snippets.length >= 20) break
  }
  return snippets
}

export async function hydrateDocumentTargetPreservation(
  guard: DocumentTargetGuard | null
): Promise<void> {
  if (!guard?.preserveExistingContent) return
  if (!/\.(?:md|markdown|txt)$/i.test(guard.targetPath)) return
  try {
    const content = await readFile(guard.targetPath, 'utf-8')
    guard.initialContent = content
    guard.requiredPreservedSnippets = collectRequiredPreservedSnippets(content)
  } catch {
    // silent-catch: preservation snippets are best-effort; save validation still runs without them.
    guard.requiredPreservedSnippets = []
  }
}

function findMissingPreservedSnippets(guard: DocumentTargetGuard, content: string): string[] {
  if (!guard.preserveExistingContent || !guard.requiredPreservedSnippets?.length) return []
  return guard.requiredPreservedSnippets.filter((snippet) => !content.includes(snippet))
}

function formatPreservedSnippetList(snippets: string[]): string {
  return snippets
    .slice(0, 6)
    .map((snippet) => `- ${snippet}`)
    .join('\n')
}

function buildPreservedContentRepairContext(guard: DocumentTargetGuard): string {
  if (!guard.preserveExistingContent) return ''
  const snippets = guard.requiredPreservedSnippets?.length
    ? `必须恢复并保留的原有片段：\n${formatPreservedSnippetList(guard.requiredPreservedSnippets)}`
    : ''
  const initial =
    guard.initialContent && guard.initialContent.length <= 8000
      ? `原始目标文档全文：\n${guard.initialContent}`
      : ''
  return [snippets, initial].filter(Boolean).join('\n\n')
}

function createPreservedContentViolationOutput(
  guard: DocumentTargetGuard,
  missingSnippets: string[]
): ToolExecutionOutput {
  return createToolExecutionOutput(
    [
      `这次工具调用会删除 ${guard.targetName} 的原有内容，已拦截以避免覆盖用户笔记。`,
      '请保留原有片段，并把新增内容插入或追加到它们后面。',
      formatPreservedSnippetList(missingSnippets)
    ]
      .filter(Boolean)
      .join('\n'),
    {
      shape: 'json',
      data: {
        errorKind: TARGET_DOCUMENT_ERROR_KINDS.preservedContentMissing.code,
        targetPath: guard.targetPath,
        missingSnippets: missingSnippets.slice(0, 6)
      }
    }
  )
}

function extractMarkdownSection(content: string, sectionTitle: string): string {
  const titleKey = normalizedReferenceName(sectionTitle)
  if (!titleKey) return ''
  const lines = content.split(/\r?\n/)
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] || '')
    if (!match) continue
    const heading = normalizedReferenceName(match[2] || '')
    if (heading === titleKey || heading.includes(titleKey) || titleKey.includes(heading)) {
      start = i + 1
      level = match[1]?.length || 1
      break
    }
  }
  if (start < 0) return ''
  let end = lines.length
  for (let i = start; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[i] || '')
    if (match && (match[1]?.length || 1) <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export function validatePreservedDocumentMutation(
  guard: DocumentTargetGuard | null | undefined,
  toolName: string,
  args: Record<string, unknown>
): ToolExecutionOutput | null {
  if (!guard?.preserveExistingContent || !guard.requiredPreservedSnippets?.length) return null
  const snippets = guard.requiredPreservedSnippets
  if (toolName === 'document_set_content') {
    const content = typeof args.content === 'string' ? args.content : ''
    const missing = snippets.filter((snippet) => !content.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  if (toolName === 'document_replace_exact' || toolName === 'document_replace_text') {
    const target =
      typeof args.target === 'string' ? args.target : typeof args.from === 'string' ? args.from : ''
    const replacement =
      typeof args.replacement === 'string'
        ? args.replacement
        : typeof args.to === 'string'
          ? args.to
          : ''
    const touched = snippets.filter(
      (snippet) => target.includes(snippet) || snippet.includes(target.trim())
    )
    const missing = touched.filter((snippet) => !replacement.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  if (toolName === 'document_rewrite_section') {
    const sectionTitle = typeof args.sectionTitle === 'string' ? args.sectionTitle : ''
    const newContent = typeof args.content === 'string' ? args.content : ''
    const originalSection = guard.initialContent
      ? extractMarkdownSection(guard.initialContent, sectionTitle)
      : ''
    const touched = originalSection
      ? snippets.filter((snippet) => originalSection.includes(snippet))
      : []
    const missing = touched.filter((snippet) => !newContent.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  return null
}

export const DOCUMENT_TARGET_MUTATION_TOOL_NAMES = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section'
])

function isDocumentNoMutationText(text: string): boolean {
  return /(?:内容未变化|无变化|未做改动|已跳过|已是目标格式)/i.test(text)
}

export function isDocumentToolFailureText(text: string): boolean {
  return /(?:^Error:|Document action failed|failed|失败|无法|没有可|未匹配到|未找到|缺少|已拒绝|被拒绝|已取消|被取消)/i.test(
    text
  )
}

/** Whether a tool output represents a document-tool failure (error kind or failure text). */
export function isDocumentToolFailure(output: ToolExecutionOutput): boolean {
  const normalized = normalizeToolExecutionOutput(output)
  const data =
    normalized.data && typeof normalized.data === 'object'
      ? (normalized.data as Record<string, unknown>)
      : {}
  return typeof data.errorKind === 'string' || isDocumentToolFailureText(normalized.text)
}

/** Shallow-merge a list of projection patch records; null when the list is empty. */
export function mergeProjectionPatches(
  patches: Record<string, unknown>[]
): Record<string, unknown> | null {
  if (patches.length === 0) return null
  return patches.reduce<Record<string, unknown>>((acc, patch) => ({ ...acc, ...patch }), {})
}

function getToolDataRecord(output: ToolExecutionOutput): Record<string, unknown> {
  return output.data && typeof output.data === 'object'
    ? (output.data as Record<string, unknown>)
    : {}
}

export function documentToolMutatedContent(output: ToolExecutionOutput): boolean {
  const data = getToolDataRecord(output)
  if (typeof data.mutated === 'boolean') return data.mutated
  return !isDocumentToolFailureText(output.text) && !isDocumentNoMutationText(output.text)
}

export function documentSaveSucceeded(output: ToolExecutionOutput): boolean {
  const data = getToolDataRecord(output)
  if (typeof data.documentSaved === 'boolean') return data.documentSaved
  return !isDocumentToolFailureText(output.text)
}

function readDocumentToolTargetFromData(
  data: Record<string, unknown>
): ObservedDocumentToolTarget | null {
  const nested = asRecord(data.document)
  const tabId = readTextField(nested || data, 'tabId') || readTextField(data, 'documentTabId')
  const title = readTextField(nested || data, 'title') || readTextField(data, 'documentTitle')
  if (!tabId || !title) return null
  const path = readTextField(nested || data, 'path') || readTextField(data, 'documentPath')
  const dirtyValue = (nested || data).dirty ?? data.documentDirty
  const requiresSaveValue = (nested || data).requiresSave ?? data.documentRequiresSave
  const rawSaveState =
    readTextField(nested || data, 'saveState') || readTextField(data, 'documentSaveState')
  const dirty = typeof dirtyValue === 'boolean' ? dirtyValue : false
  const inferredSaveState: ObservedDocumentSaveState = path
    ? dirty
      ? 'dirty'
      : 'saved'
    : 'unsaved'
  const saveState: ObservedDocumentSaveState =
    rawSaveState === 'saved' || rawSaveState === 'dirty' || rawSaveState === 'unsaved'
      ? rawSaveState
      : inferredSaveState
  const requiresSave =
    typeof requiresSaveValue === 'boolean' ? requiresSaveValue : saveState !== 'saved'
  return {
    tabId,
    title,
    path,
    dirty,
    requiresSave,
    saveState
  }
}

export function readDocumentToolTarget(
  output: ToolExecutionOutput
): ObservedDocumentToolTarget | null {
  return readDocumentToolTargetFromData(readStructuredResultRecord(output))
}

export function isSameObservedDocumentTarget(
  left: ObservedDocumentToolTarget,
  right: ObservedDocumentToolTarget
): boolean {
  if (left.tabId && right.tabId && left.tabId === right.tabId) return true
  if (left.path && right.path && left.path === right.path) return true
  return false
}

export function normalizeExplicitDocumentTargetToolArgs(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (toolName === 'document_save_tab') return {}
  const next = { ...args }
  delete next.tabId
  return next
}

export function buildDocumentTargetRepairInput(guard: DocumentTargetGuard): string {
  return [
    '系统检查：目标文档尚未发生实际写入，上一轮不能算完成。',
    `请现在直接把结果写入目标文档 ${guard.targetName} (${guard.targetPath})。`,
    '如果是在修已有 widget 或信息卡，必须调用 document_update_widget；其他文本内容请调用 document_set_content、document_append_content 或 document_insert_widget 完成写入，并确保 document_save_tab 保存成功。',
    '不要只说明计划，不要输出伪工具调用文本；完成工具调用后再用中文简短确认。'
  ].join('\n')
}

export function buildNewDocumentSaveRepairInput(): string {
  return [
    '系统检查：你已经创建并修改了新文档，但还没有调用 document_save_tab 保存，不能算完成。',
    '请现在只调用 document_save_tab 保存当前文档；保存成功后，用中文简短说明结果并给出保存路径。',
    '不要再新建文档，不要只口头说明，不要输出伪工具调用文本。'
  ].join('\n')
}

export function finalTextIndicatesIncompleteDocument(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/(?:已|已经).{0,12}(?:补完|补全|补充完整|完成补充)/.test(normalized)) return false
  return /(?:被截断|内容截断|未完成|不完整|还没完成|没有完成|我(?:来|会|要).{0,12}补(?:完|全|充)|继续.{0,12}(?:写|补|完成)|需要.{0,12}(?:补|继续))/.test(
    normalized
  )
}

export function buildDocumentTargetContinuationRepairInput(guard: DocumentTargetGuard): string {
  return [
    '系统检查：上一轮回复表示目标文档还没补完，因此不能进入完成态。',
    `请现在继续修正目标文档 ${guard.targetName} (${guard.targetPath})，把未完成或截断的部分补完整。`,
    '必须调用 document_set_content、document_append_content、document_replace_text 或 document_replace_exact 完成修正；如果是在修已有 widget，请改用 document_update_widget。最后调用 document_save_tab 保存。',
    '完成后只简短确认，不要再说"我会补完"。'
  ].join('\n')
}

export async function inspectDocumentTargetContent(
  guard: DocumentTargetGuard,
  options: { forbidFutureLeakage?: boolean } = {}
): Promise<string | null> {
  if (!/\.(?:md|markdown|txt)$/i.test(guard.targetPath)) return null
  let content = ''
  try {
    content = await readFile(guard.targetPath, 'utf-8')
  } catch {
    // silent-catch: an unreadable optional target has no inspectable content.
    return null
  }
  if (/```show-widget/i.test(content)) {
    const widgetFence = /```show-widget\s*\n([\s\S]*?)(?:\n```|$)/gi
    let match: RegExpExecArray | null
    while ((match = widgetFence.exec(content)) !== null) {
      const raw = (match[1] || '').trim()
      if (!raw) return '目标文档里有空的 show-widget 代码块'
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // silent-catch: broken widget JSON returns the structured validation message
        return '目标文档里的 show-widget JSON 不完整或无法解析'
      }
      const record =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null
      const widgetCode = typeof record?.widget_code === 'string' ? record.widget_code : ''
      if (/<svg[\s>]/i.test(widgetCode) && !/<\/svg>/i.test(widgetCode)) {
        return '目标文档里的 show-widget SVG 没有闭合'
      }
    }
  }
  const visualSyntaxIssue = findDocumentVisualSyntaxIssue(content)
  if (visualSyntaxIssue) return visualSyntaxIssue
  if (
    options.forbidFutureLeakage &&
    /(?:日后|将来|未来|后续剧情|后续章节|后续待展开|情感纠葛|争夺)/.test(content)
  ) {
    return '目标文档包含超出指定章节的后续剧情或未来话术'
  }
  const missingPreserved = findMissingPreservedSnippets(guard, content)
  if (missingPreserved.length > 0) {
    return `目标文档缺少原有内容：${missingPreserved.slice(0, 3).join(' / ')}`
  }
  return null
}

export function buildDocumentTargetContentRepairInput(
  guard: DocumentTargetGuard,
  issue: string
): string {
  return [
    `系统检查：${issue}，目标文档不能进入完成态。`,
    `请修正目标文档 ${guard.targetName} (${guard.targetPath})。`,
    buildPreservedContentRepairContext(guard),
    '如果用户没有明确要求 widget、信息卡或交互式图表，请把损坏的 show-widget 改成稳定的 Markdown 表格、文本关系图或 Mermaid 图。',
    '如果问题是 Mermaid/关系图源码裸露，请把所有 graph/flowchart 节点和连线合并到一个完整的 ```mermaid 代码块里；如果不确定语法能通过，就改成 Markdown 表格或文本关系图。',
    '如果 Mermaid 代码块语法不兼容，请优先改成 Markdown 表格；若继续用 Mermaid，连线标签用 A -->|关系| B，不要用 A -- "关系" --- B。',
    '修复后，```mermaid 代码块外不能再留下 graph/flowchart、%% 注释、节点声明或 -- / --> / --- 这类连线源码。',
    '如果问题是 show-widget 或信息卡损坏，优先调用 document_update_widget 修复已有 widget；不要用 document_replace_text 或 document_replace_exact 修改 show-widget 围栏内部。',
    '如果问题是后续剧情或未来话术，请删除这些内容，只保留指定章节内已经发生或已明示的信息。',
    '如果问题是原有内容缺失，请先恢复原有内容，再把新增内容放在目标位置，不要覆盖原有笔记。',
    '必须调用 document_update_widget、document_set_content、document_replace_text、document_replace_exact 或 document_append_content 完成修正，并调用 document_save_tab 保存。',
    '完成后只简短确认。'
  ].join('\n')
}
