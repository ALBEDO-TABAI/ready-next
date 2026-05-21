import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import {
  Agent,
  MemorySession,
  OpenAIProvider,
  Runner,
  Usage,
  tool,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunStreamEvent,
  type StreamEvent,
  type Tool as AgentSdkTool,
} from '@openai/agents'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type {
  ExecutionTurnResult,
  RunMessage,
  TaskType,
  TurnTranscriptEvent,
} from '../contracts/run-contracts'
import type { ScopeRunEventPayload } from '../contracts/types'
import type { TurnTerminalReason } from './turn-frame'
import type { ContinuationIntent, ContinuationState } from '../contracts/continuation-state'
import {
  resumeSkillChildRun,
  waitForSkillChildRunClose,
} from '../skills/skill-child-runner'
import {
  isCompletedChildCloseStatus,
  isFailedChildCloseStatus,
  isKilledChildCloseStatus,
  type SkillChildCloseEvent,
} from '../skills/skill-child-run-types'
import type { MultimodalBlock } from '../../claude-bridge/direct-chat'
import {
  buildTextToolBridgePrompt,
  buildTextToolResultMessage,
  parseTextToolBridgeResponse,
} from '../../claude-bridge/tool-bridge'
import {
  readAIConfigDetailed,
  type AIConfigLoad,
} from '../../claude-bridge/direct-chat-ai-config'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import {
  getProviderDef,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderDef,
} from '../../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../../shared/ai-providers/index'
import {
  parseJsonOrEventStreamResponse,
} from '../../openai-responses'
import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls,
} from '../../claude-bridge/provider-tool-arguments'
import { resolveOpenAIProviderRuntime } from '../provider-runtime-resolver'
import {
  assertCurrentMessageCapability,
  sanitizeHistoricalMessagesByCapability,
  type CapabilityMessage,
  type MessageCapabilitySnapshot,
} from '../domain-adapters/message-capability-filter'
import { assertManualThinkingModeProviderSafe } from '../thinking-compatibility'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import type { BrowserTaskDecisionMode } from '../../../../shared/browser-agent-task'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import { resolveCapabilityResolution } from '../domain-adapters/capability-resolver'
import { filterToolsByVisionCapability } from '../tools-runtime/tool-gateway'
import {
  buildToolRuntimeContext,
  toToolExecutorContext,
} from '../tools-runtime/tool-runtime-context-builder'
import {
  applyContextModifier,
  createEmptyActiveFrameContext,
  type ToolRuntimeActiveFrameContext,
} from '../tools-runtime/tool-runtime'
import { snapshotTurnFeatureFlags } from './turn-feature-flags'
import { buildAgentSpawnContextFromAIConfig } from '../../skills-runtime/agent-context-source'
import { executeToolCall as executeReadyToolCall } from '../../tools'
import { PRIMITIVE_TOOL_DEFS, PRIMITIVE_TOOL_NAME_SET } from '../../tools/skill-primitives/tool-defs'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../tools-runtime/tool-result-types'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import { findDocumentVisualSyntaxIssue } from '../../../../shared/document-visual-syntax'
import { createRotatingLogger } from '../../../utils/rotating-logger'

const agentSdkLogger = createRotatingLogger('ready-agent-sdk.log')
const settingsRepository = new AppSettingsRepository()
const SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS = 1_500

function log(message: string): void {
  try {
    agentSdkLogger.append(`[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // silent-catch: logging must never break the agent path.
    // logging must never break the agent path
  }
}

interface AgentSdkSession {
  sdkSession: MemorySession
  abortController: AbortController | null
  systemPrompt: string
  generation: number
  activeRunId: string | null
}

interface ReadyAgentSdkRunParams {
  agentName: string
  runId: string
  taskId: string
  sessionId?: string
  input: string | AgentInputItem[]
  instructions: string
  model: string
  provider: ModelProvider
  session: MemorySession
  tools: AgentSdkTool[]
  signal: AbortSignal
  onTextDelta: (delta: string) => void
}

interface ReadyAgentSdkRunResult {
  finalText: string
}

interface ToolBridgeRuntimeContext {
  agentName: string
  runId: string
  taskId: string
  sessionId?: string
  signal: AbortSignal
  allowedToolNames: string[]
  authorization: SkillToolAuthorization
  activeFrame: ToolRuntimeActiveFrameContext
  agentContext?: AgentSpawnContext | null
  documentTargetGuard?: DocumentTargetGuard | null
  emitOutput: (chunk: string, type: string, projectionPatch?: Record<string, unknown> | null) => void
  emitToolAction: (toolName: string, args: Record<string, unknown>) => void
  recordToolResult: (toolName: string, output: ToolExecutionOutput) => void
}

interface SdkLongSkillCheckpoint {
  toolName: string
  skillId: string | null
  action: string | null
  childRunId: string | null
  outputDir: string | null
  runStatePath: string | null
  terminalReason: TurnTerminalReason
}

interface AgentSdkExecutionOptions {
  taskId?: string
  publicSessionId?: string
  requestEnvelope?: unknown
  intentClassification?: unknown
  budget?: unknown
  budgetState?: unknown
  taskBudgetRuntime?: unknown
  continuationIntent?: ContinuationIntent | null
  continuationState?: ContinuationState | null
}

interface DocumentTargetGuard {
  targetName: string
  targetPath: string
  opened: boolean
  preserveExistingContent: boolean
  initialContent?: string
  requiredPreservedSnippets?: string[]
  openToolDefinition?: ToolDefinition
  saveToolDefinition?: ToolDefinition
}

interface SkillContextOrchestratorLike {
  findExplicitlyRequestedSkills?: (userText: string) => Array<{
    id?: string
    skillId?: string
    name?: string
  }>
  buildPreferredSkillToolNames?: (userText: string, sessionId?: string) => string[] | null
  getCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string } | null
  rememberExplicitReferenceSkillHint?: (userText: string, sessionId?: string) => boolean
}

export interface AgentSdkRuntimeDeps {
  domainAdapters?: ReadonlyArray<DomainAdapter>
  loadAIConfig?: () => AIConfigLoad
  runAgent?: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  listToolDefinitions?: (params: {
    message: RunMessage
    sessionId?: string
    scopeId?: string
    config: AIModelConfig
    browserHostAvailable: boolean
    feishuConnected: boolean
    authorization: SkillToolAuthorization
  }) => ToolDefinition[]
  executeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ReturnType<typeof toToolExecutorContext>,
  ) => Promise<ToolExecutionOutput>
  fetchWithTimeout?: (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
    timeoutMs?: number,
  ) => Promise<Response>
  skillContextOrchestrator?: SkillContextOrchestratorLike | null
}

function defaultSystemPrompt(): string {
  return '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。'
}

function messageToText(message: RunMessage): string {
  if (typeof message === 'string') return message
  return message
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .join('\n')
    .trim()
}

const SDK_CONTEXT_MARKERS = [
  '## 环境信息',
  '## 当前 Scope',
  '## 最近会话摘要',
  '### Widget 更新上下文',
  '### 当前文档上下文',
  '### 文档引用',
  '### 浏览页面引用',
  '### 文件夹引用',
  '### 技能目录引用',
  '--- 测试模式附件路径 ---',
  '--- 引用文件:',
  '--- 附件:',
] as const

function allowedPrimitiveToolsForSdkSkillTurn(): string[] {
  const safeSkillPrimitives = new Set([
    'skill_ask_user',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_inspect_run_state',
  ])
  return PRIMITIVE_TOOL_DEFS
    .map((definition) => definition.name)
    .filter((name) => safeSkillPrimitives.has(name))
}

function primaryInstructionText(message: RunMessage): string {
  const text = messageToText(message)
  let end = text.length
  for (const marker of SDK_CONTEXT_MARKERS) {
    const index = text.indexOf(marker)
    if (index >= 0 && index < end) end = index
  }
  const primary = text.slice(0, end).trim()
  return primary || text
}

function normalizedReferenceName(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/^@\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()
}

function parseAttachmentReferences(message: RunMessage): Array<{ name: string; path: string }> {
  const text = messageToText(message)
  const references: Array<{ name: string; path: string }> = []
  const pattern = /--- 附件:\s*([^\n-][^\n]*?)\s*---\s*\n-\s*路径:\s*([^\n]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]?.trim()
    const path = match[2]?.trim()
    if (name && path) references.push({ name, path })
  }
  const harnessMarker = '--- 测试模式附件路径 ---'
  const harnessIndex = text.indexOf(harnessMarker)
  if (harnessIndex >= 0) {
    const afterMarker = text.slice(harnessIndex + harnessMarker.length)
    const nextSectionIndex = afterMarker.search(/\n--- (?!测试模式附件路径)/)
    const harnessSection = nextSectionIndex >= 0 ? afterMarker.slice(0, nextSectionIndex) : afterMarker
    const harnessPattern = /^-\s*([^:\n]+?)\s*:\s*(\/[^\n]+)$/gm
    let harnessMatch: RegExpExecArray | null
    while ((harnessMatch = harnessPattern.exec(harnessSection)) !== null) {
      const name = harnessMatch[1]?.trim()
      const path = harnessMatch[2]?.trim()
      if (name && path) references.push({ name, path })
    }
  }
  return references
}

function parseEnvelopeResourceReferences(envelope: unknown): {
  primaryInstruction: string | null
  resources: Array<{ name: string; path: string }>
} {
  const record = asRecord(envelope)
  if (!record) return { primaryInstruction: null, resources: [] }
  const primaryInstruction = typeof record.primaryInstruction === 'string' && record.primaryInstruction.trim()
    ? record.primaryInstruction.trim()
    : typeof record.pureUserText === 'string' && record.pureUserText.trim()
      ? record.pureUserText.trim()
      : typeof record.rawUserText === 'string' && record.rawUserText.trim()
        ? primaryInstructionText(record.rawUserText)
        : null
  const rawResources = Array.isArray(record.resources) ? record.resources : []
  const resources = rawResources
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: String(item.name || '').trim(),
      path: String(item.path || item.documentPath || '').trim(),
    }))
    .filter((item) => item.name && item.path)
  return { primaryInstruction, resources }
}

function findAttachmentByMention(
  attachments: Array<{ name: string; path: string }>,
  mention: string,
): { name: string; path: string } | null {
  const wanted = normalizedReferenceName(mention)
  return attachments.find((attachment) => {
    const name = normalizedReferenceName(attachment.name)
    const fileName = normalizedReferenceName(basename(attachment.path))
    return name === wanted || fileName === wanted
  }) || null
}

function isEditableDocumentPath(path: string): boolean {
  return /\.(?:md|markdown|txt|docx?)$/i.test(path)
}

function collectUniqueEditableAttachments(
  attachments: Array<{ name: string; path: string }>,
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
  return /(?:修复|修正|修一下|修改|改一下|改成|改写|编辑|润色|优化|替换|删除|删掉|调整|排版)/.test(primary)
}

function resolveDocumentTargetGuard(message: RunMessage, requestEnvelope?: unknown): DocumentTargetGuard | null {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  const attachments = [
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ]
  if (attachments.length === 0) return null

  const targetPatterns = [
    /(?:在|到|写(?:入|到)|放(?:到|在)|整理(?:到|进)|生成(?:到|在)|保存(?:到|在))@\[(.+?)\](?:里|中|内|下面)?/g,
    /@\[(.+?)\](?:里|中|内|下面).{0,12}(?:生成|写入|整理|制作|放|保存)/g,
    /把@\[(.+?)\].{0,18}(?:改得|改成|改写|编辑|润色|优化|整理成|写成|删掉|删除)/g,
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
        preserveExistingContent: shouldPreserveExistingDocumentContent(primary),
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
      preserveExistingContent: shouldPreserveExistingDocumentContent(primary),
    }
  }
  return null
}

function buildDocumentTargetInstruction(guard: DocumentTargetGuard | null): string {
  if (!guard) return ''
  const preservedSnippets = guard.preserveExistingContent && guard.requiredPreservedSnippets?.length
    ? [
      '本轮还要求保留目标文档已有内容。以下原有片段必须原样留在最终文档中：',
      ...guard.requiredPreservedSnippets.slice(0, 8).map((snippet) => `- ${snippet}`),
      '如果需要在某个小节下面补充内容，优先把新增内容插入到原有片段之后；不要用替换操作删除原有片段。',
    ].join('\n')
    : ''
  return [
    `本轮用户已明确目标文档：${guard.targetName} (${guard.targetPath})。`,
    '任何写入、追加、插入 widget 或保存前，必须把该路径作为目标文档处理；不要新建临时文档来替代这个目标。',
    '如果需要改内容，先使用 document_open_tab 打开该路径，再执行内容修改，最后调用 document_save_tab 保存。',
    '在目标文档实际写入并保存前，不要用“我将要写入/我准备插入”作为最终回复。',
    '确认目标文档已有结果并保存后，直接用中文说明完成位置，不要继续重复切换标签或重复写入。',
    preservedSnippets,
  ].join('\n')
}

function shouldPreserveExistingDocumentContent(primaryInstruction: string): boolean {
  return /(?:保留(?:原有|已有|原文|原来的|现有).{0,12}(?:内容|笔记|段落|章节|说明)?|不要(?:覆盖|删除|替换)|不能(?:覆盖|删除|替换)|不可(?:覆盖|删除|替换)|不(?:覆盖|删除)|追加|插入|补充到|整理到|放到|写入已有|已有(?:文档|笔记|内容)|原有(?:文档|笔记|内容|段落|章节))/.test(primaryInstruction)
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

async function hydrateDocumentTargetPreservation(guard: DocumentTargetGuard | null): Promise<void> {
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

function findMissingPreservedSnippets(
  guard: DocumentTargetGuard,
  content: string,
): string[] {
  if (!guard.preserveExistingContent || !guard.requiredPreservedSnippets?.length) return []
  return guard.requiredPreservedSnippets.filter((snippet) => !content.includes(snippet))
}

function formatPreservedSnippetList(snippets: string[]): string {
  return snippets.slice(0, 6).map((snippet) => `- ${snippet}`).join('\n')
}

function buildPreservedContentRepairContext(guard: DocumentTargetGuard): string {
  if (!guard.preserveExistingContent) return ''
  const snippets = guard.requiredPreservedSnippets?.length
    ? `必须恢复并保留的原有片段：\n${formatPreservedSnippetList(guard.requiredPreservedSnippets)}`
    : ''
  const initial = guard.initialContent && guard.initialContent.length <= 8000
    ? `原始目标文档全文：\n${guard.initialContent}`
    : ''
  return [snippets, initial].filter(Boolean).join('\n\n')
}

function createPreservedContentViolationOutput(
  guard: DocumentTargetGuard,
  missingSnippets: string[],
): ToolExecutionOutput {
  return createToolExecutionOutput(
    [
      `这次工具调用会删除 ${guard.targetName} 的原有内容，已拦截以避免覆盖用户笔记。`,
      '请保留原有片段，并把新增内容插入或追加到它们后面。',
      formatPreservedSnippetList(missingSnippets),
    ].filter(Boolean).join('\n'),
    {
      shape: 'json',
      data: {
        errorKind: 'target_document_preserved_content_missing',
        targetPath: guard.targetPath,
        missingSnippets: missingSnippets.slice(0, 6),
      },
    },
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

function validatePreservedDocumentMutation(
  guard: DocumentTargetGuard | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): ToolExecutionOutput | null {
  if (!guard?.preserveExistingContent || !guard.requiredPreservedSnippets?.length) return null
  const snippets = guard.requiredPreservedSnippets
  if (toolName === 'document_set_content') {
    const content = typeof args.content === 'string' ? args.content : ''
    const missing = snippets.filter((snippet) => !content.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  if (toolName === 'document_replace_exact' || toolName === 'document_replace_text') {
    const target = typeof args.target === 'string'
      ? args.target
      : typeof args.from === 'string'
        ? args.from
        : ''
    const replacement = typeof args.replacement === 'string'
      ? args.replacement
      : typeof args.to === 'string'
        ? args.to
        : ''
    const touched = snippets.filter((snippet) => target.includes(snippet) || snippet.includes(target.trim()))
    const missing = touched.filter((snippet) => !replacement.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  if (toolName === 'document_rewrite_section') {
    const sectionTitle = typeof args.sectionTitle === 'string' ? args.sectionTitle : ''
    const newContent = typeof args.content === 'string' ? args.content : ''
    const originalSection = guard.initialContent ? extractMarkdownSection(guard.initialContent, sectionTitle) : ''
    const touched = originalSection
      ? snippets.filter((snippet) => originalSection.includes(snippet))
      : []
    const missing = touched.filter((snippet) => !newContent.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  return null
}

const DOCUMENT_TARGET_MUTATION_TOOL_NAMES = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
])

function isDocumentNoMutationText(text: string): boolean {
  return /(?:内容未变化|无变化|未做改动|已跳过|已是目标格式)/i.test(text)
}

function isDocumentToolFailureText(text: string): boolean {
  return /(?:^Error:|Document action failed|failed|失败|无法|没有可|未匹配到|未找到|缺少|已拒绝|被拒绝|已取消|被取消)/i.test(text)
}

function getToolDataRecord(output: ToolExecutionOutput): Record<string, unknown> {
  return output.data && typeof output.data === 'object'
    ? output.data as Record<string, unknown>
    : {}
}

function documentToolMutatedContent(output: ToolExecutionOutput): boolean {
  const data = getToolDataRecord(output)
  if (typeof data.mutated === 'boolean') return data.mutated
  return !isDocumentToolFailureText(output.text) && !isDocumentNoMutationText(output.text)
}

function documentSaveSucceeded(output: ToolExecutionOutput): boolean {
  const data = getToolDataRecord(output)
  if (typeof data.documentSaved === 'boolean') return data.documentSaved
  return !isDocumentToolFailureText(output.text)
}

function normalizeExplicitDocumentTargetToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === 'document_save_tab') return {}
  const next = { ...args }
  delete next.tabId
  return next
}

function buildDocumentTargetRepairInput(guard: DocumentTargetGuard): string {
  return [
    '系统检查：目标文档尚未发生实际写入，上一轮不能算完成。',
    `请现在直接把结果写入目标文档 ${guard.targetName} (${guard.targetPath})。`,
    '如果是在修已有 widget 或信息卡，必须调用 document_update_widget；其他文本内容请调用 document_set_content、document_append_content 或 document_insert_widget 完成写入，并确保 document_save_tab 保存成功。',
    '不要只说明计划，不要输出伪工具调用文本；完成工具调用后再用中文简短确认。',
  ].join('\n')
}

function buildNewDocumentSaveRepairInput(): string {
  return [
    '系统检查：你已经创建并修改了新文档，但还没有调用 document_save_tab 保存，不能算完成。',
    '请现在只调用 document_save_tab 保存当前文档；保存成功后，用中文简短说明结果并给出保存路径。',
    '不要再新建文档，不要只口头说明，不要输出伪工具调用文本。',
  ].join('\n')
}

function finalTextIndicatesIncompleteDocument(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/(?:已|已经).{0,12}(?:补完|补全|补充完整|完成补充)/.test(normalized)) return false
  return /(?:被截断|内容截断|未完成|不完整|还没完成|没有完成|我(?:来|会|要).{0,12}补(?:完|全|充)|继续.{0,12}(?:写|补|完成)|需要.{0,12}(?:补|继续))/.test(normalized)
}

function buildDocumentTargetContinuationRepairInput(guard: DocumentTargetGuard): string {
  return [
    '系统检查：上一轮回复表示目标文档还没补完，因此不能进入完成态。',
    `请现在继续修正目标文档 ${guard.targetName} (${guard.targetPath})，把未完成或截断的部分补完整。`,
    '必须调用 document_set_content、document_append_content、document_replace_text 或 document_replace_exact 完成修正；如果是在修已有 widget，请改用 document_update_widget。最后调用 document_save_tab 保存。',
    '完成后只简短确认，不要再说“我会补完”。',
  ].join('\n')
}

async function inspectDocumentTargetContent(
  guard: DocumentTargetGuard,
  options: { forbidFutureLeakage?: boolean } = {},
): Promise<string | null> {
  if (!/\.(?:md|markdown|txt)$/i.test(guard.targetPath)) return null
  let content = ''
  try {
    content = await readFile(guard.targetPath, 'utf-8')
  } catch {
    // silent-catch: target file not readable yet (not on disk, permission, race with save).
    // Skip the post-write content inspection; downstream guards still block the turn if no
    // mutation happened, so a missing file is not a hidden failure.
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
        // silent-catch: parse failure IS the surfaced signal — the returned issue text becomes
        // the blocked_tool_error reason that the caller emits. No separate log/metric needed.
        return '目标文档里的 show-widget JSON 不完整或无法解析'
      }
      const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
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
    options.forbidFutureLeakage
    && /(?:日后|将来|未来|后续剧情|后续章节|后续待展开|情感纠葛|争夺)/.test(content)
  ) {
    return '目标文档包含超出指定章节的后续剧情或未来话术'
  }
  const missingPreserved = findMissingPreservedSnippets(guard, content)
  if (missingPreserved.length > 0) {
    return `目标文档缺少原有内容：${missingPreserved.slice(0, 3).join(' / ')}`
  }
  return null
}

function buildDocumentTargetContentRepairInput(guard: DocumentTargetGuard, issue: string): string {
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
    '完成后只简短确认。',
  ].join('\n')
}

function recoverLooseXmlToolCallText(text: string): {
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
  const paramRegex = /<parameter=([^>\s]+)\s*>/ig
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
    toolCalls: [{ name, args }],
  }
}

function shouldSuppressVisibleTextOnToolCall(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return true
  return /^(?:now|let me|good,|okay,|ok,|i will|i'll|i need|next,|然后|接下来|现在|我先|我会|让我|好的)[\s\S]{0,240}$/i.test(normalized)
}

function hasLocalDocumentResource(message: RunMessage, requestEnvelope?: unknown): boolean {
  const references = collectLocalDocumentReferences(message, requestEnvelope)
  return references.length > 0
}

function collectLocalDocumentReferences(
  message: RunMessage,
  requestEnvelope?: unknown,
): Array<{ name: string; path: string }> {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  return [
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ].filter((reference) => /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name))
}

function hasNonTargetLocalDocumentResource(message: RunMessage, requestEnvelope?: unknown): boolean {
  const target = resolveDocumentTargetGuard(message, requestEnvelope)
  const targetPath = target?.targetPath || ''
  return collectLocalDocumentReferences(message, requestEnvelope)
    .some((reference) => {
      const key = reference.path || reference.name
      return key && key !== targetPath
    })
}

function shouldUseLocalDocumentToolSet(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (!hasLocalDocumentResource(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (/(?:网页|浏览器|网站|url|https?:\/\/|www\.|网上|网络|搜索|检索|最新|今天|新闻|官网|公告|source|citation|research|search|latest|today|news)/i.test(primary)) {
    return false
  }
  return /(?:文档|文稿|章节|段落|人物关系|关系图|信息卡|卡片|图表|写入|整理|生成|保存|编辑|改写|润色|排版|@\[[^\]]+\.(?:md|markdown|txt|docx?)\])/i.test(primary)
}

function shouldRequireLocalDocumentExcerpt(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (!shouldUseLocalDocumentToolSet(message, requestEnvelope)) return false
  if (!hasNonTargetLocalDocumentResource(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (/(?:根据|基于|读取|读完|参考|原文|章节|前\s*[一二三四五六七八九十\d]+\s*(?:章|节)|第\s*[一二三四五六七八九十\d]+\s*(?:章|节)|证据|出处|来源)/i.test(primary)) {
    return true
  }
  const documentResourceKeys = new Set([
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ]
    .filter((reference) => /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name))
    .map((reference) => reference.path || reference.name))
  return documentResourceKeys.size > 1 && /(?:总结|梳理|分析|人物|关系)/i.test(primary)
}

function buildLocalDocumentExcerptInstruction(required: boolean): string {
  if (!required) return ''
  return [
    '本轮是本地文档依据任务：生成结论前必须先调用 file_read_excerpt 读取用户指定章节或片段。',
    '如果用户限定“前几章/某几章”，先用 file_locate 定位章节，再用 file_read_excerpt 读取对应章节正文。',
    '只根据读取到的片段写结果；不要使用书本常识、后续剧情或附件外信息。不确定的关系要标注“不确定”。',
    '不要写“后续待展开”“后续剧情”“日后”“未来”等超出指定章节的提示语；章节外内容一律省略。',
    '除非用户明确要求 widget、信息卡、卡片或交互式图表，否则关系图优先用 Markdown 表格、文本框图或 Mermaid，不要生成 show-widget。',
  ].join('\n')
}

function buildLocalDocumentExcerptRepairInput(): string {
  return [
    '系统检查：你还没有读取用户指定文档正文，上一轮不能算完成。',
    '请先调用 file_read_excerpt 读取相关章节或片段，再基于读取内容重新生成结果。',
    '如果已经写入了目标文档，请用读取后的依据修正并替换为可靠版本，然后保存。',
  ].join('\n')
}

function isLocalDocumentToolDefinition(definition: ToolDefinition): boolean {
  return definition.domain === 'document' || definition.domain === 'file'
}

function shouldExposeResearchTools(message: RunMessage): boolean {
  const text = primaryInstructionText(message)
  return /(?:搜索|查找|查一下|检索|研究|资料|来源|引用|最新|今天|新闻|天气|股价|汇率|比分|赛程|官网|公告|价格|source|citation|research|search|latest|today|news)/i.test(text)
}

function resolveBrowserDecisionMode(
  message: RunMessage,
  browserHostAvailable: boolean,
): BrowserTaskDecisionMode {
  if (!browserHostAvailable) return 'free_tool_loop'
  const text = primaryInstructionText(message)
  const hasExplicitBrowserSurface =
    /(?:网页|浏览器|网站|当前页|页面|链接|url|https?:\/\/|www\.|browser|website|web page|current page|click|download)/i.test(text)
  const hasDocumentSurface =
    /(?:文档|文稿|原文|文章|段落|章节|markdown|\.md\b|@\[.*?\.(?:md|txt|docx?)\]|widget|show-widget|图表|趋势图|人物关系图|卡片|信息卡|表格|保存|写入|追加|替换|编辑|改写|润色|排版|格式)/i.test(text)
  const hasBrowserUploadIntent =
    hasExplicitBrowserSurface &&
    /(?:上传|提交|发布|发送|选择).{0,30}(?:附件|文件|图片|图像|视频|upload|attach|file|image|video)|(?:附件|文件|图片|图像|视频|file|image|video).{0,30}(?:上传|提交|发布|发送|upload|attach)|(?:upload|attach).{0,30}(?:file|image|video)/i.test(text)
  if (hasBrowserUploadIntent) return 'browser_upload_workflow'
  if (hasDocumentSurface && !hasExplicitBrowserSurface) return 'free_tool_loop'
  if (
    shouldExposeResearchTools(message)
    || hasExplicitBrowserSurface
    || /(?:打开|点击|输入|下载)/i.test(text)
  ) {
    return 'browser_workflow'
  }
  return 'free_tool_loop'
}

function toSdkInput(message: RunMessage): string | AgentInputItem[] {
  if (typeof message === 'string') return message

  const content = message.map((block) => {
    if (block.type === 'image' && block.base64) {
      return {
        type: 'input_image',
        image: `data:${block.mimeType || 'image/png'};base64,${block.base64}`,
        detail: 'auto',
      }
    }
    const fallbackText = block.type === 'video'
      ? '[视频附件已接收；当前 SDK 实验路径会先把视频作为附件说明处理。]'
      : block.text || ''
    return {
      type: 'input_text',
      text: fallbackText,
    }
  })

  return [
    {
      role: 'user',
      content,
    } as AgentInputItem,
  ]
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError'
    || /abort|cancel/i.test(error.message)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function defaultFetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal,
  })
}

function classifySdkRuntimeError(error: unknown): {
  terminalReason: TurnTerminalReason
  userMessagePrefix: string
} {
  const message = errorMessage(error)
  if (/(?:api key|authentication|unauthorized|invalid.*key|forbidden|401|403|只支持 OpenAI 协议)/i.test(message)) {
    return {
      terminalReason: 'blocked_config',
      userMessagePrefix: 'SDK 配置失败',
    }
  }
  if (/(?:quota|rate limit|429|fetch failed|network|timeout|timed out|ENOTFOUND|ECONN|ETIMEDOUT)/i.test(message)) {
    return {
      terminalReason: 'blocked_external',
      userMessagePrefix: 'SDK 外部服务暂时不可用',
    }
  }
  return {
    terminalReason: 'blocked_external',
    userMessagePrefix: 'SDK 请求失败',
  }
}

function resolveAgentSdkProvider(
  config: AIModelConfig,
  deps: { fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']> },
): {
  provider: ModelProvider
  model: string
} {
  const normalized = normalizeAIConfig(config)
  const capabilities = resolveAIConfigCapabilities(normalized)
  if (!normalized || !capabilities) {
    throw new Error('当前 SDK 路径无法解析 AI 配置。')
  }

  const baseURL = String(capabilities.baseUrl || normalized.baseUrl || '').trim().replace(/\/+$/, '')
  if (capabilities.agentProtocol === 'anthropic') {
    return {
      model: normalized.model,
      provider: new ReadyAnthropicModelProvider({
        config: normalized,
        baseUrl: baseURL,
        fetchWithTimeout: deps.fetchWithTimeout,
      }),
    }
  }
  if (capabilities.agentProtocol !== 'openai') {
    throw new Error('当前 SDK 路径暂不支持该模型协议配置。')
  }
  if (normalized.provider !== 'openai') {
    return {
      model: normalized.model,
      provider: new ReadyOpenAICompatibleModelProvider({
        config: normalized,
        baseUrl: baseURL,
        fetchWithTimeout: deps.fetchWithTimeout,
      }),
    }
  }
  return {
    model: normalized.model,
    provider: new OpenAIProvider({
      apiKey: normalized.apiKey,
      baseURL: baseURL || undefined,
      useResponses: capabilities.wireApi === 'responses',
      strictFeatureValidation: false,
    }),
  }
}

function extractToolCallFromStreamEvent(event: RunStreamEvent): {
  name: string
  args: Record<string, unknown>
} | null {
  if (event.type !== 'run_item_stream_event' || event.name !== 'tool_called') return null
  const rawItem = (event.item as { rawItem?: unknown }).rawItem
  if (!rawItem || typeof rawItem !== 'object') return null
  const record = rawItem as { type?: unknown; name?: unknown; arguments?: unknown }
  if (record.type !== 'function_call' || typeof record.name !== 'string') return null
  if (typeof record.arguments !== 'string') {
    return { name: record.name, args: {} }
  }
  try {
    const parsed = JSON.parse(record.arguments) as unknown
    return {
      name: record.name,
      args: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {},
    }
  } catch {
    // silent-catch: invalid streamed tool arguments fall back to an empty object.
    return { name: record.name, args: {} }
  }
}

async function runWithOpenAIAgentsSdk(
  params: ReadyAgentSdkRunParams,
): Promise<ReadyAgentSdkRunResult> {
  const agent = new Agent({
    name: params.agentName,
    instructions: params.instructions,
    model: params.model,
    tools: params.tools,
  })
  const runner = new Runner({
    modelProvider: params.provider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: 'Ready Agent SDK Runtime',
    groupId: params.sessionId,
  })
  const stream = await runner.run(agent, params.input, {
    stream: true,
    signal: params.signal,
    session: params.session,
    maxTurns: 16,
    toolExecution: {
      maxFunctionToolConcurrency: 1,
    },
  })
  for await (const event of stream) {
    if (
      event.type === 'raw_model_stream_event'
      && event.data.type === 'output_text_delta'
      && typeof event.data.delta === 'string'
    ) {
      params.onTextDelta(event.data.delta)
      continue
    }
    const toolCall = extractToolCallFromStreamEvent(event)
    if (toolCall) {
      log(`sdk tool_called name=${toolCall.name}`)
    }
  }
  await stream.completed
  if (stream.error) throw stream.error
  return {
    finalText: typeof stream.finalOutput === 'string' ? stream.finalOutput : '',
  }
}

function stringifyToolResult(output: ToolExecutionOutput): string {
  const normalized = normalizeToolExecutionOutput(output)
  return JSON.stringify({
    text: normalized.text,
    shape: normalized.shape,
    data: normalized.data,
    projectionPatch: normalized.projectionPatch,
    framePatch: normalized.framePatch,
    interactionHint: normalized.interactionHint,
  })
}

function toOpenAIToolSchemas(definitions: ToolDefinition[]): Array<Record<string, unknown>> {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description || definition.name,
      parameters: definition.schema && definition.schema.type === 'object'
        ? definition.schema
        : { type: 'object', properties: {}, additionalProperties: false },
    },
  }))
}

function buildProviderPatchContext(params: {
  config: AIModelConfig
  baseUrl: string
  model: string
}): PatchContext {
  const defaults = resolveProviderDefaultPatchers(params.config.provider)
  return {
    config: params.config,
    baseUrl: params.baseUrl,
    model: params.model,
    profile: resolveProviderPatchProfile(params.config, params.baseUrl, params.model),
    providerDefaultRequestPatcher: defaults.defaultRequestPatcher,
    providerDefaultResponsePatcher: defaults.defaultResponsePatcher,
  }
}

function buildProviderHeaders(config: AIModelConfig, provider: AIProviderDef | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
  return headers
}

function resolveOpenAIProtocolModel(config: AIModelConfig): string {
  if (config.provider === 'volcengine' && config.endpointId) return config.endpointId
  return config.model
}

function normalizeOpenAIChatContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        return { type: 'text', text: String(part.text || '') }
      }
      if (part.type === 'input_image' && typeof part.image === 'string') {
        return { type: 'image_url', image_url: { url: part.image } }
      }
      return { type: 'text', text: '' }
    })
  return parts.length > 0 ? parts : ''
}

function normalizeOpenAIResponsesContent(content: unknown, role: 'user' | 'assistant'): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return [{ type: textType, text: '' }]
  const parts = content
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        return { type: textType, text: String(part.text || '') }
      }
      if (part.type === 'input_image' && typeof part.image === 'string') {
        return { type: 'input_image', image_url: part.image }
      }
      return { type: textType, text: '' }
    })
  return parts.length > 0 ? parts : [{ type: textType, text: '' }]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function continuationChildRunId(options?: AgentSdkExecutionOptions): string | null {
  return nonEmptyString(options?.continuationIntent?.childRunId)
    || nonEmptyString(options?.continuationState?.continuationRef?.childRunId)
}

function projectionPatchFromChildClose(close: SkillChildCloseEvent | null): Record<string, unknown> | null {
  const patch = asRecord(close?.projectionPatch)
  return patch ? { ...patch } : null
}

function turnTerminalReasonFromChildClose(close: SkillChildCloseEvent): TurnTerminalReason {
  if (isCompletedChildCloseStatus(close.status)) return 'done'
  if (isKilledChildCloseStatus(close.status)) return 'cancelled_user'
  switch (close.terminalReason) {
    case 'checkpoint_budget':
      return 'checkpoint_budget'
    case 'checkpoint_background':
    case 'queued_global_concurrency':
    case 'launch_stuck':
      return 'checkpoint_background'
    case 'blocked_config':
      return 'blocked_config'
    case 'blocked_external':
      return 'blocked_external'
    case 'cancelled_user':
      return 'cancelled_user'
    case 'failed_skill':
    case 'child_process_crashed':
    case 'host_unavailable':
    case 'nested_child_run_not_supported':
      return 'failed_skill'
    case 'resume_launch_failed':
      return 'resume_launch_failed'
    case 'persistence_failed':
      return 'persistence_failed'
    case 'tool_not_registered':
    case 'input_validation':
      return 'blocked_tool_error'
    case 'process_restarted':
      return 'checkpoint_background'
    case 'completed':
      return 'done'
    default:
      return 'checkpoint_user_input'
  }
}

function sdkStatusFromTerminalReason(
  reason: TurnTerminalReason,
): 'done' | 'error' | 'cancelled' | 'checkpoint' {
  if (reason === 'done') return 'done'
  if (reason === 'cancelled_user' || reason === 'cancelled_runtime') return 'cancelled'
  if (
    reason === 'failed_skill'
    || reason === 'resume_launch_failed'
    || reason === 'persistence_failed'
    || reason === 'blocked_tool_error'
  ) {
    return 'error'
  }
  return 'checkpoint'
}

function summarizeChildResume(
  childRunId: string,
  close: SkillChildCloseEvent | null,
): {
  message: string
  terminalReason: TurnTerminalReason
  status: 'done' | 'error' | 'cancelled' | 'checkpoint'
} {
  if (!close) {
    return {
      message: `已继续技能任务 ${childRunId}，后台仍在运行。`,
      terminalReason: 'checkpoint_background',
      status: 'checkpoint',
    }
  }
  if (isCompletedChildCloseStatus(close.status)) {
    return {
      message: `技能任务 ${childRunId} 已完成。`,
      terminalReason: 'done',
      status: 'done',
    }
  }
  if (isKilledChildCloseStatus(close.status)) {
    return {
      message: `技能任务 ${childRunId} 已取消。`,
      terminalReason: 'cancelled_user',
      status: 'cancelled',
    }
  }
  const terminalReason = turnTerminalReasonFromChildClose(close)
  const detail = close.error?.message || close.terminalReason
  return {
    message: isFailedChildCloseStatus(close.status)
      ? `继续技能任务 ${childRunId} 失败：${detail}`
      : `技能任务 ${childRunId} 仍在等待：${detail}`,
    terminalReason,
    status: sdkStatusFromTerminalReason(terminalReason),
  }
}

function isChildSkillEnvelopeStatus(status: string | null): boolean {
  return status === 'child_launched'
    || status === 'child_reused'
    || status === 'child_paused'
    || status === 'child_terminal'
}

function shouldRecoverLongSkillCheckpoint(
  checkpoint: SdkLongSkillCheckpoint | null,
): checkpoint is SdkLongSkillCheckpoint {
  if (!checkpoint) return false
  if (checkpoint.terminalReason === 'blocked_config' || checkpoint.terminalReason === 'failed_skill') return false
  return Boolean(checkpoint.childRunId || checkpoint.outputDir || checkpoint.runStatePath)
}

function summarizeLongSkillCheckpoint(checkpoint: SdkLongSkillCheckpoint): string {
  const output = checkpoint.outputDir
    ? `输出目录：${checkpoint.outputDir}`
    : checkpoint.runStatePath
      ? `run_state：${checkpoint.runStatePath}`
      : checkpoint.childRunId
        ? `子任务：${checkpoint.childRunId}`
        : ''
  const action = checkpoint.action || checkpoint.toolName
  return [
    `技能任务已启动并进入后台/暂停状态（${action}）。`,
    output,
    '可以从任务卡继续、取消或查看产物。',
  ].filter(Boolean).join('\n')
}

function extractLongSkillCheckpoint(
  toolName: string,
  output: ToolExecutionOutput,
  previous: SdkLongSkillCheckpoint | null,
): SdkLongSkillCheckpoint | null {
  const normalized = normalizeToolExecutionOutput(output)
  const data = normalized.data
  const status = stringField(data, 'status')
  if (!toolName.startsWith('skill_') || !isChildSkillEnvelopeStatus(status)) return previous

  const closeEvent = asRecord(data?.closeEvent)
  const closeReason = stringField(closeEvent, 'terminalReason')
  const terminalReason: TurnTerminalReason = closeReason === 'blocked_config'
    ? 'blocked_config'
    : closeReason === 'failed_skill'
      ? 'failed_skill'
      : closeReason === 'checkpoint_budget'
        ? 'checkpoint_budget'
        : 'checkpoint_background'
  const next: SdkLongSkillCheckpoint = {
    toolName,
    skillId: stringField(data, 'skillId'),
    action: stringField(data, 'action'),
    childRunId: stringField(data, 'childRunId'),
    outputDir: stringField(data, 'outputDir'),
    runStatePath: stringField(data, 'runStatePath'),
    terminalReason,
  }
  if (!previous) return next
  if ((next.outputDir || next.runStatePath) && !(previous.outputDir || previous.runStatePath)) return next
  return previous
}

function readReasoningContentFromRecord(record: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(record, 'reasoning_content')) {
    return record.reasoning_content
  }
  if (Object.prototype.hasOwnProperty.call(record, 'reasoningContent')) {
    return record.reasoningContent
  }
  const additional = asRecord(record.additional_kwargs) || asRecord(record.additionalKwargs)
  if (additional && Object.prototype.hasOwnProperty.call(additional, 'reasoning_content')) {
    return additional.reasoning_content
  }
  const providerData = asRecord(record.providerData)
  if (providerData) {
    const fromProviderData = readReasoningContentFromRecord(providerData)
    if (fromProviderData !== undefined) return fromProviderData
  }
  return undefined
}

function reasoningProviderData(reasoningContent: unknown): Record<string, unknown> | undefined {
  return reasoningContent !== undefined ? { reasoning_content: reasoningContent } : undefined
}

/**
 * PR 2 (Phase C.2 second segment) — resolve a `MessageCapabilitySnapshot`
 * from the runtime AIModelConfig and apply `sanitizeHistoricalMessagesByCapability`
 * to a provider-formatted message list. All three model builders below
 * (chat-completions, responses, anthropic) funnel through this helper so
 * the contract is enforced uniformly.
 *
 * Emits `provider_request_capability_filter` when any blocks were removed,
 * so operators can see which provider routes had image residue in their
 * history.
 */
function sanitizeMessagesForModelClient(
  rawMessages: ReadonlyArray<Record<string, unknown>>,
  config: AIModelConfig,
  route: 'openai-chat' | 'openai-responses' | 'anthropic',
): Array<Record<string, unknown>> {
  const resolved = resolveAIConfigCapabilities(config)
  const snapshot: MessageCapabilitySnapshot = {
    supportsVision: resolved?.supportsVision === true,
    // PR 2 review patch — must consult `supportsNativeVideo` (true on
    // providers like Anthropic / Gemini that natively accept video blocks)
    // instead of hardcoding `false`, otherwise multi-turn video tasks lose
    // their video blocks at history sanitize even on capable providers.
    supportsVideo: resolved?.supportsNativeVideo === true,
  }
  if (snapshot.supportsVision && snapshot.supportsVideo) {
    return rawMessages.slice()
  }
  const decision = sanitizeHistoricalMessagesByCapability(
    rawMessages as unknown as CapabilityMessage[],
    snapshot,
  )
  if (decision.removedImageBlocks > 0 || decision.removedVideoBlocks > 0) {
    logAgentMetric('provider_request_capability_filter', {
      route,
      removedImageBlocks: decision.removedImageBlocks,
      removedVideoBlocks: decision.removedVideoBlocks,
      replacedWithPlaceholders: decision.replacedWithPlaceholders,
      model: config.model,
      provider: config.provider,
    })
  }
  return decision.filtered as unknown as Array<Record<string, unknown>>
}

function modelInputToOpenAIChatMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      const callId = String(item.callId || item.call_id || item.id || `call-${randomUUID()}`)
      const reasoningContent = readReasoningContentFromRecord(item)
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: String(item.name || ''),
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
          },
        }],
        ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output || '')
      messages.push({
        role: 'tool',
        tool_call_id: String(item.callId || item.call_id || item.id || ''),
        content: output,
      })
      continue
    }
    const role = item.role === 'assistant' || item.role === 'user' || item.role === 'system'
      ? item.role
      : null
    if (!role) continue
    const reasoningContent = readReasoningContentFromRecord(item)
    messages.push({
      role,
      content: normalizeOpenAIChatContent(item.content),
      ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

function modelInputToOpenAIResponsesInput(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'input_text', text: input }] }]
  }
  const items: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      items.push({
        type: 'function_call',
        call_id: String(item.callId || item.call_id || item.id || `call-${randomUUID()}`),
        name: String(item.name || ''),
        arguments: typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments || {}),
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output || '')
      items.push({
        type: 'function_call_output',
        call_id: String(item.callId || item.call_id || item.id || ''),
        output,
      })
      continue
    }
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    items.push({
      role,
      content: normalizeOpenAIResponsesContent(item.content, role),
    })
  }
  return items.length > 0 ? items : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }]
}

function serializeSdkOpenAITools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      type: 'function',
      function: {
        name: item.name,
        description: item.description || item.name,
        parameters: item.parameters && typeof item.parameters === 'object'
          ? item.parameters
          : { type: 'object', properties: {}, additionalProperties: false },
      },
    }))
}

function serializeSdkOpenAIResponsesTools(request: ModelRequest): Array<Record<string, unknown>> {
  return serializeSdkOpenAITools(request).map((item) => {
    const fn = item.function as Record<string, unknown>
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    }
  })
}

function textFromAgentOutputItem(item: AgentOutputItem): string {
  if (item.type !== 'message') return ''
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) => part && typeof part === 'object' && part.type === 'output_text' ? String(part.text || '') : '')
    .join('')
}

function extractResponsesText(payload: Record<string, unknown>): string {
  const output = Array.isArray(payload.output) ? payload.output as Array<Record<string, unknown>> : []
  const texts: string[] = []
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
    for (const part of content) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  if (texts.length > 0) return texts.join('')
  return typeof payload.output_text === 'string' ? payload.output_text : ''
}

function openAIUsageFromJson(json: Record<string, unknown>): Usage {
  const usage = json.usage && typeof json.usage === 'object'
    ? json.usage as Record<string, unknown>
    : {}
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || 0)
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || usage.outputTokens || 0)
  const totalTokens = Number(usage.total_tokens || usage.totalTokens || inputTokens + outputTokens || 0)
  return new Usage({
    inputTokens,
    outputTokens,
    totalTokens,
  })
}

function toOpenAIMessageOutput(
  text: string,
  id: string,
  providerData?: Record<string, unknown>,
): AgentOutputItem[] {
  if (!text) return []
  return [{
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
    ...(providerData ? { providerData } : {}),
  } as AgentOutputItem]
}

function toOpenAIFunctionCallOutput(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  id: string,
  providerData?: Record<string, unknown>,
): AgentOutputItem[] {
  return calls.map((call) => ({
    id,
    type: 'function_call',
    callId: call.id || `call-${randomUUID()}`,
    name: call.name,
    status: 'completed',
    arguments: JSON.stringify(call.input || {}),
    ...(providerData ? { providerData } : {}),
  } as AgentOutputItem))
}

// PR 2 (review patch) — test seam: the Model classes are exported under a
// `__forTests` namespace so behavior tests can mount them directly with a
// fake fetch and assert the actual outbound request body. Production code
// continues to construct them via the providers above; the seam is purely
// for `src/__tests__/agent-sdk-runtime-capability-body.test.ts`.
class ReadyOpenAICompatibleModelProvider implements ModelProvider {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  getModel(): Model {
    return new ReadyOpenAICompatibleModel(this.deps)
  }
}

export class ReadyOpenAICompatibleModel implements Model {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-openai-compatible')
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const runtime = resolveOpenAIProviderRuntime({
      config: this.deps.config,
      provider,
      baseUrl: this.deps.baseUrl,
    })
    return runtime.wireApi === 'responses'
      ? this.getResponsesResponse(request, provider, runtime)
      : this.getChatCompletionsResponse(request, provider)
  }

  private async getChatCompletionsResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
  ): Promise<ModelResponse> {
    const responseId = `openai-compatible-${randomUUID()}`
    const model = resolveOpenAIProtocolModel(this.deps.config)
    const messages = [
      { role: 'system', content: request.systemInstructions || '' },
      // PR 2 Phase C.2 second segment — sanitize history-side multimodal
      // blocks per current capability. Current turn was already gated at
      // SDK entry, so any image residue here is from prior turns.
      ...sanitizeMessagesForModelClient(
        modelInputToOpenAIChatMessages(request.input),
        this.deps.config,
        'openai-chat',
      ),
    ]
    const body: Record<string, unknown> = { model, messages }
    const tools = serializeSdkOpenAITools(request)
    if (tools.length > 0) body.tools = tools
    const patchContext = buildProviderPatchContext({
      config: this.deps.config,
      baseUrl: this.deps.baseUrl,
      model,
    })
    applyProviderRequestPatch(body, patchContext)

    const url = `${this.deps.baseUrl}/chat/completions`
    const response = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: buildProviderHeaders(this.deps.config, provider),
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.signal || new AbortController().signal, 'agents-sdk openai-compatible chat')
    const rawText = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 300)}`)
    const json = JSON.parse(rawText || '{}') as Record<string, unknown>
    applyProviderResponsePatch(json, patchContext)
    const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : []
    const choice = choices[0] || {}
    const message = choice.message && typeof choice.message === 'object'
      ? choice.message as Record<string, unknown>
      : {}
    const built = buildChatCompletionsToolCalls(message.tool_calls as never)
    const text = typeof message.content === 'string' ? message.content : ''
    const providerData = reasoningProviderData(readReasoningContentFromRecord(message))
    return {
      usage: openAIUsageFromJson(json),
      output: [
        ...toOpenAIMessageOutput(text, responseId, providerData),
        ...toOpenAIFunctionCallOutput(built.toolCalls, responseId, providerData),
      ],
      responseId: String(json.id || responseId),
      providerData: json,
    }
  }

  private async getResponsesResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>,
  ): Promise<ModelResponse> {
    const responseId = `openai-compatible-${randomUUID()}`
    const model = resolveOpenAIProtocolModel(this.deps.config)
    const body: Record<string, unknown> = {
      model,
      instructions: request.systemInstructions || '',
      // PR 2 Phase C.2 second segment — same history sanitization for the
      // Responses API path. Block types differ (`input_image` here) but the
      // helper recognizes all three legal names.
      input: sanitizeMessagesForModelClient(
        modelInputToOpenAIResponsesInput(request.input),
        this.deps.config,
        'openai-responses',
      ),
      stream: false,
    }
    if (runtime.reasoningEffort) body.reasoning = { effort: runtime.reasoningEffort }
    const tools = serializeSdkOpenAIResponsesTools(request)
    if (tools.length > 0) body.tools = tools
    const patchContext = buildProviderPatchContext({
      config: this.deps.config,
      baseUrl: this.deps.baseUrl,
      model,
    })
    applyProviderRequestPatch(body, patchContext)

    const url = `${this.deps.baseUrl}/responses`
    const response = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: buildProviderHeaders(this.deps.config, provider),
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.signal || new AbortController().signal, 'agents-sdk openai-compatible responses')
    if (!response.ok) {
      const rawError = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${rawError.slice(0, 300)}`)
    }
    const json = await parseJsonOrEventStreamResponse(response, { requestUrl: url }) as Record<string, unknown>
    applyProviderResponsePatch(json, patchContext)
    const output = Array.isArray(json.output) ? json.output as Array<Record<string, unknown>> : []
    const built = buildResponsesToolCalls(output, () => `respfc_${randomUUID().replace(/-/g, '')}`)
    const text = extractResponsesText(json)
    return {
      usage: openAIUsageFromJson(json),
      output: [
        ...toOpenAIMessageOutput(text, String(json.id || responseId)),
        ...toOpenAIFunctionCallOutput(built.toolCalls, String(json.id || responseId)),
      ],
      responseId: String(json.id || responseId),
      providerData: json,
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request)
    for (const item of response.output) {
      const text = textFromAgentOutputItem(item)
      if (text) {
        yield { type: 'output_text_delta', delta: text } as StreamEvent
      }
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId || `openai-compatible-${randomUUID()}`,
        requestId: response.requestId,
        usage: {
          requests: response.usage.requests,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          inputTokensDetails: {},
          outputTokensDetails: {},
        },
        output: response.output,
      },
    } as StreamEvent
  }
}

function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    // silent-catch: malformed provider JSON is treated as an empty object.
    return {}
  }
}

function dataUrlToAnthropicImage(value: string): Record<string, unknown> | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) return null
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  }
}

function contentPartToAnthropic(part: Record<string, unknown>): Record<string, unknown> | null {
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return { type: 'text', text: String(part.text || '') }
  }
  if (part.type === 'input_image' && typeof part.image === 'string') {
    return dataUrlToAnthropicImage(part.image) || { type: 'text', text: '[图片附件]' }
  }
  return null
}

function sanitizeAnthropicThinkingBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  if (block.type !== 'thinking' || typeof block.thinking !== 'string') return null
  return {
    type: 'thinking',
    thinking: block.thinking,
    ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
  }
}

function readAnthropicThinkingBlocksFromRecord(record: Record<string, unknown>): Record<string, unknown>[] {
  const direct = Array.isArray(record.anthropicThinkingBlocks)
    ? record.anthropicThinkingBlocks
    : null
  if (direct) {
    return direct
      .map((item) => item && typeof item === 'object'
        ? sanitizeAnthropicThinkingBlock(item as Record<string, unknown>)
        : null)
      .filter((item): item is Record<string, unknown> => Boolean(item))
  }
  const providerData = asRecord(record.providerData)
  if (!providerData) return []
  return readAnthropicThinkingBlocksFromRecord(providerData)
}

function normalizeAnthropicContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => item && typeof item === 'object' ? contentPartToAnthropic(item as Record<string, unknown>) : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
  return parts.length > 0 ? parts : ''
}

function modelInputToAnthropicMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      const thinkingBlocks = readAnthropicThinkingBlocksFromRecord(item)
      messages.push({
        role: 'assistant',
        content: [
          ...thinkingBlocks,
          {
            type: 'tool_use',
            id: String(item.callId || item.id || ''),
            name: String(item.name || ''),
            input: typeof item.arguments === 'string' ? safeJsonParseObject(item.arguments) : {},
          },
        ],
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output || '')
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.callId || item.id || ''),
          content: output,
        }],
      })
      continue
    }
    const role = item.role === 'assistant' || item.role === 'user'
      ? item.role
      : item.role === 'system'
        ? 'user'
        : null
    if (!role) continue
    messages.push({
      role,
      content: normalizeAnthropicContent(item.content),
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

function serializeAnthropicTools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      name: item.name,
      description: item.description || item.name,
      input_schema: item.parameters && typeof item.parameters === 'object'
        ? item.parameters
        : { type: 'object', properties: {}, additionalProperties: false },
    }))
}

function extractAnthropicOutput(json: Record<string, unknown>, fallbackId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  const content = Array.isArray(json.content) ? json.content as Array<Record<string, unknown>> : []
  const thinkingBlocks = content
    .map(sanitizeAnthropicThinkingBlock)
    .filter((block): block is Record<string, unknown> => Boolean(block))
  const providerData = thinkingBlocks.length > 0
    ? { anthropicThinkingBlocks: thinkingBlocks }
    : undefined
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('')
  if (text) {
    output.push({
      id: String(json.id || fallbackId),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    } as AgentOutputItem)
  }
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    output.push({
      id: String(json.id || fallbackId),
      type: 'function_call',
      callId: String(block.id || `call-${randomUUID()}`),
      name: String(block.name || ''),
      status: 'completed',
      arguments: JSON.stringify(
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input
          : {},
      ),
      ...(providerData ? { providerData } : {}),
    } as AgentOutputItem)
  }
  return output
}

class ReadyAnthropicModelProvider implements ModelProvider {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  getModel(): Model {
    return new ReadyAnthropicModel(this.deps)
  }
}

export class ReadyAnthropicModel implements Model {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-anthropic')
    const responseId = `anthropic-${randomUUID()}`
    const body: Record<string, unknown> = {
      model: this.deps.config.model,
      max_tokens: request.modelSettings.maxTokens || 4096,
      system: request.systemInstructions || '',
      // PR 2 Phase C.2 second segment — Anthropic path. Block types here
      // include `image` (block.source variant) which the helper recognizes.
      messages: sanitizeMessagesForModelClient(
        modelInputToAnthropicMessages(request.input),
        this.deps.config,
        'anthropic',
      ),
    }
    const tools = serializeAnthropicTools(request)
    if (tools.length > 0) body.tools = tools
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${this.deps.config.apiKey}`
    if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)

    const url = `${this.deps.baseUrl}/v1/messages`
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.signal || new AbortController().signal, 'agents-sdk anthropic model')
    const rawText = await resp.text()
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${rawText.slice(0, 300)}`)
    }
    const json = JSON.parse(rawText || '{}') as Record<string, unknown>
    const usage = json.usage && typeof json.usage === 'object'
      ? json.usage as Record<string, unknown>
      : {}
    return {
      usage: new Usage({
        inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
        outputTokens: Number(usage.output_tokens || usage.outputTokens || 0),
        totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
      }),
      output: extractAnthropicOutput(json, responseId),
      responseId: String(json.id || responseId),
      providerData: json,
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request)
    for (const item of response.output) {
      if (item.type !== 'message') continue
      for (const part of item.content || []) {
        if (part && typeof part === 'object' && part.type === 'output_text' && part.text) {
          yield { type: 'output_text_delta', delta: part.text } as StreamEvent
        }
      }
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId || `anthropic-${randomUUID()}`,
        requestId: response.requestId,
        usage: {
          requests: response.usage.requests,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          inputTokensDetails: {},
          outputTokensDetails: {},
        },
        output: response.output,
      },
    } as StreamEvent
  }
}

function publicAgentName(agentName: string): string {
  const marker = agentName.indexOf('::')
  return marker === -1 ? agentName : agentName.slice(0, marker)
}

function scopeRunModuleForTool(definition: ToolDefinition): ScopeRunEventPayload['module'] {
  if (definition.domain === 'general_research') return 'research'
  if (
    definition.domain === 'file'
    || definition.domain === 'memory'
    || definition.domain === 'session'
    || definition.domain === 'mcp'
    || definition.domain === 'pet'
    // agent_interaction has no scope-run module concept (it's a reflection
    // pause, not a domain-owned action) — bucket it under `system` so the
    // scope-run timeline still captures the tool call for observability.
    || definition.domain === 'agent_interaction'
  ) {
    return 'system'
  }
  return definition.domain
}

function formatToolCallTrace(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
    .filter((key) => !/(?:key|token|secret|password|authorization)/i.test(key))
    .slice(0, 6)
  return `${toolName}(${keys.join(', ')})`
}

function formatToolResultTrace(toolName: string, output: ToolExecutionOutput): string {
  const normalized = normalizeToolExecutionOutput(output)
  const text = String(normalized.text || '').trim()
  return text ? `${toolName}: ${text.slice(0, 240)}` : `${toolName}: 已完成`
}

export class AgentSdkRuntime extends EventEmitter {
  private readonly sessions = new Map<string, AgentSdkSession>()
  private readonly domainAdapters: ReadonlyArray<DomainAdapter>
  private readonly loadAIConfig: () => AIConfigLoad
  private readonly runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  private readonly listToolDefinitionsForTurn: NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>
  private readonly executeToolCall: NonNullable<AgentSdkRuntimeDeps['executeToolCall']>
  private readonly fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  private readonly skillContextOrchestrator: SkillContextOrchestratorLike | null
  private browserController: BrowserController | null = null
  private sidecarManager: SidecarManager | null = null
  private runtime: AgentControlRuntime | null = null
  private runCleanupRegistry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null = null
  private rendererToolActionRequester: ((payload: {
    agent?: string
    sessionId?: string
    runId?: string
    tool: string
    args: Record<string, unknown>
  }) => Promise<Record<string, unknown>>) | null = null
  private cancelPendingToolActions: ((agent: string, sessionId?: string) => void) | null = null

  constructor(deps: AgentSdkRuntimeDeps = {}) {
    super()
    this.domainAdapters = deps.domainAdapters || []
    this.loadAIConfig = deps.loadAIConfig || (() =>
      readAIConfigDetailed(() => settingsRepository.getSetting('ai_model_config')))
    this.runAgent = deps.runAgent || runWithOpenAIAgentsSdk
    this.executeToolCall = deps.executeToolCall || executeReadyToolCall
    this.fetchWithTimeout = deps.fetchWithTimeout || defaultFetchWithTimeout
    this.skillContextOrchestrator = deps.skillContextOrchestrator || null
    this.listToolDefinitionsForTurn = deps.listToolDefinitions || ((params) =>
      this.listDefaultToolDefinitionsForTurn(params))
  }

  setRunCleanupRegistry(registry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null): void {
    this.runCleanupRegistry = registry
  }

  setBrowserController(controller: BrowserController): void {
    this.browserController = controller
  }

  hasBrowserController(): boolean {
    return Boolean(this.browserController)
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapters
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.runtime = runtime
  }

  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.rendererToolActionRequester = requester
  }

  setCancelPendingToolActions(
    canceller: ((agent: string, sessionId?: string) => void) | null,
  ): void {
    this.cancelPendingToolActions = canceller
  }

  private listDefaultToolDefinitionsForTurn(params: {
    message: RunMessage
    sessionId?: string
    scopeId?: string
    config: AIModelConfig
    browserHostAvailable: boolean
    feishuConnected: boolean
    authorization: SkillToolAuthorization
  }): ToolDefinition[] {
    const capabilityResolution = resolveCapabilityResolution({
      config: params.config,
      profile: 'local_chat',
      browserDecisionMode: resolveBrowserDecisionMode(params.message, params.browserHostAvailable),
      runtimeAvailability: {
        browserHostAvailable: params.browserHostAvailable,
        feishuConnected: params.feishuConnected,
      },
    })
    const definitions = capabilityResolution.visibleCapabilityGroupIds.flatMap((groupId) =>
      defaultToolRegistry.getToolDefinitionsForGroup(
        groupId,
        params.sessionId,
        params.authorization,
        params.scopeId,
      ))
    return filterToolsByVisionCapability(
      definitions as unknown as Array<Record<string, unknown>>,
      { supportsVision: capabilityResolution.supportsVision === true },
    ) as unknown as ToolDefinition[]
  }

  newSession(name: string, systemPrompt?: string): void {
    this.stopGeneration(name)
    this.sessions.set(name, {
      sdkSession: new MemorySession({ sessionId: name }),
      abortController: null,
      systemPrompt: systemPrompt || defaultSystemPrompt(),
      generation: 0,
      activeRunId: null,
    })
  }

  setSystemPrompt(name: string, systemPrompt?: string): void {
    if (!this.sessions.has(name)) {
      this.newSession(name, systemPrompt)
      return
    }
    const session = this.sessions.get(name)!
    session.systemPrompt = systemPrompt || defaultSystemPrompt()
  }

  stopGeneration(name: string): void {
    const session = this.sessions.get(name)
    if (!session) return
    const runId = session.activeRunId
    session.generation += 1
    if (session.abortController) {
      try {
        this.cancelPendingToolActions?.(name)
      } catch (error) {
        log(`cancelPendingToolActions failed: ${errorMessage(error)}`)
      }
      session.abortController.abort(new Error('cancelled_user'))
      session.abortController = null
    }
    if (runId) {
      this.emit('status', {
        agent: name,
        runId,
        status: 'cancelled',
        terminalReason: 'cancelled_user',
        isMock: false,
      })
      session.activeRunId = null
    }
  }

  async sendMessage(
    name: string,
    content: string | MultimodalBlock[],
    requestId?: string,
    executionOptions?: AgentSdkExecutionOptions,
  ): Promise<ExecutionTurnResult> {
    const runId = requestId || randomUUID()
    if (!this.sessions.has(name)) {
      this.newSession(name)
    }
    const session = this.sessions.get(name)!
    const taskId = executionOptions?.taskId || `task-${runId}`
    const sessionId = executionOptions?.publicSessionId || this.extractSessionIdFromInternalName(name)
    const transcriptEvents: TurnTranscriptEvent[] = []
    const usedTools: string[] = []
    const projectionPatches: Record<string, unknown>[] = []
    const activeFrame = createEmptyActiveFrameContext()
    let longSkillCheckpoint: SdkLongSkillCheckpoint | null = null
    let finalText = ''
    let documentTargetGuardForRecovery: DocumentTargetGuard | null = null
    let requiresLocalDocumentExcerptForRecovery = false
    let hasSuccessfulDocumentTargetMutation = false
    let lastDocumentSaveSuccessText: string | null = null

    if (session.abortController) {
      const previousAbortController = session.abortController
      try {
        this.cancelPendingToolActions?.(name, sessionId)
      } catch (error) {
        log(`preempt cancelPendingToolActions failed: ${errorMessage(error)}`)
      }
      session.generation += 1
      previousAbortController.abort(new Error('process_restarted'))
      session.abortController = null
      log(`preempted previous SDK run agent=${name}`)
    }

    session.generation += 1
    const runGeneration = session.generation
    session.activeRunId = runId
    const abortController = new AbortController()
    session.abortController = abortController

    const isCurrentRun = (): boolean => {
      const latest = this.sessions.get(name)
      return Boolean(latest && latest.generation === runGeneration && latest.activeRunId === runId)
    }
    const emitOutput = (chunk: string, type: string, projectionPatch?: Record<string, unknown> | null): void => {
      if (!isCurrentRun()) return
      transcriptEvents.push({ kind: 'output', type, chunk, projectionPatch: projectionPatch || null })
      this.emit('output', {
        agent: name,
        sessionId,
        runId,
        taskId,
        chunk,
        type,
        projectionPatch: projectionPatch || null,
      })
    }
    const emitStatus = (status: string, terminalReason?: TurnTerminalReason | null): void => {
      if (!isCurrentRun()) return
      transcriptEvents.push({ kind: 'status', status, terminalReason: terminalReason || null })
      this.emit('status', {
        agent: name,
        sessionId,
        runId,
        status,
        ...(typeof terminalReason === 'undefined' ? {} : { terminalReason }),
        isMock: false,
      })
    }
    const emitRuntimeError = (error: unknown, terminalReason: TurnTerminalReason): void => {
      if (!isCurrentRun()) return
      const message = errorMessage(error)
      transcriptEvents.push({ kind: 'error', error: message })
      this.emit('error', {
        agent: name,
        sessionId,
        runId,
        error: message,
        type: 'runtime',
        errorKind: terminalReason,
        recoverable: false,
      })
    }

    emitStatus('working')

    try {
      const configDetail = this.loadAIConfig()
      if (!configDetail.ok) {
        const userMessage =
          configDetail.reason === 'json_corrupt'
            ? 'AI 配置已损坏（JSON 解析失败），请前往设置页重置'
            : 'AI 配置读取失败（数据库错误），请稍后重试或检查日志'
        emitOutput(userMessage, 'error')
        emitOutput('', 'done')
        emitStatus('error', configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed')
        return this.buildResult({
          success: false,
          error: userMessage,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed',
        })
      }
      if (!configDetail.config?.apiKey) {
        const userMessage = '未配置 API Key，请前往设置页配置'
        emitOutput(userMessage, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'blocked_config')
        return this.buildResult({
          success: false,
          error: userMessage,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'blocked_config',
        })
      }

      const normalizedConfig = normalizeAIConfig(configDetail.config)
      const { provider, model } = resolveAgentSdkProvider(normalizedConfig, {
        fetchWithTimeout: this.fetchWithTimeout,
      })
      const capabilities = resolveAIConfigCapabilities(normalizedConfig)
      const useTextToolBridge = capabilities?.toolCallTransport === 'text'
      const agentContext = buildAgentSpawnContextFromAIConfig(normalizedConfig, {
        baseUrl: String(capabilities?.baseUrl || normalizedConfig.baseUrl || '').trim(),
      })
      const resumeChildRunId = continuationChildRunId(executionOptions)
      if (resumeChildRunId) {
        usedTools.push('skill_child_resume')
        transcriptEvents.push({
          kind: 'tool_action',
          tool: 'skill_child_resume',
          args: { childRunId: resumeChildRunId },
        })
        this.emit('toolAction', {
          agent: name,
          sessionId,
          runId,
          tool: 'skill_child_resume',
          args: { childRunId: resumeChildRunId },
        })
        emitOutput(`正在继续技能任务 ${resumeChildRunId}。`, 'text')
        const resumed = await resumeSkillChildRun(resumeChildRunId, { agentContext })
        const waited = resumed.closeEvent
          ? null
          : await waitForSkillChildRunClose(resumed.childRunId, {
            timeoutMs: SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS,
            signal: abortController.signal,
          })
        const close = resumed.closeEvent || (waited?.kind === 'closed' ? waited.closeEvent : null)
        const closeProjectionPatch = projectionPatchFromChildClose(close)
        if (closeProjectionPatch) {
          projectionPatches.push(closeProjectionPatch)
        }
        const outcome = summarizeChildResume(resumed.childRunId, close)
        finalText = outcome.message
        emitOutput(outcome.message, outcome.status === 'error' ? 'error' : 'text', closeProjectionPatch)
        emitOutput('', 'done', closeProjectionPatch)
        emitStatus(outcome.status, outcome.terminalReason)
        return this.buildResult({
          success: outcome.status !== 'error',
          error: outcome.status === 'error' ? outcome.message : undefined,
          finalText,
          cancelled: outcome.status === 'cancelled',
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: outcome.terminalReason,
        })
      }
      const authorization = this.resolveSkillAuthorizationForTurn(content as RunMessage, sessionId)
      const documentTargetGuard = resolveDocumentTargetGuard(content as RunMessage, executionOptions?.requestEnvelope)
      documentTargetGuardForRecovery = documentTargetGuard
      if (documentTargetGuard?.preserveExistingContent) {
        await hydrateDocumentTargetPreservation(documentTargetGuard)
      }
      const requiresLocalDocumentExcerpt = shouldRequireLocalDocumentExcerpt(
        content as RunMessage,
        executionOptions?.requestEnvelope,
      )
      requiresLocalDocumentExcerptForRecovery = requiresLocalDocumentExcerpt
      let toolDefinitions = this.listToolDefinitionsForTurn({
        message: content as RunMessage,
        sessionId,
        scopeId: sessionId,
        config: configDetail.config,
        browserHostAvailable: this.hasBrowserController(),
        feishuConnected: this.runtime?.isChannelTypeAvailable?.('feishu-app') ?? false,
        authorization,
      })
      if (shouldUseLocalDocumentToolSet(content as RunMessage, executionOptions?.requestEnvelope)) {
        toolDefinitions = toolDefinitions.filter(isLocalDocumentToolDefinition)
      }
      if (documentTargetGuard) {
        documentTargetGuard.openToolDefinition = toolDefinitions.find((definition) => definition.name === 'document_open_tab')
        documentTargetGuard.saveToolDefinition = toolDefinitions.find((definition) => definition.name === 'document_save_tab')
        toolDefinitions = toolDefinitions.filter((definition) => definition.name !== 'document_new_tab')
      }
      const hasVeaPipelineTool = toolDefinitions.some((definition) => definition.name === 'skill_video_expert_pipeline')
      const allowedToolNames = toolDefinitions.map((definition) => definition.name)
      let lastDocumentSaveFailure: string | null = null
      let newDocumentNeedsSave = false
      const toolBridgeRuntimeContext: ToolBridgeRuntimeContext = {
        agentName: name,
        runId,
        taskId,
        sessionId,
        signal: abortController.signal,
        allowedToolNames,
        authorization,
        activeFrame,
        documentTargetGuard,
        emitOutput,
        emitToolAction: (toolName, args) => {
          if (!isCurrentRun()) return
          transcriptEvents.push({ kind: 'tool_action', tool: toolName, args })
          this.emit('toolAction', { agent: name, sessionId, runId, tool: toolName, args })
        },
        recordToolResult: (toolName, output) => {
          usedTools.push(toolName)
          const normalized = normalizeToolExecutionOutput(output)
          const documentToolFailed = this.isDocumentToolFailure(normalized)
          const documentToolChangedContent = DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(toolName)
            && !documentToolFailed
            && documentToolMutatedContent(normalized)
          if (documentToolChangedContent) {
            hasSuccessfulDocumentTargetMutation = true
          }
          if (
            documentToolChangedContent
            && usedTools.includes('document_new_tab')
          ) {
            newDocumentNeedsSave = true
          }
          if (toolName === 'document_save_tab') {
            lastDocumentSaveFailure = documentToolFailed
              ? normalized.text || 'document_save_tab failed'
              : null
            if (!documentToolFailed && documentSaveSucceeded(normalized)) {
              lastDocumentSaveSuccessText = normalized.text
              newDocumentNeedsSave = false
            }
          }
          applyContextModifier(toolBridgeRuntimeContext, normalized)
          longSkillCheckpoint = extractLongSkillCheckpoint(toolName, normalized, longSkillCheckpoint)
          if (normalized.projectionPatch) {
            projectionPatches.push(normalized.projectionPatch)
          }
        },
        agentContext,
      }
      const definitionByName = new Map(toolDefinitions.map((definition) => [definition.name, definition]))
      const sdkTools = useTextToolBridge
        ? []
        : toolDefinitions.map((definition) => this.buildSdkTool(definition, toolBridgeRuntimeContext))

      const instructions = [
        session.systemPrompt,
        '你现在运行在 Ready 的 OpenAI Agents SDK 实验路径中。',
        '能用工具完成的事情要直接完成；过程和最后回复都使用简单中文。',
        sdkTools.length > 0
          ? '本轮可用工具已经按 Ready 的策略过滤。不要声称使用不存在的工具。'
          : '本轮没有开放工具；直接回答或说明缺口。',
        hasVeaPipelineTool
          ? '本轮 VEA 长任务必须优先调用 skill_video_expert_pipeline；不要用 skill_run_shell、手工建目录或口头说明替代真实启动。'
          : '',
        buildDocumentTargetInstruction(documentTargetGuard),
        buildLocalDocumentExcerptInstruction(requiresLocalDocumentExcerpt),
        useTextToolBridge && toolDefinitions.length > 0
          ? buildTextToolBridgePrompt(toOpenAIToolSchemas(toolDefinitions))
          : '',
        `当前日期：${new Date().toISOString().slice(0, 10)}`,
      ].join('\n')

      // PR 2 (Phase C.2 first segment) — current-turn capability pre-check.
      // If `content` is a multimodal block array (image/video/...), validate
      // it BEFORE entering the SDK. Vision-off + image → throws
      // `ToolDomainError('provider_request_failed')` with recoverable:false.
      // Subsequent provider request builders can then assume any remaining
      // image/video blocks are historical residue and strip them silently
      // (the second SDK-side segment lives in the provider Model classes).
      if (Array.isArray(content)) {
        // MultimodalBlock shapes vary by `block.type`; treat each as a
        // record-with-type for the capability check (helper only inspects
        // `type`). The cast keeps the helper free of MultimodalBlock import.
        const blocksForCheck = content
          .filter((b): b is MultimodalBlock => Boolean(b && typeof b === 'object'))
          .map((b) => ({ ...(b as unknown as Record<string, unknown>) })) as Array<{ type: string; [key: string]: unknown }>
        try {
          assertCurrentMessageCapability(blocksForCheck, {
            supportsVision: capabilities?.supportsVision === true,
            // PR 2 review patch — `supportsNativeVideo` is the existing
            // capability flag that tracks "this provider accepts native
            // video blocks". Hardcoding `false` here blocked legitimate
            // multi-turn video tasks at SDK entry.
            supportsVideo: capabilities?.supportsNativeVideo === true,
          })
        } catch (capErr) {
          const userMessage = capErr instanceof Error ? capErr.message : String(capErr)
          logAgentMetric(TOOL_ERROR_METRICS.providerRequestImageBlockedAtAttach, {
            sessionId,
            errorMessage: userMessage.slice(0, 200),
          })
          emitOutput(userMessage, 'error')
          emitOutput('', 'done')
          emitStatus('error', 'blocked_config')
          return this.buildResult({
            success: false,
            error: userMessage,
            finalText: '',
            cancelled: false,
            taskId,
            usedTools,
            transcriptEvents,
            projectionPatches,
            terminalReason: 'blocked_config',
          })
        }
      }
      let nextInput = toSdkInput(content as RunMessage)
      let documentTargetRepairAttempts = 0
      let documentTargetContinuationRepairAttempts = 0
      let documentTargetContentRepairAttempts = 0
      let newDocumentSaveRepairAttempts = 0
      let localDocumentExcerptRepairAttempts = 0
      const bufferNativeTextUntilParsed =
        !useTextToolBridge
        && toolDefinitions.length > 0
        && (normalizedConfig.provider !== 'openai' || capabilities?.agentProtocol === 'anthropic')
      for (let bridgeTurn = 0; bridgeTurn < (useTextToolBridge ? 4 : 3); bridgeTurn += 1) {
        let streamedText = ''
        const runResult = await this.runAgent({
          agentName: name,
          runId,
          taskId,
          sessionId,
          input: nextInput,
          instructions,
          model,
          provider,
          session: session.sdkSession,
          tools: sdkTools,
          signal: abortController.signal,
          onTextDelta: (delta) => {
            streamedText += delta
            if (!useTextToolBridge && !bufferNativeTextUntilParsed) {
              emitOutput(delta, 'text')
            }
          },
        })
        const modelText = runResult.finalText || streamedText
        if (!useTextToolBridge) {
          let leakedToolCall = /<tool_call>|<function=|<parameter=|:::tool_call/i.test(modelText)
            ? parseTextToolBridgeResponse(modelText)
            : { visibleText: modelText, toolCalls: [] }
          if (leakedToolCall.toolCalls.length === 0 && /<tool_call>|<function=|<parameter=/i.test(modelText)) {
            leakedToolCall = recoverLooseXmlToolCallText(modelText)
          }
          if (leakedToolCall.toolCalls.length > 0) {
            if (leakedToolCall.visibleText && !shouldSuppressVisibleTextOnToolCall(leakedToolCall.visibleText)) {
              emitOutput(leakedToolCall.visibleText, 'text')
            }
            const bridgeResults: Array<{ id: string; name: string; result: ToolExecutionOutput }> = []
            for (const call of leakedToolCall.toolCalls) {
              const definition = definitionByName.get(call.name)
              if (!definition) {
                bridgeResults.push({
                  id: `native-xml-recovery-${bridgeTurn}-${bridgeResults.length}`,
                  name: call.name,
                  result: createToolExecutionOutput(`工具 ${call.name} 未在本轮授权列表中。`, {
                    shape: 'json',
                    data: {
                      errorKind: 'tool_restricted_this_turn',
                      toolName: call.name,
                    },
                  }),
                })
                continue
              }
              const output = await this.executeReadyToolDefinition(
                definition,
                call.args,
                toolBridgeRuntimeContext,
              )
              if (call.name === 'document_save_tab') {
                lastDocumentSaveFailure = this.isDocumentToolFailure(output)
                  ? normalizeToolExecutionOutput(output).text || 'document_save_tab failed'
                  : null
              }
              bridgeResults.push({
                id: `native-xml-recovery-${bridgeTurn}-${bridgeResults.length}`,
                name: call.name,
                result: output,
              })
            }
            nextInput = buildTextToolResultMessage(bridgeResults)
            finalText = leakedToolCall.visibleText
            continue
          }
          finalText = modelText
          if (bufferNativeTextUntilParsed && finalText) {
            emitOutput(finalText, 'text')
          } else if (!streamedText && finalText) {
            emitOutput(finalText, 'text')
          }
          if (
            requiresLocalDocumentExcerpt
            && !usedTools.includes('file_read_excerpt')
            && localDocumentExcerptRepairAttempts < 1
          ) {
            localDocumentExcerptRepairAttempts += 1
            nextInput = buildLocalDocumentExcerptRepairInput()
            emitOutput('还没有读取指定章节正文，我会先读取原文再重做结果。', 'text')
            continue
          }
          if (newDocumentNeedsSave && newDocumentSaveRepairAttempts < 1) {
            newDocumentSaveRepairAttempts += 1
            nextInput = buildNewDocumentSaveRepairInput()
            emitOutput('新文档已经写入但还没有保存，我会先保存再结束。', 'text')
            continue
          }
          if (
            documentTargetGuard
            && finalTextIndicatesIncompleteDocument(finalText)
            && documentTargetContinuationRepairAttempts < 1
          ) {
            documentTargetContinuationRepairAttempts += 1
            nextInput = buildDocumentTargetContinuationRepairInput(documentTargetGuard)
            emitOutput('目标文档看起来还没补完，我会继续修正并保存。', 'text')
            continue
          }
          if (
            documentTargetGuard
            && documentTargetContentRepairAttempts < 1
          ) {
            const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
              forbidFutureLeakage: requiresLocalDocumentExcerpt,
            })
            if (contentIssue) {
              documentTargetContentRepairAttempts += 1
              nextInput = buildDocumentTargetContentRepairInput(documentTargetGuard, contentIssue)
              emitOutput('目标文档里有未通过检查的内容，我会改成稳定版本并保存。', 'text')
              continue
            }
          }
          if (
            documentTargetGuard
            && !hasSuccessfulDocumentTargetMutation
            && documentTargetRepairAttempts < 1
          ) {
            documentTargetRepairAttempts += 1
            nextInput = buildDocumentTargetRepairInput(documentTargetGuard)
            emitOutput('目标文档还没有实际写入，我会继续完成写入并保存。', 'text')
            continue
          }
          break
        }

        const parsed = parseTextToolBridgeResponse(modelText)
        if (parsed.visibleText && (parsed.toolCalls.length === 0 || !shouldSuppressVisibleTextOnToolCall(parsed.visibleText))) {
          emitOutput(parsed.visibleText, 'text')
        }
        if (parsed.toolCalls.length === 0) {
          finalText = parsed.visibleText || modelText
          if (
            requiresLocalDocumentExcerpt
            && !usedTools.includes('file_read_excerpt')
            && localDocumentExcerptRepairAttempts < 1
          ) {
            localDocumentExcerptRepairAttempts += 1
            nextInput = buildLocalDocumentExcerptRepairInput()
            emitOutput('还没有读取指定章节正文，我会先读取原文再重做结果。', 'text')
            continue
          }
          if (newDocumentNeedsSave && newDocumentSaveRepairAttempts < 1) {
            newDocumentSaveRepairAttempts += 1
            nextInput = buildNewDocumentSaveRepairInput()
            emitOutput('新文档已经写入但还没有保存，我会先保存再结束。', 'text')
            continue
          }
          if (
            documentTargetGuard
            && finalTextIndicatesIncompleteDocument(finalText)
            && documentTargetContinuationRepairAttempts < 1
          ) {
            documentTargetContinuationRepairAttempts += 1
            nextInput = buildDocumentTargetContinuationRepairInput(documentTargetGuard)
            emitOutput('目标文档看起来还没补完，我会继续修正并保存。', 'text')
            continue
          }
          if (
            documentTargetGuard
            && documentTargetContentRepairAttempts < 1
          ) {
            const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
              forbidFutureLeakage: requiresLocalDocumentExcerpt,
            })
            if (contentIssue) {
              documentTargetContentRepairAttempts += 1
              nextInput = buildDocumentTargetContentRepairInput(documentTargetGuard, contentIssue)
              emitOutput('目标文档里有未通过检查的内容，我会改成稳定版本并保存。', 'text')
              continue
            }
          }
          break
        }

        const bridgeResults: Array<{ id: string; name: string; result: ToolExecutionOutput }> = []
        for (const call of parsed.toolCalls) {
          const definition = definitionByName.get(call.name)
          if (!definition) {
            bridgeResults.push({
              id: `text-bridge-${bridgeTurn}-${bridgeResults.length}`,
              name: call.name,
              result: createToolExecutionOutput(`工具 ${call.name} 未在本轮授权列表中。`, {
                shape: 'json',
                data: {
                  errorKind: 'tool_restricted_this_turn',
                  toolName: call.name,
                },
              }),
            })
            continue
          }
          const output = await this.executeReadyToolDefinition(
            definition,
            call.args,
            toolBridgeRuntimeContext,
          )
          if (call.name === 'document_save_tab') {
            lastDocumentSaveFailure = this.isDocumentToolFailure(output)
              ? normalizeToolExecutionOutput(output).text || 'document_save_tab failed'
              : null
          }
          bridgeResults.push({
            id: `text-bridge-${bridgeTurn}-${bridgeResults.length}`,
            name: call.name,
            result: output,
          })
        }
        nextInput = buildTextToolResultMessage(bridgeResults)
        finalText = parsed.visibleText
      }
      if (useTextToolBridge && !finalText && usedTools.length > 0) {
        finalText = '工具已执行，但模型尚未给出最终回复。'
        emitOutput(finalText, 'text')
      }
      if (requiresLocalDocumentExcerpt && !usedTools.includes('file_read_excerpt')) {
        const message = '还没有读取指定文档正文，不能声明完成。'
        emitOutput(message, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'blocked_tool_error')
        return this.buildResult({
          success: false,
          error: message,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'blocked_tool_error',
        })
      }
      if (documentTargetGuard && finalTextIndicatesIncompleteDocument(finalText)) {
        const message = `目标文档 ${documentTargetGuard.targetName} 仍未补完，不能声明完成。`
        emitOutput(message, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'blocked_tool_error')
        return this.buildResult({
          success: false,
          error: message,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'blocked_tool_error',
        })
      }
      if (documentTargetGuard) {
        const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
          forbidFutureLeakage: requiresLocalDocumentExcerpt,
        })
        if (contentIssue) {
          const message = `目标文档 ${documentTargetGuard.targetName} 内容未通过检查：${contentIssue}`
          emitOutput(message, 'error')
          emitOutput('', 'done')
          emitStatus('error', 'blocked_tool_error')
          return this.buildResult({
            success: false,
            error: message,
            finalText: '',
            cancelled: false,
            taskId,
            usedTools,
            transcriptEvents,
            projectionPatches,
            terminalReason: 'blocked_tool_error',
          })
        }
      }
      if (documentTargetGuard && !hasSuccessfulDocumentTargetMutation) {
        const message = `目标文档 ${documentTargetGuard.targetName} 尚未实际写入，不能声明完成。`
        emitOutput(message, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'blocked_tool_error')
        return this.buildResult({
          success: false,
          error: message,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'blocked_tool_error',
        })
      }
      if (newDocumentNeedsSave) {
        const saveDefinition = definitionByName.get('document_save_tab')
        if (saveDefinition) {
          emitOutput('新文档已经写入但还没有保存，我会自动保存当前文档。', 'text')
          const output = await this.executeReadyToolDefinition(saveDefinition, {}, toolBridgeRuntimeContext)
          const normalized = normalizeToolExecutionOutput(output)
          if (this.isDocumentToolFailure(normalized)) {
            lastDocumentSaveFailure = normalized.text || 'document_save_tab failed'
          } else if (lastDocumentSaveSuccessText && !finalText.includes(lastDocumentSaveSuccessText)) {
            const savedMessage = `已完成，${lastDocumentSaveSuccessText}`
            finalText = finalText.trim()
              ? `${finalText}\n\n${savedMessage}`
              : savedMessage
            emitOutput(savedMessage, 'text')
          }
        } else {
          lastDocumentSaveFailure = '本轮未开放 document_save_tab'
        }
      }
      if (lastDocumentSaveFailure && hasSuccessfulDocumentTargetMutation) {
        const message = `文档保存失败，不能声明完成：${lastDocumentSaveFailure}`
        emitOutput(message, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'persistence_failed')
        return this.buildResult({
          success: false,
          error: message,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'persistence_failed',
        })
      }
      if (newDocumentNeedsSave) {
        const message = '新文档已经修改但尚未保存，不能声明完成。'
        emitOutput(message, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'persistence_failed')
        return this.buildResult({
          success: false,
          error: message,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'persistence_failed',
        })
      }
      if (!finalText.trim() && usedTools.length > 0) {
        finalText = lastDocumentSaveSuccessText
          ? `已完成，${lastDocumentSaveSuccessText}`
          : '工具已执行完成。'
        emitOutput(finalText, 'text')
      }
      const finalProjectionPatch = this.mergeProjectionPatches(projectionPatches)
      emitOutput('', 'done', finalProjectionPatch)
      emitStatus('done', 'done')
      return this.buildResult({
        success: true,
        finalText,
        cancelled: false,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason: 'done',
      })
    } catch (error) {
      if (isAbortError(error)) {
        emitOutput('', 'done')
        emitStatus('cancelled', 'cancelled_runtime')
        return this.buildResult({
          success: true,
          finalText: '',
          cancelled: true,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'cancelled_runtime',
        })
      }
      const message = errorMessage(error)
      const recoverableLongSkillCheckpoint = longSkillCheckpoint as SdkLongSkillCheckpoint | null
      if (
        /Max turns \(\d+\) exceeded/i.test(message)
        && shouldRecoverLongSkillCheckpoint(recoverableLongSkillCheckpoint)
      ) {
        const checkpointText = finalText || summarizeLongSkillCheckpoint(recoverableLongSkillCheckpoint)
        if (!finalText) {
          emitOutput(checkpointText, 'text')
        }
        emitOutput('', 'done', this.mergeProjectionPatches(projectionPatches))
        emitStatus('checkpoint', recoverableLongSkillCheckpoint.terminalReason)
        return this.buildResult({
          success: true,
          finalText: checkpointText,
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: recoverableLongSkillCheckpoint.terminalReason,
        })
      }
      if (
        /Max turns \(\d+\) exceeded/i.test(message)
        && documentTargetGuardForRecovery
        && hasSuccessfulDocumentTargetMutation
        && lastDocumentSaveSuccessText
        && (
          !requiresLocalDocumentExcerptForRecovery
          || usedTools.includes('file_read_excerpt')
        )
      ) {
        const contentIssue = await inspectDocumentTargetContent(documentTargetGuardForRecovery, {
          forbidFutureLeakage: requiresLocalDocumentExcerptForRecovery,
        })
        if (!contentIssue) {
          const fallbackText = finalText || `已完成并保存到 ${documentTargetGuardForRecovery.targetName}。`
          if (!finalText) {
            emitOutput(fallbackText, 'text')
          }
          emitOutput('', 'done', this.mergeProjectionPatches(projectionPatches))
          emitStatus('done', 'done')
          return this.buildResult({
            success: true,
            finalText: fallbackText,
            cancelled: false,
            taskId,
            usedTools,
            transcriptEvents,
            projectionPatches,
            terminalReason: 'done',
          })
        }
      }
      if (
        /Max turns \(\d+\) exceeded/i.test(message)
        && documentTargetGuardForRecovery
        && !hasSuccessfulDocumentTargetMutation
      ) {
        const checkpointText = `本轮工具调用次数已用完，但目标文档 ${documentTargetGuardForRecovery.targetName} 还没有发生有效写入。请继续这项任务，我会从当前文档状态接着修。`
        emitOutput(checkpointText, 'text')
        emitOutput('', 'done', this.mergeProjectionPatches(projectionPatches))
        emitStatus('checkpoint', 'checkpoint_budget')
        return this.buildResult({
          success: true,
          finalText: checkpointText,
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'checkpoint_budget',
        })
      }
      const failure = classifySdkRuntimeError(error)
      emitOutput(`${failure.userMessagePrefix}: ${message}`, 'error')
      emitOutput('', 'done')
      emitRuntimeError(error, failure.terminalReason)
      emitStatus('error', failure.terminalReason)
      return this.buildResult({
        success: false,
        error: message,
        finalText: '',
        cancelled: false,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason: failure.terminalReason,
      })
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null
      }
      if (session.activeRunId === runId) {
        session.activeRunId = null
      }
    }
  }

  private buildSdkTool(
    definition: ToolDefinition,
    runtimeContext: ToolBridgeRuntimeContext,
  ): AgentSdkTool {
    const schema = definition.schema && definition.schema.type === 'object'
      ? definition.schema
      : { type: 'object', properties: {}, additionalProperties: false }
    return tool({
      name: definition.name,
      description: definition.description,
      parameters: schema as never,
      strict: false,
      timeoutMs: definition.executionTimeoutMs,
      execute: async (input) => {
        const args = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {}
        const output = await this.executeReadyToolDefinition(definition, args, runtimeContext)
        return stringifyToolResult(output)
      },
      errorFunction: (_context, error) => stringifyToolResult(createToolExecutionOutput(
        `工具 ${definition.name} 失败：${errorMessage(error)}`,
        {
          shape: 'json',
          data: {
            errorKind: 'tool_failed',
            toolName: definition.name,
            message: errorMessage(error),
          },
        },
      )),
    }) as AgentSdkTool
  }

  private buildExecutorContext(
    runtimeContext: ToolBridgeRuntimeContext,
  ): ReturnType<typeof toToolExecutorContext> {
    return toToolExecutorContext(buildToolRuntimeContext({
      browserController: this.browserController,
      sidecarManager: this.sidecarManager,
      runtime: this.runtime,
      scope: runtimeContext.sessionId
        ? this.runtime?.getConversationScope(runtimeContext.sessionId) || undefined
        : undefined,
      allowedToolNames: runtimeContext.allowedToolNames,
      // SDK runtime executes renderer-mediated tools through the request/ack
      // path below. Forwarding tool handlers' advisory emitToolAction here
      // would make document/rss/calendar actions run twice in the renderer.
      emitToolAction: () => undefined,
      requestModuleToolAction: this.rendererToolActionRequester
        ? (toolName, toolArgs) => this.rendererToolActionRequester!({
          agent: runtimeContext.agentName,
          sessionId: runtimeContext.sessionId,
          runId: runtimeContext.runId,
          tool: toolName,
          args: toolArgs,
        })
        : undefined,
      abortSignal: runtimeContext.signal,
      sessionId: runtimeContext.sessionId,
      scopeId: runtimeContext.sessionId,
      runId: runtimeContext.runId,
      taskId: runtimeContext.taskId,
      parentTaskId: runtimeContext.taskId,
      parentStepId: runtimeContext.taskId,
      taskProjectionId: runtimeContext.taskId,
      frameSkillId: null,
      registerRunCleanup: (cleanup) => {
        this.runCleanupRegistry?.registerRunCleanup(runtimeContext.runId, cleanup)
      },
      agentContext: runtimeContext.agentContext ?? null,
      turnFeatureFlags: snapshotTurnFeatureFlags(),
      activeFrame: runtimeContext.activeFrame,
      authorization: runtimeContext.authorization,
    }))
  }

  private async executeGuardDocumentTool(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput> {
    const callTrace = formatToolCallTrace(definition.name, args)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
    })
    runtimeContext.emitToolAction(definition.name, args)
    const output = await this.executeToolCall(
      definition.name,
      args,
      this.buildExecutorContext(runtimeContext),
    )
    runtimeContext.recordToolResult(definition.name, output)
    const normalized = normalizeToolExecutionOutput(output)
    const resultTrace = formatToolResultTrace(definition.name, normalized)
    runtimeContext.emitOutput(resultTrace, 'tool_result', normalized.projectionPatch || null)
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'result',
      text: resultTrace,
      projectionPatch: normalized.projectionPatch,
    })
    return output
  }

  private isDocumentToolFailure(output: ToolExecutionOutput): boolean {
    const normalized = normalizeToolExecutionOutput(output)
    const data = normalized.data && typeof normalized.data === 'object'
      ? normalized.data as Record<string, unknown>
      : {}
    return (
      typeof data.errorKind === 'string'
      || isDocumentToolFailureText(normalized.text)
    )
  }

  private async ensureExplicitDocumentTargetOpened(
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput | null> {
    const guard = runtimeContext.documentTargetGuard
    if (!guard || guard.opened) return null
    const definition = guard.openToolDefinition
    if (!definition) {
      return createToolExecutionOutput(`无法打开目标文档 ${guard.targetName}：本轮未开放 document_open_tab。`, {
        shape: 'json',
        data: {
          errorKind: 'target_document_open_unavailable',
          targetPath: guard.targetPath,
        },
      })
    }

    const args = { path: guard.targetPath }
    const output = await this.executeGuardDocumentTool(definition, args, runtimeContext)
    const normalized = normalizeToolExecutionOutput(output)
    if (this.isDocumentToolFailure(normalized)) {
      return createToolExecutionOutput(`无法打开目标文档 ${guard.targetName}，已停止写入，避免写错文件。`, {
        shape: 'json',
        data: {
          errorKind: 'target_document_open_failed',
          targetPath: guard.targetPath,
          openResult: normalized.text,
        },
      })
    }
    guard.opened = true
    return null
  }

  private async ensureExplicitDocumentTargetSaved(
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput | null> {
    const guard = runtimeContext.documentTargetGuard
    if (!guard) return null
    const definition = guard.saveToolDefinition
    if (!definition) {
      return createToolExecutionOutput(`目标文档 ${guard.targetName} 已修改，但本轮未开放 document_save_tab，无法确认落盘。`, {
        shape: 'json',
        data: {
          errorKind: 'target_document_save_unavailable',
          targetPath: guard.targetPath,
        },
      })
    }
    const output = await this.executeGuardDocumentTool(definition, {}, runtimeContext)
    if (this.isDocumentToolFailure(output)) {
      return createToolExecutionOutput(`目标文档 ${guard.targetName} 保存失败，不能声明完成。`, {
        shape: 'json',
        data: {
          errorKind: 'target_document_save_failed',
          targetPath: guard.targetPath,
          saveResult: normalizeToolExecutionOutput(output).text,
        },
      })
    }
    return null
  }

  private async executeReadyToolDefinition(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput> {
    const guard = runtimeContext.documentTargetGuard
    if (guard && definition.name === 'document_new_tab') {
      return createToolExecutionOutput(
        `用户已明确要求写入 ${guard.targetName}，不能新建临时文档替代。请打开目标文档后再修改。`,
        {
          shape: 'json',
          data: {
            errorKind: 'target_document_required',
            targetPath: guard.targetPath,
          },
        },
      )
    }
    if (guard && definition.name === 'document_switch_tab') {
      return createToolExecutionOutput(
        `目标文档已固定为 ${guard.targetName}，本轮不需要切换到其他标签。`,
        {
          shape: 'json',
          data: {
            ok: true,
            targetPath: guard.targetPath,
            ignoredTool: definition.name,
          },
        },
      )
    }
    if (guard && (DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name) || definition.name === 'document_save_tab')) {
      const blocker = await this.ensureExplicitDocumentTargetOpened(runtimeContext)
      if (blocker) return blocker
    }
    const effectiveArgs = guard
      ? normalizeExplicitDocumentTargetToolArgs(definition.name, args)
      : args

    const callTrace = formatToolCallTrace(definition.name, effectiveArgs)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
    })
    const preservationBlocker = DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name)
      ? validatePreservedDocumentMutation(guard, definition.name, effectiveArgs)
      : null
    if (preservationBlocker) {
      runtimeContext.recordToolResult(definition.name, preservationBlocker)
      const resultTrace = formatToolResultTrace(definition.name, normalizeToolExecutionOutput(preservationBlocker))
      runtimeContext.emitOutput(resultTrace, 'tool_result')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'result',
        text: resultTrace,
      })
      return preservationBlocker
    }
    runtimeContext.emitToolAction(definition.name, effectiveArgs)
    const output = await this.executeToolCall(
      definition.name,
      effectiveArgs,
      this.buildExecutorContext(runtimeContext),
    )
    runtimeContext.recordToolResult(definition.name, output)
    const normalized = normalizeToolExecutionOutput(output)
    if (
      guard
      && definition.name === 'document_open_tab'
      && String(effectiveArgs.path || '').trim() === guard.targetPath
      && !(normalized.data && typeof normalized.data === 'object' && 'errorKind' in normalized.data)
      && !isDocumentToolFailureText(normalized.text)
    ) {
      guard.opened = true
    }
    const resultTrace = formatToolResultTrace(definition.name, normalized)
    runtimeContext.emitOutput(resultTrace, 'tool_result', normalized.projectionPatch || null)
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'result',
      text: resultTrace,
      projectionPatch: normalized.projectionPatch,
    })
    if (
      guard
      && DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name)
      && !this.isDocumentToolFailure(normalized)
      && documentToolMutatedContent(normalized)
    ) {
      const saveBlocker = await this.ensureExplicitDocumentTargetSaved(runtimeContext)
      if (saveBlocker) return saveBlocker
    }
    return output
  }

  private resolveSkillAuthorizationForTurn(
    message: RunMessage,
    sessionId?: string,
  ): SkillToolAuthorization {
    const orchestrator = this.skillContextOrchestrator
    if (!orchestrator) return buildExplicitNoSkillAuthorization('no_skill_signal')
    const userText = messageToText(message)
    if (!userText) return buildExplicitNoSkillAuthorization('no_skill_signal')
    const explicitSkills = orchestrator.findExplicitlyRequestedSkills?.(userText) || []
    const explicitSkill = explicitSkills[0] || null
    const explicitSkillId = explicitSkill?.id || explicitSkill?.skillId || null
    if (explicitSkillId) {
      try {
        orchestrator.rememberExplicitReferenceSkillHint?.(userText, sessionId)
      } catch (error) {
        log(`rememberExplicitReferenceSkillHint failed: ${errorMessage(error)}`)
      }
    }

    const referenceHint = orchestrator.getCurrentReferenceSkillHint?.(sessionId) || null
    const typedActionNames = new Set((orchestrator.buildPreferredSkillToolNames?.(userText, sessionId) || [])
      .filter((name) => name.startsWith('skill_') && !PRIMITIVE_TOOL_NAME_SET.has(name)))
    if (explicitSkillId === 'video-expert-analyzer' || referenceHint?.id === 'video-expert-analyzer') {
      typedActionNames.add('skill_video_expert_pipeline')
      typedActionNames.add('skill_video_expert_ai_analyze')
    }
    const typedActions = Array.from(typedActionNames)
    const skillId = explicitSkillId || (typedActions.length > 0 ? referenceHint?.id || null : null)
    if (!skillId) return buildExplicitNoSkillAuthorization('no_skill_signal')

    return buildSelectedSkillToolAuthorization({
      skillId,
      allowedTypedActions: typedActions,
      allowedPrimitives: allowedPrimitiveToolsForSdkSkillTurn(),
      source: explicitSkillId ? 'explicit' : 'active_task',
      reason: explicitSkillId ? 'explicit_user_mention' : 'reference_hint',
    })
  }

  private publishSdkToolEvent(params: {
    runtimeContext: ToolBridgeRuntimeContext
    definition: ToolDefinition
    kind: 'call' | 'result'
    text: string
    projectionPatch?: Record<string, unknown> | null
  }): void {
    if (!params.runtimeContext.sessionId) return
    const timestamp = new Date().toISOString()
    const projectionPatch = params.projectionPatch || null
    this.runtime?.publishScopeRunEvent({
      type: 'updated',
      scopeId: params.runtimeContext.sessionId,
      agent: publicAgentName(params.runtimeContext.agentName),
      runId: params.runtimeContext.runId,
      taskId: params.runtimeContext.taskId,
      phase: params.kind === 'call' ? 'tool_running' : 'responding',
      module: scopeRunModuleForTool(params.definition),
      taskType: params.definition.domain === 'general_research' ? 'research' : undefined,
      taskProjectionId: params.runtimeContext.taskId,
      latestText: params.kind === 'result' ? params.text : undefined,
      taskTitle: typeof projectionPatch?.taskTitle === 'string' ? projectionPatch.taskTitle : undefined,
      taskSummary: typeof projectionPatch?.taskSummary === 'string' ? projectionPatch.taskSummary : undefined,
      toolEvent: {
        id: `sdk-tool-${params.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: params.kind,
        text: params.text,
        timestamp,
      },
      timestamp,
    }, projectionPatch ? { projectionPatch, transcriptEvents: [] } : null)
  }

  private mergeProjectionPatches(patches: Record<string, unknown>[]): Record<string, unknown> | null {
    if (patches.length === 0) return null
    return patches.reduce<Record<string, unknown>>((acc, patch) => ({ ...acc, ...patch }), {})
  }

  private buildResult(params: {
    success: boolean
    finalText: string
    cancelled: boolean
    taskId: string
    usedTools: string[]
    transcriptEvents: TurnTranscriptEvent[]
    projectionPatches: Record<string, unknown>[]
    terminalReason: TurnTerminalReason
    error?: string
  }): ExecutionTurnResult {
    const taskType = this.resolveTaskTypeFromTools(params.usedTools)
    return {
      success: params.success,
      status: params.cancelled ? 'cancelled' : params.success ? 'done' : 'error',
      finalText: params.finalText,
      cancelled: params.cancelled,
      usedTools: [...params.usedTools],
      error: params.error,
      taskId: params.taskId,
      taskType,
      interactionState: 'running',
      taskProjectionId: params.taskId,
      executionDiagnostics: {
        taskId: params.taskId,
        toolSnapshots: null,
      },
      projectionTruth: {
        projectionPatch: this.mergeProjectionPatches(params.projectionPatches),
        transcriptEvents: params.transcriptEvents,
      },
      terminalReason: params.terminalReason,
    }
  }

  private extractSessionIdFromInternalName(name: string): string | undefined {
    const marker = name.indexOf('::')
    return marker === -1 ? undefined : name.slice(marker + 2)
  }

  private resolveTaskTypeFromTools(usedTools: string[]): TaskType {
    if (usedTools.length === 0) return 'direct_answer'
    if (usedTools.some((name) =>
      name.startsWith('web_')
      || name === 'present_file'
      || name === 'browser_research_topic'
      || name === 'browser_search',
    )) {
      return 'research'
    }
    return 'multi_step_task'
  }
}
