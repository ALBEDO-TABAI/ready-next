import { create } from 'zustand'
import { useDocTabs } from './useDocTabs'
import { useMode } from './useMode'
import { convertDocxHtmlToMarkdownText } from '../utils/docx-format'

export interface AgentMessage {
  id: string
  agent: string
  content: string
  type: 'user' | 'agent' | 'system'
  timestamp: Date
  attachments?: ChatAttachment[]
  meta?: Record<string, unknown>
}

export interface Agent {
  name: string
  displayName: string
  avatar: string
  status: 'idle' | 'working' | 'done' | 'error' | 'cancelled'
  selected: boolean
}

export interface ChatAttachment {
  id: string
  name: string
  path: string
  type: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  size: number
  ext: string
  source?: 'file' | 'browser-tab' | 'skill-folder' | 'channel'
  browserTabId?: string
  url?: string
  title?: string
  heading?: string
  selection?: string
  excerpt?: string
  capturedAt?: number
  skillId?: string
  skillFolderPath?: string
}

export interface ChatConversation {
  id: string
  agent: string
  title: string
  created_at: string
  updated_at: string
}

export interface ConversationScope {
  id: string
  agent: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  threadKey: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ToolTraceEvent {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: Date
}

export interface ScopeRunState {
  scopeId: string
  agent: string
  requestId: string | null
  phase: 'idle' | 'queued' | 'planning' | 'tool_running' | 'checkpoint' | 'takeover' | 'resuming' | 'responding' | 'done' | 'error' | 'cancelled'
  toolTrace: ToolTraceEvent[]
  startedAt: string | null
  updatedAt: string | null
  latestText?: string | null
  blockedReason?: string | null
  controllerId?: string | null
  ownerTabId?: string | null
  checkpointExpiresAt?: number | null
  stepMetrics?: {
    toolCalls: number
    toolResults: number
    lastToolAt: string | null
  }
  error?: string | null
}

export interface AttachmentPreviewState {
  attachment: ChatAttachment
  mode: 'image' | 'video' | 'text' | 'file'
  content?: string
  error?: string | null
}

interface AgentState {
  agents: Agent[]
  messages: AgentMessage[]
  currentAgent: string
  inputValue: string
  isStreaming: boolean
  streamingMessageId: string | null
  streamingRequestId: string | null
  sessionId: string
  // Legacy aliases kept in sync with scope state
  conversationId: string | null
  conversations: ChatConversation[]
  currentScopeId: string | null
  currentScope: ConversationScope | null
  scopes: ConversationScope[]
  scopeRunStates: Record<string, ScopeRunState>
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  // W3: Attachments
  attachments: ChatAttachment[]
  // W4: File pool (all files added in current session via +)
  filePool: ChatAttachment[]
  activeAttachmentPreview: AttachmentPreviewState | null
  sendCoalescingEnabled: boolean
  sendCoalescingWindowMs: number
  pendingSendCount: number
  pendingSendFlushAt: number | null

  setAgents: (agents: Agent[]) => void
  selectAgent: (name: string) => void
  toggleAgentSelection: (name: string) => void
  addMessage: (message: AgentMessage) => void
  appendToMessage: (id: string, chunk: string) => void
  setInputValue: (value: string) => void
  setIsStreaming: (streaming: boolean) => void
  sendMessage: (content: string) => Promise<void>
  stopStreaming: () => void
  undoLastMessage: () => void
  newSession: () => void
  loadScopes: () => Promise<void>
  loadScope: (scopeId: string) => Promise<void>
  setCurrentScope: (scopeId: string) => Promise<void>
  sendMessageToScope: (scopeId: string, content: string) => Promise<void>
  clearToolTrace: () => void
  // Legacy history API
  loadConversations: () => Promise<void>
  loadConversation: (convId: string) => Promise<void>
  deleteConversation: (convId: string) => Promise<void>
  // W3: Attachments
  addAttachments: (files: ChatAttachment[]) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  setActiveAttachmentPreview: (preview: AttachmentPreviewState | null) => void
  loadSendPreferences: () => Promise<void>
  setSendCoalescingEnabled: (enabled: boolean) => Promise<void>
  setSendCoalescingWindowMs: (windowMs: number) => Promise<void>
  // W3: File picking
  pickFiles: () => Promise<void>
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function mapScopeToConversation(scope: ConversationScope): ChatConversation {
  return {
    id: scope.id,
    agent: scope.agent,
    title: scope.title,
    created_at: scope.createdAt,
    updated_at: scope.updatedAt,
  }
}

function getScopeLabel(scope: ConversationScope | null): string {
  if (!scope) return '应用内 · 新会话'
  const sourceLabel = scope.sourceKind === 'local'
    ? '应用内'
    : String(scope.meta?.sourceLabel || '远程 IM')
  return `${sourceLabel} · ${scope.title || '未命名会话'}`
}

function normalizeAttachmentType(value: unknown): ChatAttachment['type'] {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'image') return 'image'
  if (normalized === 'video') return 'video'
  if (normalized === 'text') return 'text'
  if (normalized === 'spreadsheet') return 'spreadsheet'
  return 'other'
}

function extractAttachmentsFromMeta(meta?: Record<string, unknown>): ChatAttachment[] | undefined {
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
        source: 'channel' as const,
        url: typeof record.url === 'string' ? record.url : undefined,
      }
    })
    .filter(Boolean) as ChatAttachment[]

  return attachments.length > 0 ? attachments : undefined
}

function isActiveScopePhase(phase: ScopeRunState['phase'] | undefined): boolean {
  return phase === 'queued' || phase === 'planning' || phase === 'tool_running' || phase === 'checkpoint' || phase === 'takeover' || phase === 'resuming' || phase === 'responding'
}

function phaseToToolTraceStatus(
  phase: ScopeRunState['phase'] | undefined,
): 'idle' | 'running' | 'done' | 'error' | 'cancelled' {
  if (!phase || phase === 'idle') return 'idle'
  if (phase === 'error') return 'error'
  if (phase === 'cancelled') return 'cancelled'
  if (phase === 'done') return 'done'
  return 'running'
}

function getActiveScopeRunState(
  scopeRunStates: Record<string, ScopeRunState>,
  scopeId: string | null,
): ScopeRunState | null {
  if (!scopeId) return null
  return scopeRunStates[scopeId] || null
}

function parseStructuredToolPayload(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore parse errors
  }
  return null
}

function deriveScopeRunStatePatch(
  event: {
    phase: ScopeRunState['phase']
    latestText?: string
    toolEvent?: { kind: ToolTraceEvent['kind']; text: string; timestamp: string }
    error?: string
    timestamp: string
  },
  previous: ScopeRunState | null,
): Partial<ScopeRunState> {
  const patch: Partial<ScopeRunState> = {
    phase: event.phase,
    latestText: event.latestText ?? previous?.latestText ?? null,
    blockedReason: previous?.blockedReason ?? null,
    controllerId: previous?.controllerId ?? null,
    ownerTabId: previous?.ownerTabId ?? null,
    checkpointExpiresAt: previous?.checkpointExpiresAt ?? null,
    stepMetrics: previous?.stepMetrics || {
      toolCalls: 0,
      toolResults: 0,
      lastToolAt: null,
    },
    error: event.error || previous?.error || null,
  }

  if (event.toolEvent) {
    const nextMetrics = {
      toolCalls: previous?.stepMetrics?.toolCalls || 0,
      toolResults: previous?.stepMetrics?.toolResults || 0,
      lastToolAt: event.toolEvent.timestamp,
    }
    if (event.toolEvent.kind === 'call') nextMetrics.toolCalls += 1
    if (event.toolEvent.kind === 'result') nextMetrics.toolResults += 1
    patch.stepMetrics = nextMetrics
  }

  const structuredPayload = event.toolEvent?.kind === 'result' && event.toolEvent.text
    ? parseStructuredToolPayload(event.toolEvent.text)
    : event.latestText
      ? parseStructuredToolPayload(event.latestText)
      : null

  if (structuredPayload?.phase === 'human_required' || structuredPayload?.takeover_state === 'submitted') {
    patch.phase = 'takeover'
    patch.blockedReason = [
      typeof structuredPayload.call_to_action === 'string' ? structuredPayload.call_to_action : '',
      typeof structuredPayload.details === 'string' ? structuredPayload.details : '',
    ].filter(Boolean).join(' · ') || '需要人工接管'
    if (Number.isFinite(Number(structuredPayload.timeout_sec || 0))) {
      patch.checkpointExpiresAt = Date.now() + Number(structuredPayload.timeout_sec || 0) * 1000
    }
  } else if (previous?.phase === 'takeover' && event.phase === 'tool_running') {
    patch.phase = 'resuming'
    patch.blockedReason = null
    patch.checkpointExpiresAt = null
  } else if (event.phase === 'done' || event.phase === 'error' || event.phase === 'cancelled') {
    patch.blockedReason = null
    patch.checkpointExpiresAt = null
  }

  if (event.phase === 'error' && event.error) {
    patch.blockedReason = event.error
  }

  return patch
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

// Helper: persist a message to DB
async function persistMessage(
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
  } catch { /* ignore persistence errors */ }
}

// Helper: ensure conversation exists in DB
async function ensureConversation(conversationId: string, agent: string, title: string) {
  if (typeof window === 'undefined' || !window.electronAPI?.chat) return
  try {
    await window.electronAPI.chat.createConversation({ id: conversationId, agent, title })
  } catch { /* may already exist */ }
}

interface SkillCommandAction {
  name: string
}

interface SkillCommandCatalogEntry {
  id: string
  name: string
  description: string
  installed: boolean
  source?: 'embedded' | 'custom'
  defaultAction?: string
  actions?: SkillCommandAction[]
  managedPath?: string
  sourcePath?: string
}

interface CommandResult {
  handled: boolean
  text: string
  isError?: boolean
}

const DEFAULT_SEND_COALESCE_WINDOW_MS = 1200

let pendingSendTimer: ReturnType<typeof setTimeout> | null = null
let pendingSendBuffer:
  | {
    scopeId: string | null
    agent: string
    parts: string[]
  }
  | null = null
let bypassCoalescingOnce = false

function clearPendingSendBufferState() {
  if (pendingSendTimer) {
    clearTimeout(pendingSendTimer)
    pendingSendTimer = null
  }
  pendingSendBuffer = null
  try {
    useAgent.setState({ pendingSendCount: 0, pendingSendFlushAt: null })
  } catch {
    /* ignore during bootstrap */
  }
}

function serializePersistedAttachments(attachments: ChatAttachment[]): Array<Record<string, unknown>> {
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
      url: attachment.url,
    }))
}

async function flushPendingSendBuffer() {
  const buffered = pendingSendBuffer
  clearPendingSendBufferState()
  if (!buffered) return

  const merged = buffered.parts
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!merged) return

  bypassCoalescingOnce = true
  try {
    const state = useAgent.getState()
    if (buffered.scopeId && state.currentScopeId !== buffered.scopeId) {
      await state.loadScope(buffered.scopeId).catch(() => undefined)
    } else if (!buffered.scopeId && state.currentAgent !== buffered.agent) {
      state.selectAgent(buffered.agent)
    }
    await useAgent.getState().sendMessage(merged)
  } finally {
    bypassCoalescingOnce = false
  }
}

interface DocActionPayload {
  type: string
  [key: string]: unknown
}

function getActiveDocTab() {
  const store = useDocTabs.getState()
  return store.tabs.find((tab) => tab.id === store.activeTabId) || null
}

function resolveDocTab(target?: string): ReturnType<typeof getActiveDocTab> {
  const store = useDocTabs.getState()
  if (!target || target.trim() === '') return getActiveDocTab()
  const trimmed = target.trim()
  const exactById = store.tabs.find((tab) => tab.id === trimmed)
  if (exactById) return exactById
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= store.tabs.length) {
    return store.tabs[index - 1]
  }
  const lower = trimmed.toLowerCase()
  return store.tabs.find((tab) => tab.title.toLowerCase().includes(lower)) || null
}

function normalizeText(input: string): string {
  return input.replace(/\\n/g, '\n').trim()
}

function normalizeSectionKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~#>\-:：,.，。!?！？;；、()\[\]{}'"“”‘’\s]+/g, '')
    .trim()
}

interface SectionAnchor {
  line: number
  level: number
  title: string
  key: string
}

function inferPlainSectionAnchor(lines: string[], index: number): { level: number; title: string } | null {
  const line = lines[index]?.trim() || ''
  if (!line) return null
  if (line.length < 4 || line.length > 40) return null
  if (/[。！？；，,:：]/.test(line)) return null
  if (/[0-9]/.test(line)) return null
  if (!/[\u4e00-\u9fa5]{4,}/.test(line)) return null

  let nextIndex = index + 1
  while (nextIndex < lines.length && !lines[nextIndex].trim()) {
    nextIndex += 1
  }
  if (nextIndex >= lines.length) return null

  const nextLine = lines[nextIndex].trim()
  if (!/^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[\.、]))\s+/.test(nextLine)) {
    return null
  }

  return {
    level: 2,
    title: line,
  }
}

function parseSectionAnchor(rawLine: string): { level: number; title: string } | null {
  const line = rawLine.trim()
  if (!line) return null

  const markdownHeading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
  if (markdownHeading) {
    return {
      level: markdownHeading[1].length,
      title: markdownHeading[2].trim(),
    }
  }

  // Numeric heading patterns such as:
  // 1. 标题
  // 1.1 标题
  // 2、标题
  const numericHeading = line.match(
    /^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[\.、]))\s+(.+)$/,
  )
  if (numericHeading && line.length <= 100) {
    const numericCore = numericHeading[1].replace(/[、.]$/, '')
    const depth = numericCore.split('.').filter(Boolean).length
    return {
      level: Math.min(6, depth + 1),
      title: `${numericCore} ${numericHeading[2].trim()}`.trim(),
    }
  }

  // Chinese ordinal heading patterns such as:
  // 一、标题
  // （一）标题
  const chineseOrdinalHeading = line.match(
    /^(?:([一二三四五六七八九十百千]+)[、.．]\s*(.+)|[（(]([一二三四五六七八九十百千]+)[）)]\s*(.+))$/,
  )
  if (chineseOrdinalHeading && line.length <= 100) {
    const ordinal = chineseOrdinalHeading[1] || chineseOrdinalHeading[3] || ''
    const body = chineseOrdinalHeading[2] || chineseOrdinalHeading[4] || ''
    return {
      level: 2,
      title: `${ordinal} ${body.trim()}`.trim(),
    }
  }

  const plainHeading = line.match(/^(第[一二三四五六七八九十百千万0-9]+(?:部分|章|节)|引言|序言|前言|摘要|结语|结论|附录)\s*([：:]\s*.+)?$/)
  if (!plainHeading) return null

  // Guard against normal paragraph lines that only start with these words.
  if (line.length > 80) return null

  const suffix = plainHeading[2] ? plainHeading[2].replace(/^[：:]\s*/, '').trim() : ''
  const title = suffix ? `${plainHeading[1]} ${suffix}` : plainHeading[1]
  return {
    level: 2,
    title: title.trim(),
  }
}

function collectSectionAnchors(lines: string[]): SectionAnchor[] {
  const anchors: SectionAnchor[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseSectionAnchor(lines[i]) || inferPlainSectionAnchor(lines, i)
    if (!parsed) continue
    anchors.push({
      line: i,
      level: parsed.level,
      title: parsed.title,
      key: normalizeSectionKey(parsed.title),
    })
  }
  return anchors
}

function parseChineseSectionNumber(raw: string): number | null {
  const token = raw.trim()
  if (!token) return null
  if (/^\d+$/.test(token)) {
    const numeric = Number(token)
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null
  }

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }

  if (token === '十') return 10
  if (token.includes('十')) {
    const [left, right] = token.split('十')
    const tens = left ? digits[left] : 1
    const units = right ? digits[right] : 0
    if (tens === undefined || units === undefined) return null
    const value = tens * 10 + units
    return value > 0 ? value : null
  }

  const direct = digits[token]
  return direct && direct > 0 ? direct : null
}

function extractSectionOrdinal(sectionTitle: string): number | null {
  const match = sectionTitle.match(/第([一二三四五六七八九十两0-9]+)(?:部分|章|节)?/i)
  if (!match?.[1]) return null
  return parseChineseSectionNumber(match[1])
}

function pickOrdinalAnchor(sectionAnchors: SectionAnchor[], ordinal: number): SectionAnchor | null {
  if (ordinal < 1) return null
  if (sectionAnchors.length === 0) return null
  const minLevel = Math.min(...sectionAnchors.map((item) => item.level))
  const topLevelAnchors = sectionAnchors.filter((item) => item.level === minLevel)
  if (topLevelAnchors.length === 0) return null
  return topLevelAnchors[ordinal - 1] || null
}

function findSectionAnchor(sectionAnchors: SectionAnchor[], sectionTitle: string): SectionAnchor | null {
  const targetKey = normalizeSectionKey(sectionTitle)
  if (!targetKey) return null
  const exact = sectionAnchors.find((item) => item.key === targetKey)
  if (exact) return exact
  const fuzzy =
    sectionAnchors.find((item) => item.key.includes(targetKey) || targetKey.includes(item.key)) ||
    null
  if (fuzzy) return fuzzy

  const ordinal = extractSectionOrdinal(sectionTitle)
  if (ordinal) {
    const byOrdinal = pickOrdinalAnchor(sectionAnchors, ordinal)
    if (byOrdinal) return byOrdinal
  }

  return null
}

function getSectionEndLine(sectionAnchors: SectionAnchor[], current: SectionAnchor, totalLines: number): number {
  let sectionEndLine = totalLines
  for (const anchor of sectionAnchors) {
    if (anchor.line <= current.line) continue
    if (anchor.level <= current.level) {
      sectionEndLine = anchor.line
      break
    }
  }
  return sectionEndLine
}

function rewriteSectionInDocument(
  source: string,
  sectionTitle: string,
  nextSectionBody: string,
  options?: { appendIfMissing?: boolean },
): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const fuzzy = findSectionAnchor(sectionAnchors, sectionTitle)

  if (!fuzzy) {
    if (!options?.appendIfMissing) {
      return { content: normalizedSource, found: false }
    }
    const body = nextSectionBody.replace(/\r\n/g, '\n').trim()
    const appended = [
      normalizedSource.trimEnd(),
      normalizedSource.trim().length > 0 ? '' : null,
      `## ${sectionTitle.trim() || '新章节'}`,
      body,
      '',
    ]
      .filter((item): item is string => item !== null)
      .join('\n')
    return { content: appended, found: false }
  }

  const sectionEndLine = getSectionEndLine(sectionAnchors, fuzzy, lines.length)

  const replacementBody = nextSectionBody.replace(/\r\n/g, '\n').trim()
  const replacementLines = [lines[fuzzy.line], replacementBody]
  const nextLines = [
    ...lines.slice(0, fuzzy.line),
    ...replacementLines,
    ...lines.slice(sectionEndLine),
  ]
  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    found: true,
    matchedTitle: fuzzy.title,
  }
}

function formatParagraphIntoReadableChunks(paragraph: string): string {
  const cleaned = paragraph.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (cleaned.length < 130 || !/[。！？；!?;]/.test(cleaned)) {
    return cleaned
  }

  const chunks = cleaned
    .split(/(?<=[。！？；!?;])\s*/g)
    .map((item) => item.trim())
    .filter(Boolean)

  if (chunks.length <= 1) return cleaned
  return chunks.join('\n')
}

function formatSectionBodyPreservingMeaning(sourceBody: string): string {
  const normalized = sourceBody.replace(/\r\n/g, '\n')
  const collapsed = normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!collapsed) return ''

  const paragraphs = collapsed
    .split(/\n{2,}/)
    .map((item) => item.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)

  return paragraphs.map((item) => formatParagraphIntoReadableChunks(item)).join('\n\n').trim()
}

function formatSectionInDocument(
  source: string,
  sectionTitle: string,
): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const target = findSectionAnchor(sectionAnchors, sectionTitle)
  if (!target) {
    return { content: normalizedSource, found: false }
  }

  const sectionEndLine = getSectionEndLine(sectionAnchors, target, lines.length)
  const originalBody = lines.slice(target.line + 1, sectionEndLine).join('\n')
  const formattedBody = formatSectionBodyPreservingMeaning(originalBody)

  const nextLines = [
    ...lines.slice(0, target.line),
    lines[target.line],
    formattedBody,
    ...lines.slice(sectionEndLine),
  ]

  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    found: true,
    matchedTitle: target.title,
  }
}

const TEXT_SAVE_BLOCKED_EXTENSIONS = new Set([
  'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf',
])

function getPathExtension(path: string | null | undefined): string {
  if (!path) return ''
  const file = path.split('/').pop() || ''
  const dot = file.lastIndexOf('.')
  return dot >= 0 ? file.slice(dot + 1).toLowerCase() : ''
}

function getDirectSaveBlockReason(path: string | null | undefined): string | null {
  const ext = getPathExtension(path)
  if (!ext) return null
  if (!TEXT_SAVE_BLOCKED_EXTENSIONS.has(ext)) return null
  return `当前不支持将纯文本直接保存回 .${ext} 文件（会损坏原文件）。请另存为 .md/.txt。`
}

async function loadDocumentContentForEditing(path: string): Promise<{ success: boolean; content: string; error?: string }> {
  if (typeof window === 'undefined' || !window.electronAPI?.document) {
    return { success: false, content: '', error: '当前环境不支持读取文档' }
  }

  const ext = getPathExtension(path)
  try {
    if (['md', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html'].includes(ext)) {
      const result = await window.electronAPI.document.readFile(path)
      if (!result.success) {
        return { success: false, content: '', error: result.error || '文件读取失败' }
      }
      return { success: true, content: result.content || '' }
    }

    if (ext === 'docx') {
      const result = await window.electronAPI.document.parseDocx(path)
      if (!result.success) {
        return { success: false, content: '', error: result.error || 'DOCX 解析失败' }
      }
      const rawText = typeof result.data?.rawText === 'string' ? result.data.rawText : ''
      const html = typeof result.data?.html === 'string'
        ? result.data.html
        : typeof result.html === 'string'
          ? result.html
          : ''
      const markdownish = convertDocxHtmlToMarkdownText(
        html,
        rawText || result.content || result.html || '',
      )
      return { success: true, content: markdownish }
    }

    return { success: true, content: `# 暂不支持该格式\n\n文件: ${path}` }
  } catch (error) {
    return {
      success: false,
      content: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildActiveDocumentContext(): string | null {
  const mode = useMode.getState().workbenchMode
  if (mode !== 'document') return null

  const docStore = useDocTabs.getState()
  const activeTab = docStore.tabs.find((tab) => tab.id === docStore.activeTabId)
  if (!activeTab) return null

  const ext = activeTab.path?.split('.').pop()?.toLowerCase() || 'untitled'
  const raw = activeTab.content || ''
  const clipped = raw.slice(0, 20_000)
  const truncated = raw.length > 20_000

  const lines = [
    '### 当前文档上下文',
    `- 标题: ${activeTab.title}`,
    `- 路径: ${activeTab.path || '(未保存草稿)'}`,
    `- 类型: ${ext}`,
    `- 字符数: ${raw.length}`,
    '',
    '--- 文档内容开始 ---',
    clipped,
    truncated ? '...[文档内容已截断]' : null,
    '--- 文档内容结束 ---',
  ].filter(Boolean)

  return lines.join('\n')
}

async function performDocAction(action: DocActionPayload): Promise<string> {
  const docStore = useDocTabs.getState()
  useMode.getState().setWorkbenchMode('document')

  const type = String(action.type || '').trim()
  if (!type) return '文档动作缺少 type 字段'

  if (type === 'new_tab') {
    docStore.openTab('')
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    const created = getActiveDocTab()
    if (created && title) {
      docStore.renameTab(created.id, title)
    }
    return `已创建文档标签：${title || created?.title || '新文档'}`
  }

  if (type === 'open_tab') {
    const path = typeof action.path === 'string' ? action.path.trim() : ''
    if (!path) return 'open_tab 缺少 path'
    docStore.openTab(path)
    const currentStore = useDocTabs.getState()
    const opened = currentStore.tabs.find((tab) => tab.path === path) || getActiveDocTab()
    if (!opened) return `已打开文档：${path}`

    const loaded = await loadDocumentContentForEditing(path)
    if (!loaded.success) {
      return `已打开文档：${path}（读取失败：${loaded.error || '未知错误'}）`
    }

    currentStore.updateTabContent(opened.id, loaded.content)
    currentStore.markTabSaved(opened.id)
    return `已打开并载入文档：${path}（${loaded.content.length} 字）`
  }

  if (type === 'switch_tab') {
    const target = typeof action.target === 'string' ? action.target : typeof action.tabId === 'string' ? action.tabId : undefined
    const tab = resolveDocTab(target)
    if (!tab) return `未找到文档标签：${target || '(空)'}`
    docStore.setActiveTab(tab.id)
    return `已切换到文档：${tab.title}`
  }

  if (type === 'rename_tab') {
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    if (!title) return 'rename_tab 缺少 title'
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可重命名的文档标签'
    docStore.renameTab(tab.id, title)
    return `已重命名标签：${title}`
  }

  if (type === 'set_content') {
    const content = typeof action.content === 'string' ? action.content : ''
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可写入的文档标签'
    if (tab.content === content) return `内容未变化，已跳过写入：${tab.title}`
    docStore.setTabContent(tab.id, content)
    return `已写入内容到：${tab.title}`
  }

  if (type === 'append_content') {
    const content = typeof action.content === 'string' ? action.content : ''
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可追加的文档标签'
    if (!content) return `追加内容为空，已跳过：${tab.title}`
    docStore.appendTabContent(tab.id, content)
    return `已追加内容到：${tab.title}`
  }

  if (type === 'replace_text') {
    const from = typeof action.from === 'string' ? action.from : ''
    const to = typeof action.to === 'string' ? action.to : ''
    if (!from) return 'replace_text 缺少 from'
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可替换的文档标签'
    if (!tab.content.includes(from)) return `未匹配到替换目标“${from}”，未做改动`
    const nextContent = tab.content.split(from).join(to)
    if (nextContent === tab.content) return `替换后内容无变化，已跳过：${tab.title}`
    docStore.setTabContent(tab.id, nextContent)
    return `已替换文本（${tab.title}）`
  }

  if (type === 'format_section') {
    const sectionTitle = typeof action.sectionTitle === 'string' ? action.sectionTitle.trim() : ''
    if (!sectionTitle) return 'format_section 缺少 sectionTitle'
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可格式化章节的文档标签'
    const formatted = formatSectionInDocument(tab.content, sectionTitle)
    if (!formatted.found) {
      return `未找到章节“${sectionTitle}”，未做改动`
    }
    if (formatted.content === tab.content) {
      return `章节“${formatted.matchedTitle || sectionTitle}”已是目标格式，未做改动`
    }
    docStore.setTabContent(tab.id, formatted.content)
    return `已优化章节格式（${formatted.matchedTitle || sectionTitle}）`
  }

  if (type === 'rewrite_section') {
    const sectionTitle = typeof action.sectionTitle === 'string' ? action.sectionTitle.trim() : ''
    const content = typeof action.content === 'string' ? action.content : ''
    if (!sectionTitle) return 'rewrite_section 缺少 sectionTitle'
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可重写章节的文档标签'
    const rewritten = rewriteSectionInDocument(tab.content, sectionTitle, content, { appendIfMissing: false })
    if (!rewritten.found) {
      return `未找到章节“${sectionTitle}”，未做改动`
    }
    if (rewritten.content === tab.content) {
      return `章节“${rewritten.matchedTitle || sectionTitle}”内容无变化，未做改动`
    }
    docStore.setTabContent(tab.id, rewritten.content)
    return `已重写章节（${rewritten.matchedTitle || sectionTitle}）`
  }

  if (type === 'save_tab') {
    const tab = resolveDocTab(typeof action.tabId === 'string' ? action.tabId : undefined)
    if (!tab) return '没有可保存的文档标签'
    if (!tab.path) return `文档 ${tab.title} 还没有文件路径，暂不能保存`
    if (!tab.isDirty) return `文档未改动，已跳过保存：${tab.path}`
    const saveBlockedReason = getDirectSaveBlockReason(tab.path)
    if (saveBlockedReason) return saveBlockedReason
    if (typeof window === 'undefined' || !window.electronAPI?.document?.writeFile) {
      return '当前环境不支持保存文档'
    }
    const result = await window.electronAPI.document.writeFile(tab.path, tab.content)
    if (!result.success) {
      return `保存失败：${result.error || tab.title}`
    }
    docStore.markTabSaved(tab.id)
    return `已保存文档：${tab.path}`
  }

  return `不支持的文档动作：${type}`
}

function mapToolActionToDocAction(tool: string, args: Record<string, unknown>): DocActionPayload | null {
  switch (tool) {
    case 'document.newTab':
      return { type: 'new_tab', title: args.title }
    case 'document.openTab':
    case 'document.openFile':
      return { type: 'open_tab', path: args.path }
    case 'document.switchTab':
      return { type: 'switch_tab', target: args.target }
    case 'document.renameTab':
      return { type: 'rename_tab', title: args.title, tabId: args.tabId }
    case 'document.setContent':
      return { type: 'set_content', content: args.content, tabId: args.tabId }
    case 'document.appendContent':
      return { type: 'append_content', content: args.content, tabId: args.tabId }
    case 'document.replaceText':
      return { type: 'replace_text', from: args.from, to: args.to, tabId: args.tabId }
    case 'document.formatSection':
      return { type: 'format_section', sectionTitle: args.sectionTitle, style: args.style, tabId: args.tabId }
    case 'document.rewriteSection':
      return { type: 'rewrite_section', sectionTitle: args.sectionTitle, content: args.content, tabId: args.tabId }
    case 'document.saveTab':
      return { type: 'save_tab', tabId: args.tabId }
    default:
      return null
  }
}

function isWorkbenchMode(value: unknown): value is 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar' {
  return typeof value === 'string' && ['browser', 'document', 'design', 'video', 'rss', 'calendar'].includes(value)
}

function normalizeSkillToken(value: string): string {
  return value.trim().toLowerCase()
}

async function loadSkillCatalog(): Promise<SkillCommandCatalogEntry[] | null> {
  if (typeof window === 'undefined' || !window.electronAPI?.skills?.list) return null
  const listRes = await window.electronAPI.skills.list()
  if (!listRes.success || !listRes.data) return null
  return listRes.data as SkillCommandCatalogEntry[]
}

function resolveSkillToken(
  input: string,
  attachments: ChatAttachment[],
  catalog: SkillCommandCatalogEntry[],
): SkillCommandCatalogEntry | null {
  const lowered = normalizeSkillToken(input)
  if (!lowered) return null

  const byId = catalog.find((skill) => normalizeSkillToken(skill.id) === lowered)
  if (byId) return byId

  const byName = catalog.find((skill) => normalizeSkillToken(skill.name) === lowered)
  if (byName) return byName

  const fromAttachment = attachments.find((att) => {
    if (att.source !== 'skill-folder') return false
    if (att.skillId && normalizeSkillToken(att.skillId) === lowered) return true
    if (normalizeSkillToken(att.name) === lowered) return true
    return normalizeSkillToken(att.skillFolderPath || att.path).includes(lowered)
  })

  if (fromAttachment?.skillId) {
    const byAttachmentId = catalog.find((skill) => normalizeSkillToken(skill.id) === normalizeSkillToken(fromAttachment.skillId || ''))
    if (byAttachmentId) return byAttachmentId
  }

  if (fromAttachment) {
    const attachmentPath = normalizeSkillToken(fromAttachment.skillFolderPath || fromAttachment.path)
    const byPath = catalog.find((skill) => {
      const candidates = [skill.sourcePath, skill.managedPath]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeSkillToken(value))
      return candidates.some((candidate) => candidate === attachmentPath || candidate.includes(lowered) || attachmentPath.includes(candidate))
    })
    if (byPath) return byPath

    const byAttachmentName = catalog.find((skill) => normalizeSkillToken(skill.name) === normalizeSkillToken(fromAttachment.name))
    if (byAttachmentName) return byAttachmentName
  }

  const fuzzyMatches = catalog.filter((skill) =>
    normalizeSkillToken(skill.id).includes(lowered) || normalizeSkillToken(skill.name).includes(lowered),
  )
  return fuzzyMatches.length === 1 ? fuzzyMatches[0] : null
}

async function runSkillCommand(raw: string, attachments: ChatAttachment[]): Promise<CommandResult> {
  const body = raw.replace(/^\/skill\s*/i, '').trim()
  if (!body || body === 'help') {
    return {
      handled: true,
      text: [
        '技能命令用法：',
        '`/skill list`',
        '`/skill <skillId> <action> <JSON参数>`',
        '示例：`/skill lets-go-rss rss_update {\"digest\":true,\"noLlm\":true}`',
      ].join('\n'),
    }
  }

  const catalog = await loadSkillCatalog()
  if (!catalog) {
    return { handled: true, text: '当前环境不支持读取技能列表', isError: true }
  }

  if (body === 'list') {
    const items = catalog.map((item) => {
      const defaultAction = item.defaultAction || item.actions?.[0]?.name
      const sourceLabel = item.source === 'custom' ? '自定义' : '系统'
      return `- ${item.id} (${sourceLabel} · ${item.installed ? '已安装' : '未安装'}) · ${item.description}${defaultAction ? ` · 默认动作: ${defaultAction}` : ''}`
    })
    return { handled: true, text: `可用技能：\n${items.join('\n')}` }
  }

  const firstSpace = body.indexOf(' ')
  const skillToken = firstSpace >= 0 ? body.slice(0, firstSpace).trim() : body
  const afterSkill = firstSpace >= 0 ? body.slice(firstSpace + 1).trim() : ''
  const secondSpace = afterSkill.indexOf(' ')
  const action = secondSpace >= 0 ? afterSkill.slice(0, secondSpace).trim() : afterSkill
  const paramsRaw = secondSpace >= 0 ? afterSkill.slice(secondSpace + 1).trim() : ''

  const skill = resolveSkillToken(skillToken, attachments, catalog)
  if (!skill) {
    return { handled: true, text: `无法识别技能：${skillToken}`, isError: true }
  }

  const finalAction = action || skill.defaultAction || skill.actions?.[0]?.name
  if (!finalAction) {
    return { handled: true, text: `请指定技能动作：/skill ${skill.id} <action>`, isError: true }
  }

  let params: Record<string, unknown> | undefined
  if (paramsRaw) {
    try {
      params = JSON.parse(paramsRaw) as Record<string, unknown>
    } catch {
      return { handled: true, text: '技能参数必须是合法 JSON，例如 {"url":"https://..."}', isError: true }
    }
  }

  if (typeof window === 'undefined' || !window.electronAPI?.skills) {
    return { handled: true, text: '当前环境不支持技能执行', isError: true }
  }

  const installRes = await window.electronAPI.skills.install({ skillId: skill.id })
  if (!installRes.success) {
    return { handled: true, text: `技能安装失败：${installRes.error || skill.id}`, isError: true }
  }

  const runRes = await window.electronAPI.skills.run({ skillId: skill.id, action: finalAction, params })
  if (!runRes.success) {
    return { handled: true, text: `技能执行失败：${runRes.error || `${skill.id}/${finalAction}`}`, isError: true }
  }

  const output = runRes.data as { stdout?: string; outputDir?: string } | undefined
  const stdout = output?.stdout?.trim() || ''
  const preview = stdout ? `\n\n${stdout.slice(0, 1500)}` : ''
  const outputDir = output?.outputDir ? `\n输出目录：${output.outputDir}` : ''
  return { handled: true, text: `技能执行完成：${skill.id}/${finalAction}${outputDir}${preview}` }
}

async function runDocCommand(raw: string): Promise<CommandResult> {
  const body = raw.replace(/^\/doc\s*/i, '').trim()
  if (!body || body === 'help') {
    return {
      handled: true,
      text: [
        '文档命令用法：',
        '`/doc list`',
        '`/doc new 标题`',
        '`/doc switch 1` 或 `/doc switch <tabId|标题>`',
        '`/doc write 内容` / `/doc append 内容`',
        '`/doc replace 原文 => 新文`',
        '`/doc format 章节标题`',
        '`/doc rewrite 章节标题 => 新章节内容`',
        '`/doc rename 新标题`',
        '`/doc save`',
      ].join('\n'),
    }
  }

  useMode.getState().setWorkbenchMode('document')
  const docStore = useDocTabs.getState()
  const [command, ...rest] = body.split(' ')
  const arg = rest.join(' ').trim()

  if (command === 'list') {
    const lines = docStore.tabs.map((tab, index) => `${index + 1}. ${tab.title} (${tab.id})${tab.id === docStore.activeTabId ? ' [当前]' : ''}`)
    return { handled: true, text: lines.length > 0 ? lines.join('\n') : '当前没有文档标签' }
  }

  if (command === 'new') {
    docStore.openTab('')
    const active = getActiveDocTab()
    const title = arg.trim()
    if (active && title) docStore.renameTab(active.id, title)
    return { handled: true, text: `已创建文档标签：${title || active?.title || '新文档'}` }
  }

  if (command === 'open') {
    if (!arg) return { handled: true, text: '请提供文件路径：/doc open /path/to/file.md', isError: true }
    docStore.openTab(arg)
    const currentStore = useDocTabs.getState()
    const opened = currentStore.tabs.find((tab) => tab.path === arg) || getActiveDocTab()
    if (!opened) return { handled: true, text: `已打开文档：${arg}` }
    const loaded = await loadDocumentContentForEditing(arg)
    if (!loaded.success) {
      return { handled: true, text: `已打开文档：${arg}（读取失败：${loaded.error || '未知错误'}）`, isError: true }
    }
    currentStore.updateTabContent(opened.id, loaded.content)
    currentStore.markTabSaved(opened.id)
    return { handled: true, text: `已打开并载入文档：${arg}（${loaded.content.length} 字）` }
  }

  if (command === 'switch') {
    const tab = resolveDocTab(arg)
    if (!tab) return { handled: true, text: `未找到文档标签：${arg || '(空)'}`, isError: true }
    docStore.setActiveTab(tab.id)
    return { handled: true, text: `已切换到：${tab.title}` }
  }

  if (command === 'rename') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可重命名的文档标签', isError: true }
    if (!arg) return { handled: true, text: '请提供新标题：/doc rename 新标题', isError: true }
    docStore.renameTab(tab.id, arg)
    return { handled: true, text: `已重命名为：${arg}` }
  }

  if (command === 'write') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可写入的文档标签', isError: true }
    docStore.setTabContent(tab.id, normalizeText(arg))
    return { handled: true, text: `已写入内容到：${tab.title}` }
  }

  if (command === 'append') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可追加的文档标签', isError: true }
    const text = normalizeText(arg)
    const prefix = tab.content.trim().length === 0 ? '' : (tab.content.endsWith('\n') ? '' : '\n')
    docStore.appendTabContent(tab.id, `${prefix}${text}`)
    return { handled: true, text: `已追加内容到：${tab.title}` }
  }

  if (command === 'replace') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可替换的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) {
      return { handled: true, text: '替换格式：/doc replace 原文 => 新文', isError: true }
    }
    const from = arg.slice(0, sep).trim()
    const to = arg.slice(sep + 2).trim()
    docStore.setTabContent(tab.id, tab.content.split(from).join(to))
    return { handled: true, text: `已在 ${tab.title} 中完成替换` }
  }

  if (command === 'format') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可格式化章节的文档标签', isError: true }
    const sectionTitle = arg.trim()
    if (!sectionTitle) {
      return { handled: true, text: '章节格式优化格式：/doc format 章节标题', isError: true }
    }
    const formatted = formatSectionInDocument(tab.content, sectionTitle)
    if (!formatted.found) {
      return { handled: true, text: `未找到章节“${sectionTitle}”，未做改动`, isError: true }
    }
    docStore.setTabContent(tab.id, formatted.content)
    return { handled: true, text: `已优化章节格式：${formatted.matchedTitle || sectionTitle}` }
  }

  if (command === 'rewrite') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可重写章节的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) {
      return { handled: true, text: '章节重写格式：/doc rewrite 章节标题 => 新章节内容', isError: true }
    }
    const sectionTitle = arg.slice(0, sep).trim()
    const content = arg.slice(sep + 2).trim()
    if (!sectionTitle) return { handled: true, text: '章节重写缺少章节标题', isError: true }
    const rewritten = rewriteSectionInDocument(tab.content, sectionTitle, content, { appendIfMissing: false })
    if (!rewritten.found) {
      return { handled: true, text: `未找到章节“${sectionTitle}”，未做改动`, isError: true }
    }
    docStore.setTabContent(tab.id, rewritten.content)
    return { handled: true, text: `已重写章节：${rewritten.matchedTitle || sectionTitle}` }
  }

  if (command === 'clear') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可清空的文档标签', isError: true }
    docStore.setTabContent(tab.id, '')
    return { handled: true, text: `已清空文档：${tab.title}` }
  }

  if (command === 'save') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可保存的文档标签', isError: true }
    if (!tab.path) return { handled: true, text: `文档 ${tab.title} 还没有文件路径，暂不能保存`, isError: true }
    if (!tab.isDirty) return { handled: true, text: `文档未改动，已跳过保存：${tab.path}` }
    const saveBlockedReason = getDirectSaveBlockReason(tab.path)
    if (saveBlockedReason) {
      return { handled: true, text: saveBlockedReason, isError: true }
    }
    if (typeof window === 'undefined' || !window.electronAPI?.document?.writeFile) {
      return { handled: true, text: '当前环境不支持保存文档', isError: true }
    }
    const result = await window.electronAPI.document.writeFile(tab.path, tab.content)
    if (!result.success) {
      return { handled: true, text: `保存失败：${result.error || tab.path}`, isError: true }
    }
    docStore.markTabSaved(tab.id)
    return { handled: true, text: `已保存：${tab.path}` }
  }

  return { handled: true, text: `未知文档命令：${command}`, isError: true }
}

export const useAgent = create<AgentState>((set, get) => ({
  agents: [
    { name: 'butler', displayName: '管家', avatar: '🤖', status: 'idle', selected: true },
    { name: 'copywriter', displayName: '文案', avatar: '✍️', status: 'idle', selected: false },
    { name: 'video-editor', displayName: '剪辑', avatar: '🎬', status: 'idle', selected: false },
    { name: 'analyst', displayName: '分析', avatar: '📊', status: 'idle', selected: false }
  ],
  messages: [
    {
      id: 'welcome',
      agent: 'butler',
      content: '你好！我是 Ready 的管家 Agent。我可以帮你协调文案、剪辑、分析等 Agent 完成自媒体创作任务。今天想做什么？',
      type: 'agent',
      timestamp: new Date()
    }
  ],
  currentAgent: 'butler',
  inputValue: '',
  isStreaming: false,
  streamingMessageId: null,
  streamingRequestId: null,
  sessionId: generateSessionId(),
  conversationId: null,
  conversations: [],
  currentScopeId: null,
  currentScope: null,
  scopes: [],
  scopeRunStates: {},
  toolTrace: [],
  toolTraceStatus: 'idle',
  attachments: [],
  filePool: [],
  activeAttachmentPreview: null,
  sendCoalescingEnabled: true,
  sendCoalescingWindowMs: DEFAULT_SEND_COALESCE_WINDOW_MS,
  pendingSendCount: 0,
  pendingSendFlushAt: null,

  setAgents: (agents) => set({ agents }),

  selectAgent: (name) => set({ currentAgent: name }),

  toggleAgentSelection: (name) => set((state) => ({
    agents: state.agents.map(a =>
      a.name === name ? { ...a, selected: !a.selected } : a
    )
  })),

  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message]
  })),

  appendToMessage: (id, chunk) => set((state) => ({
    messages: state.messages.map(m =>
      m.id === id ? { ...m, content: m.content + chunk } : m
    )
  })),

  setInputValue: (value) => set({ inputValue: value }),

  setIsStreaming: (streaming) => set({ isStreaming: streaming }),

  setActiveAttachmentPreview: (preview) => set({ activeAttachmentPreview: preview }),

  loadSendPreferences: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    try {
      const [enabledResult, windowResult] = await Promise.all([
        window.electronAPI.settings.get('agent_message_coalesce_enabled'),
        window.electronAPI.settings.get('agent_message_coalesce_window_ms'),
      ])
      set({
        sendCoalescingEnabled: enabledResult.success ? enabledResult.data !== 'false' : true,
        sendCoalescingWindowMs: windowResult.success && Number(windowResult.data) > 0
          ? Math.max(0, Math.min(5000, Number(windowResult.data)))
          : DEFAULT_SEND_COALESCE_WINDOW_MS,
      })
    } catch {
      set({
        sendCoalescingEnabled: true,
        sendCoalescingWindowMs: DEFAULT_SEND_COALESCE_WINDOW_MS,
      })
    }
  },

  setSendCoalescingEnabled: async (enabled) => {
    set({ sendCoalescingEnabled: enabled })
    if (typeof window !== 'undefined' && window.electronAPI?.settings) {
      await window.electronAPI.settings
        .set('agent_message_coalesce_enabled', enabled ? 'true' : 'false')
        .catch(() => undefined)
    }
    if (!enabled) {
      await flushPendingSendBuffer().catch(() => undefined)
    }
  },

  setSendCoalescingWindowMs: async (windowMs) => {
    const nextValue = Math.max(0, Math.min(5000, Math.round(windowMs)))
    set({ sendCoalescingWindowMs: nextValue })
    if (typeof window !== 'undefined' && window.electronAPI?.settings) {
      await window.electronAPI.settings
        .set('agent_message_coalesce_window_ms', String(nextValue))
        .catch(() => undefined)
    }
  },

  clearToolTrace: () => set((state) => {
    const scopeId = state.currentScopeId
    if (!scopeId) {
      return { toolTrace: [], toolTraceStatus: 'idle' }
    }
    const currentRun = state.scopeRunStates[scopeId]
    return {
      scopeRunStates: {
        ...state.scopeRunStates,
        [scopeId]: currentRun
          ? { ...currentRun, toolTrace: [] }
          : {
            scopeId,
            agent: state.currentAgent,
            requestId: null,
            phase: 'idle',
            toolTrace: [],
            startedAt: null,
            updatedAt: null,
            latestText: null,
            blockedReason: null,
            controllerId: null,
            ownerTabId: null,
            checkpointExpiresAt: null,
            stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
            error: null,
          },
      },
      toolTrace: [],
      toolTraceStatus: currentRun ? phaseToToolTraceStatus(currentRun.phase) : 'idle',
    }
  }),

  stopStreaming: () => {
    const { currentAgent, currentScopeId } = get()
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.agent.kill(currentAgent, currentScopeId || undefined).catch(console.error)
    }
  },

  undoLastMessage: () => {
    const { messages, currentAgent, currentScopeId, isStreaming } = get()
    if (isStreaming) return

    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx <= 0) return

    const undoneContent = messages[lastUserIdx].content
    const restored = messages.slice(0, lastUserIdx)

    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.agent.newSession(currentAgent, currentScopeId || undefined).catch(console.error)
    }

    set({
      messages: restored,
      inputValue: undoneContent,
      isStreaming: false,
      streamingMessageId: null,
      streamingRequestId: null,
      toolTrace: [],
      toolTraceStatus: 'idle',
    })
  },

  newSession: () => {
    const { currentAgent } = get()
    const agentData = get().agents.find(a => a.name === currentAgent)
    const displayName = agentData?.displayName || '管家'
    const fallbackScope: ConversationScope = {
      id: `conv-${generateId('local')}`,
      agent: currentAgent,
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: '',
      meta: { sourceLabel: '应用内' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
    }

    set({
      messages: [
        {
          id: `welcome-${Date.now()}`,
          agent: currentAgent,
          content: `你好！我是 Ready 的${displayName} Agent。新的对话已开始，有什么我可以帮你的？`,
          type: 'agent',
          timestamp: new Date()
        }
      ],
      isStreaming: false,
      streamingMessageId: null,
      streamingRequestId: null,
      sessionId: generateSessionId(),
      conversationId: fallbackScope.id,
      currentScopeId: fallbackScope.id,
      currentScope: fallbackScope,
      scopeRunStates: {
        ...get().scopeRunStates,
        [fallbackScope.id]: {
          scopeId: fallbackScope.id,
          agent: currentAgent,
          requestId: null,
          phase: 'idle',
          toolTrace: [],
          startedAt: null,
          updatedAt: null,
          latestText: null,
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          error: null,
        },
      },
      toolTrace: [],
      toolTraceStatus: 'idle',
      attachments: [],
      filePool: []
    })

    if (typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope) {
      void window.electronAPI.agent.createLocalScope(currentAgent)
        .then((result) => {
          if (!result.success || !result.data) return
          const scope = result.data as unknown as ConversationScope
          const currentState = useAgent.getState()
          const updatedScopes = [scope, ...currentState.scopes.filter((item) => item.id !== scope.id)]
          useAgent.setState({
            currentScopeId: scope.id,
            currentScope: scope,
            conversationId: scope.id,
            scopes: updatedScopes,
            conversations: updatedScopes.map(mapScopeToConversation),
          })
        })
        .catch(console.error)
    }
  },

  loadScopes: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const { currentAgent } = get()
      const result = await window.electronAPI.agent.listConversationScopes(currentAgent)
      if (!result.success || !result.data) return
      const scopes = result.data as unknown as ConversationScope[]
      const currentScopeId = get().currentScopeId
      const currentScope = scopes.find((scope) => scope.id === currentScopeId) || scopes[0] || null
      const activeRunState = getActiveScopeRunState(get().scopeRunStates, currentScope?.id || null)
      set({
        scopes,
        conversations: scopes.map(mapScopeToConversation),
        currentScopeId: currentScope?.id || null,
        currentScope: currentScope || null,
        conversationId: currentScope?.id || null,
        currentAgent: currentScope?.agent || get().currentAgent,
        toolTrace: activeRunState?.toolTrace || [],
        toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
        isStreaming: isActiveScopePhase(activeRunState?.phase),
        streamingRequestId: activeRunState?.requestId || null,
      })
    } catch { /* ignore */ }
  },

  loadScope: async (scopeId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const result = await window.electronAPI.agent.getConversationScopeMessages(scopeId)
      if (!result.success || !result.data) return
      const scopes = get().scopes
      const scope = scopes.find((item) => item.id === scopeId) || null
      const activeRunState = getActiveScopeRunState(get().scopeRunStates, scopeId)
      const messages: AgentMessage[] = result.data.map((m: { id: string; role: string; content: string; timestamp: string; meta?: Record<string, unknown> }) => ({
        id: m.id,
        agent: scope?.agent || get().currentAgent,
        content: m.content,
        type: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'agent' : 'system',
        timestamp: new Date(m.timestamp),
        attachments: extractAttachmentsFromMeta(m.meta),
        meta: m.meta || {},
      }))
      set({
        messages,
        currentScopeId: scopeId,
        currentScope: scope,
        conversationId: scopeId,
        currentAgent: scope?.agent || get().currentAgent,
        isStreaming: isActiveScopePhase(activeRunState?.phase),
        streamingMessageId: null,
        streamingRequestId: activeRunState?.requestId || null,
        toolTrace: activeRunState?.toolTrace || [],
        toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
        attachments: [],
        filePool: [],
      })
    } catch { /* ignore */ }
  },

  setCurrentScope: async (scopeId: string) => {
    await get().loadScope(scopeId)
  },

  // W2: Load conversations list
  loadConversations: async () => {
    await get().loadScopes()
  },

  // W2: Load a specific conversation
  loadConversation: async (convId: string) => {
    await get().loadScope(convId)
  },

  // W2: Delete conversation
  deleteConversation: async (convId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.chat) return
    try {
      await window.electronAPI.chat.deleteConversation(convId)
      const { conversations, scopes, currentScopeId } = get()
      set({
        conversations: conversations.filter(c => c.id !== convId),
        scopes: scopes.filter(scope => scope.id !== convId),
      })
      // If we're viewing the deleted conversation, start fresh
      if (currentScopeId === convId) {
        get().newSession()
      }
    } catch { /* ignore */ }
  },

  // W3: Add attachments
  addAttachments: (files: ChatAttachment[]) => set((state) => ({
    attachments: [...state.attachments, ...files],
    filePool: [...state.filePool, ...files.filter(f => !state.filePool.some(p => p.path === f.path))]
  })),

  removeAttachment: (id: string) => set((state) => ({
    attachments: state.attachments.filter(a => a.id !== id)
  })),

  clearAttachments: () => set({ attachments: [] }),

  // W3: Pick files via system dialog
  pickFiles: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.chat) return
    try {
      const result = await window.electronAPI.chat.pickFiles()
      if (result.success && result.data && result.data.length > 0) {
        const attachments: ChatAttachment[] = result.data.map((f: { name: string; path: string; type: string; size: number; ext: string }) => ({
          id: generateId('attach'),
          name: f.name,
          path: f.path,
          type: f.type as ChatAttachment['type'],
          size: f.size,
          ext: f.ext
        }))
        get().addAttachments(attachments)
      }
    } catch { /* ignore */ }
  },

  sendMessage: async (content: string) => {
    const normalizedContent = content.trim()
    if (!normalizedContent) return

    const stateBeforeSend = get()
    const shouldCoalesce =
      !bypassCoalescingOnce &&
      !stateBeforeSend.isStreaming &&
      stateBeforeSend.sendCoalescingEnabled &&
      !normalizedContent.startsWith('/') &&
      stateBeforeSend.sendCoalescingWindowMs > 0

    if (shouldCoalesce) {
      const targetScopeId = stateBeforeSend.currentScopeId || null
      const targetAgent = stateBeforeSend.currentAgent
      const sameBufferedTarget =
        pendingSendBuffer &&
        pendingSendBuffer.scopeId === targetScopeId &&
        pendingSendBuffer.agent === targetAgent

      if (pendingSendBuffer && !sameBufferedTarget) {
        await flushPendingSendBuffer()
      }

      if (sameBufferedTarget && pendingSendBuffer) {
        pendingSendBuffer.parts.push(normalizedContent)
      } else {
        pendingSendBuffer = {
          scopeId: targetScopeId,
          agent: targetAgent,
          parts: [normalizedContent],
        }
      }

      if (pendingSendTimer) clearTimeout(pendingSendTimer)
      const flushAt = Date.now() + stateBeforeSend.sendCoalescingWindowMs
      pendingSendTimer = setTimeout(() => {
        void flushPendingSendBuffer()
      }, stateBeforeSend.sendCoalescingWindowMs)

      set({
        pendingSendCount: pendingSendBuffer.parts.length,
        pendingSendFlushAt: flushAt,
      })
      return
    }

    bypassCoalescingOnce = false
    const { currentAgent, addMessage, setIsStreaming, attachments, currentScope, currentScopeId } = get()

    let scope = currentScope
    let scopeId = currentScopeId
    if ((!scope || !scopeId) && typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope) {
      const created = await window.electronAPI.agent.createLocalScope(currentAgent).catch(() => null)
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set({
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        })
      }
    }
    if (!scope || !scopeId) {
      get().newSession()
      scope = get().currentScope
      scopeId = get().currentScopeId
    }
    if (
      scope &&
      scope.sourceKind === 'local' &&
      !get().scopes.some((item) => item.id === scopeId) &&
      typeof window !== 'undefined' &&
      window.electronAPI?.agent?.createLocalScope
    ) {
      const created = await window.electronAPI.agent.createLocalScope(currentAgent).catch(() => null)
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set({
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        })
      }
    }
    if (
      scope &&
      scope.sourceKind === 'local' &&
      scope.agent !== currentAgent &&
      typeof window !== 'undefined' &&
      window.electronAPI?.agent?.createLocalScope
    ) {
      const created = await window.electronAPI.agent.createLocalScope(currentAgent).catch(() => null)
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set({
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        })
      }
    }
    if (!scope || !scopeId) return
    const activeScope = scope

    // Capture attachments before clearing
    const currentAttachments = [...attachments]
    set({ attachments: [] })

    // Build display content (include @[filename] references)
    const userMsgId = generateId('msg')
    addMessage({
      id: userMsgId,
      agent: currentAgent,
      content,
      type: 'user',
      timestamp: new Date(),
      attachments: currentAttachments.length > 0 ? [...currentAttachments] : undefined
    })

    // Persist user message
    const persistedAttachments = serializePersistedAttachments(currentAttachments)
    await persistMessage(scopeId, userMsgId, 'user', content, {
      sourceKind: activeScope.sourceKind,
      sourceId: activeScope.sourceId,
      threadKey: activeScope.threadKey,
      direction: 'local-input',
      attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
    })

    if ((activeScope.title === '新对话' || activeScope.title === '未命名会话') && typeof window !== 'undefined' && window.electronAPI?.chat) {
      const firstAttachmentName = currentAttachments[0]?.name
      const title = content.slice(0, 20) || (firstAttachmentName ? `附件: ${firstAttachmentName}` : '新对话')
      if (title) {
        void window.electronAPI.chat.updateConversationTitle({ id: scopeId, title }).catch(() => undefined)
        const nextScope = { ...activeScope, title, updatedAt: new Date().toISOString() }
        set((state) => {
          const scopes = state.scopes.map((item) => item.id === scopeId ? nextScope : item)
          return {
            currentScope: nextScope,
            scopes,
            conversations: scopes.map(mapScopeToConversation),
          }
        })
      }
    }

    const trimmedInput = content.trim()
    if (trimmedInput.startsWith('/skill') || trimmedInput.startsWith('/doc')) {
      const commandResult = trimmedInput.startsWith('/skill')
        ? await runSkillCommand(trimmedInput, currentAttachments)
        : await runDocCommand(trimmedInput)

      if (commandResult.handled) {
        const responseId = generateId('response')
        addMessage({
          id: responseId,
          agent: currentAgent,
          content: commandResult.text,
          type: commandResult.isError ? 'system' : 'agent',
          timestamp: new Date(),
        })
        persistMessage(scopeId, responseId, 'assistant', commandResult.text)
        return
      }
    }

    const activeDocContext = buildActiveDocumentContext()
    const baseUserMessage = activeDocContext
      ? `${content}\n\n${activeDocContext}`
      : content

    if (typeof window !== 'undefined' && window.electronAPI && get().isStreaming) {
      await window.electronAPI.agent.kill(currentAgent, scopeId).catch(console.error)
    }

    setIsStreaming(true)
    const requestId = generateId('req')

    const responseId = generateId('response')
    addMessage({
      id: responseId,
      agent: currentAgent,
      content: '',
      type: 'agent',
      timestamp: new Date()
    })
    set((state) => ({
      streamingMessageId: responseId,
      streamingRequestId: requestId,
      toolTrace: [],
      toolTraceStatus: 'running',
      scopeRunStates: {
        ...state.scopeRunStates,
        [scopeId]: {
          scopeId,
          agent: currentAgent,
          requestId,
          phase: 'planning',
          toolTrace: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestText: null,
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          error: null,
        },
      },
    }))

    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        // W5: Build multimodal content — read files and build enhanced message
        type MultimodalBlock = { type: 'text' | 'image' | 'video'; text?: string; base64?: string; mimeType?: string }
        let finalMessage: string | MultimodalBlock[] = baseUserMessage
        const aiConfigRes = await window.electronAPI.settings.getAIConfig().catch(() => ({ success: false } as const))
        const aiConfig = aiConfigRes.success ? aiConfigRes.data : null
        const normalizedBaseUrl = aiConfig?.baseUrl?.replace(/\/+$/, '') || ''
        const isKimiCoding =
          !!aiConfig &&
          normalizedBaseUrl.includes('api.kimi.com/coding')
        const supportsNativeVideo =
          !!aiConfig &&
          (isKimiCoding || (
            aiConfig.provider !== 'anthropic' &&
            !normalizedBaseUrl.includes('/coding')
          ))

        if (currentAttachments.length > 0) {
          const blocks: MultimodalBlock[] = []
          // Add user text first
          if (baseUserMessage) blocks.push({ type: 'text', text: baseUserMessage })

          for (const att of currentAttachments) {
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

                if (window.electronAPI?.browser?.getTabContext && att.browserTabId) {
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

                const refText = formatBrowserTabReference({
                  name: att.name,
                  title: snapshot.title,
                  url: snapshot.url,
                  heading: snapshot.heading,
                  selection: snapshot.selection,
                  excerpt: snapshot.excerpt,
                })
                blocks.push({ type: 'text', text: `\n\n${refText}` })
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
                    // Send actual base64 image for AI vision
                    blocks.push({
                      type: 'image',
                      base64: fileResult.data.base64,
                      mimeType: fileResult.data.mimeType || 'image/png'
                    })
                  } else if (fileResult.data.type === 'video' && fileResult.data.base64) {
                    // Send actual base64 video for models that support video_url input
                    blocks.push({
                      type: 'video',
                      base64: fileResult.data.base64,
                      mimeType: fileResult.data.mimeType || 'video/mp4'
                    })
                  } else if (fileResult.data.type === 'text') {
                    blocks.push({
                      type: 'text',
                      text: `\n\n--- 附件: ${att.name} ---\n- 路径: ${att.path}\n${fileResult.data.content?.slice(0, 10000) || ''}`,
                    })
                  }
                }
              } catch { /* skip failed files */ }
            }

          const hasMediaBlocks = blocks.some((b) => b.type === 'image' || b.type === 'video')
          // Use multimodal blocks only if there are real media blocks, otherwise flatten to text
          if (hasMediaBlocks && blocks.length > 0) {
            finalMessage = blocks
          } else {
            finalMessage = blocks.map(b => b.text || '').join('')
          }
        }

        // Also resolve @[filename] references from filePool
        const { filePool } = get()
        const atRefs = content.match(/@\[([^\]]+)\]/g)
        if (atRefs && filePool.length > 0) {
          for (const ref of atRefs) {
            const fileName = ref.slice(2, -1) // extract name from @[name]
            const poolFile = filePool.find(f => f.name === fileName)
            if (poolFile) {
              try {
                if (poolFile.source === 'skill-folder') {
                  const refText = `\n\n--- 引用技能目录: ${poolFile.name} ---\n路径: ${poolFile.skillFolderPath || poolFile.path}\n${poolFile.skillId ? `skillId: ${poolFile.skillId}\n` : ''}可使用 /skill 命令执行相关动作。`
                  if (typeof finalMessage === 'string') {
                    finalMessage += refText
                  } else {
                    finalMessage.push({ type: 'text', text: refText })
                  }
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

                  if (window.electronAPI?.browser?.getTabContext && poolFile.browserTabId) {
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

                  const refText = `\n\n--- 引用网页: ${poolFile.name} ---\n${formatBrowserTabReference({
                    name: poolFile.name,
                    title: snapshot.title,
                    url: snapshot.url,
                    heading: snapshot.heading,
                    selection: snapshot.selection,
                    excerpt: snapshot.excerpt,
                  })}`
                  if (typeof finalMessage === 'string') {
                    finalMessage += refText
                  } else {
                    finalMessage.push({ type: 'text', text: refText })
                  }
                  continue
                }

                const fileResult = await window.electronAPI.chat.readFileForAI(poolFile.path)
                if (fileResult.success && fileResult.data && fileResult.data.type === 'text') {
                  const refText = `\n\n--- 引用文件: ${fileName} ---\n- 路径: ${poolFile.path}\n${fileResult.data.content?.slice(0, 10000) || ''}`
                  if (typeof finalMessage === 'string') {
                    finalMessage += refText
                  } else {
                    finalMessage.push({ type: 'text', text: refText })
                  }
                }
              } catch { /* skip */ }
            }
          }
        }

        const result = window.electronAPI.agent.sendScoped
          ? await window.electronAPI.agent.sendScoped(scopeId, finalMessage, requestId)
          : await window.electronAPI.agent.send(currentAgent, finalMessage, scopeId || undefined, requestId)

        if (!result.success) {
          if (get().streamingRequestId !== requestId) {
            return
          }
          set((state) => ({
            messages: state.messages.map(m =>
              m.id === responseId
                ? { ...m, content: `${result.error || '发送失败'}`, type: 'system' as const }
                : m
            ),
            isStreaming: false,
            streamingMessageId: null,
            streamingRequestId: null,
            scopeRunStates: {
              ...state.scopeRunStates,
              [scopeId]: {
                ...(state.scopeRunStates[scopeId] || {
                  scopeId,
                  agent: currentAgent,
                  requestId,
                  toolTrace: [],
                  startedAt: new Date().toISOString(),
                }),
                requestId,
                phase: 'error',
                updatedAt: new Date().toISOString(),
                error: result.error || '发送失败',
              },
            },
            toolTraceStatus: 'error',
          }))
        }
        // Stream data arrives via onStream listener
        // Persistence of assistant message happens in onStream 'done' handler
      } else {
        // Mock response for browser-only development
        const mockResponses = [
          `收到你的消息: "${content}"\n\n我正在处理中...这是模拟回复，在 Electron 环境中会连接到 Claude API。\n\n### 功能列表\n- **文案创作**: 帮助撰写高质量内容\n- **数据分析**: 分析热门趋势\n- *视频脚本*: 创作视频脚本\n\n\`\`\`javascript\nconsole.log("Hello Ready!")\n\`\`\``,
          `好的，我来帮你处理: "${content}"\n\n当前运行在浏览器预览模式，Agent 功能需要在 Electron 中使用。\n\n## 提示\n1. 启动 Electron 应用\n2. 配置 \`ANTHROPIC_API_KEY\`\n3. 即可使用 **AI Agent** 能力`,
          `了解！"${content}" 这个需求我可以帮你完成。\n\n提示：启动 Electron 应用并配置 ANTHROPIC_API_KEY 即可使用真实 AI 能力。`
        ]
        const mockReply = mockResponses[Math.floor(Math.random() * mockResponses.length)]

        let i = 0
        const typeInterval = setInterval(() => {
          if (i < mockReply.length) {
            const chunk = mockReply.slice(i, i + Math.floor(Math.random() * 3) + 1)
            get().appendToMessage(responseId, chunk)
            i += chunk.length
          } else {
            clearInterval(typeInterval)
            if (get().streamingRequestId === requestId) {
              set({ isStreaming: false, streamingMessageId: null, streamingRequestId: null })
            }
          }
        }, 30)
      }
    } catch (error) {
      if (get().streamingRequestId !== requestId) return
      set((state) => ({
        messages: state.messages.map(m =>
          m.id === responseId
            ? { ...m, content: `错误: ${error instanceof Error ? error.message : String(error)}`, type: 'system' as const }
            : m
        ),
        isStreaming: false,
        streamingMessageId: null,
        streamingRequestId: null,
        scopeRunStates: {
          ...state.scopeRunStates,
          [scopeId]: {
            ...(state.scopeRunStates[scopeId] || {
              scopeId,
              agent: currentAgent,
              requestId,
              toolTrace: [],
              startedAt: new Date().toISOString(),
            }),
            requestId,
            phase: 'error',
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          },
        },
        toolTraceStatus: 'error',
      }))
    }
  }
  ,

  sendMessageToScope: async (scopeId: string, content: string) => {
    if (get().currentScopeId !== scopeId) {
      await get().loadScope(scopeId)
    }
    await get().sendMessage(content)
  }
}))

// ---------------------------------------------------------------------------
// Listener lifecycle management
// ---------------------------------------------------------------------------

let listenersInitialized = false

function syncActiveScopeRunAliases(
  state: Pick<AgentState, 'currentScopeId' | 'scopeRunStates'>,
): Pick<AgentState, 'isStreaming' | 'toolTrace' | 'toolTraceStatus'> {
  const activeRunState = getActiveScopeRunState(state.scopeRunStates, state.currentScopeId)
  return {
    isStreaming: isActiveScopePhase(activeRunState?.phase),
    toolTrace: activeRunState?.toolTrace || [],
    toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
  }
}

function upsertScopeRunState(
  scopeId: string,
  updater: (previous: ScopeRunState | null) => ScopeRunState,
): void {
  useAgent.setState((state) => {
    const previous = state.scopeRunStates[scopeId] || null
    const next = updater(previous)
    const nextScopeRunStates = {
      ...state.scopeRunStates,
      [scopeId]: next,
    }
    return {
      scopeRunStates: nextScopeRunStates,
      ...syncActiveScopeRunAliases({
        currentScopeId: state.currentScopeId,
        scopeRunStates: nextScopeRunStates,
      }),
    }
  })
}

export function initAgentListeners(): () => void {
  if (listenersInitialized) return () => { /* already initialized */ }
  if (typeof window === 'undefined' || !window.electronAPI) return () => { /* no electronAPI */ }

  listenersInitialized = true
  void useAgent.getState().loadSendPreferences()

  const cleanupStream = window.electronAPI.agent.onStream((data) => {
    const { streamingMessageId, streamingRequestId, appendToMessage, setIsStreaming, currentScopeId, currentAgent, currentScope } = useAgent.getState()
    if (!streamingMessageId || !streamingRequestId) return
    if (data.agent !== currentAgent) return
    if (data.runId !== streamingRequestId) return
    if ((data.sessionId || undefined) !== (currentScopeId || undefined)) return

    if (data.type === 'result' || data.type === 'done') {
      if (currentScopeId && streamingMessageId) {
        void (async () => {
          const msg = useAgent.getState().messages.find((item) => item.id === streamingMessageId)
          if (!msg || !msg.content) return
          // Legacy ready-doc-action parsing is disabled.
          // Document mutations should only happen through explicit toolAction events.
          await persistMessage(currentScopeId, streamingMessageId, 'assistant', msg.content, {
            sourceKind: currentScope?.sourceKind || 'local',
            sourceId: currentScope?.sourceId || 'app',
            threadKey: currentScope?.threadKey || currentScopeId,
            direction: 'assistant-output',
          })
        })()
      }
      setIsStreaming(false)
      useAgent.setState({
        streamingMessageId: null,
        streamingRequestId: null,
        toolTraceStatus: 'done',
      })
      return
    }

    if (data.type !== 'text') {
      return
    }

    if (streamingMessageId && data.chunk) {
      appendToMessage(streamingMessageId, data.chunk)
    }
  })

  const cleanupStatus = window.electronAPI.agent.onStatusChange((data) => {
    const { agents, setAgents, streamingRequestId, currentAgent, currentScopeId } = useAgent.getState()
    if (!streamingRequestId) return
    if (data.agent !== currentAgent) return
    if (data.runId !== streamingRequestId) return
    if ((data.sessionId || undefined) !== (currentScopeId || undefined)) return
    setAgents(
      agents.map(a =>
        a.name === data.agent ? { ...a, status: data.status as Agent['status'] } : a
      )
    )
  })

  const cleanupError = window.electronAPI.agent.onError((data) => {
    const { addMessage, setIsStreaming, streamingRequestId, currentAgent, currentScopeId } = useAgent.getState()
    if (!streamingRequestId) return
    if (data.agent !== currentAgent) return
    if (data.runId !== streamingRequestId) return
    if ((data.sessionId || undefined) !== (currentScopeId || undefined)) return
    addMessage({
      id: `error-${Date.now()}`,
      agent: data.agent,
      content: `Agent 错误: ${data.error}`,
      type: 'system',
      timestamp: new Date()
    })
    setIsStreaming(false)
    useAgent.setState({
      streamingMessageId: null,
      streamingRequestId: null,
      toolTraceStatus: 'error',
    })
  })

  let toolActionQueue: Promise<void> = Promise.resolve()

  const cleanupToolAction = window.electronAPI.agent.onToolAction((data) => {
    toolActionQueue = toolActionQueue
      .then(async () => {
        const scopeId = typeof data.sessionId === 'string' && data.sessionId.trim()
          ? data.sessionId.trim()
          : null
        if (!scopeId) return
        const agentName = typeof data.agent === 'string' && data.agent.trim()
          ? data.agent
          : useAgent.getState().currentAgent

        const tool = String(data.tool || '').trim()
        const args = (data.args || {}) as Record<string, unknown>
        if (!tool) return

        const pushTrace = (kind: ToolTraceEvent['kind'], text: string, phase: ScopeRunState['phase'] = 'tool_running') => {
          upsertScopeRunState(scopeId, (previous) => ({
            scopeId,
            agent: previous?.agent || agentName,
            requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
            phase,
            toolTrace: [
              ...(previous?.toolTrace || []),
              {
                id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                kind,
                text,
                timestamp: new Date(),
              },
            ],
            startedAt: previous?.startedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            error: previous?.error || null,
          }))
        }

        if (tool === 'app.switchMode') {
          const mode = args.mode
          if (isWorkbenchMode(mode)) {
            useMode.getState().setWorkbenchMode(mode)
          }
          pushTrace('result', `已切换到 ${String(mode || '指定')} 模式。`)
          return
        }

        if (tool === 'app.notify') {
          const text = typeof args.message === 'string' ? args.message : ''
          if (text) pushTrace('result', `通知：${text}`)
          return
        }

        if (tool === 'document.writeFile') {
          const path = typeof args.path === 'string' ? args.path : ''
          const content = typeof args.content === 'string' ? args.content : ''
          if (!path) {
            pushTrace('result', '文档工具执行失败：document.writeFile 缺少 path。', 'error')
            return
          }
          pushTrace('call', `写入文档：${path}`)
          const summaries: string[] = []
          const openSummary = await performDocAction({ type: 'open_tab', path })
          summaries.push(openSummary)
          const writeSummary = await performDocAction({ type: 'set_content', content })
          summaries.push(writeSummary)
          const saveSummary = await performDocAction({ type: 'save_tab' })
          summaries.push(saveSummary)
          pushTrace('result', summaries.join('；'))
          return
        }

        const docAction = mapToolActionToDocAction(tool, args)
        if (!docAction) return
        pushTrace('call', `执行 ${tool}`)
        const summary = await performDocAction(docAction)
        pushTrace('result', summary)
      })
      .catch((error) => {
        const scopeId = typeof data.sessionId === 'string' && data.sessionId.trim()
          ? data.sessionId.trim()
          : null
        if (!scopeId) return
        upsertScopeRunState(scopeId, (previous) => ({
          scopeId,
          agent: previous?.agent || useAgent.getState().currentAgent,
          requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
          phase: 'error',
          toolTrace: [
            ...(previous?.toolTrace || []),
            {
              id: `toolerr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'result',
              text: `文档工具执行失败：${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date(),
            },
          ],
          startedAt: previous?.startedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  })

  const cleanupScopeRunEvent = window.electronAPI.agent.onScopeRunEvent
    ? window.electronAPI.agent.onScopeRunEvent((data) => {
    const event = data as {
      type: 'started' | 'updated' | 'finished'
      scopeId: string
      agent: string
      runId?: string
      phase: ScopeRunState['phase']
      latestText?: string
      toolEvent?: { id: string; kind: ToolTraceEvent['kind']; text: string; timestamp: string }
      error?: string
      timestamp: string
    }
    if (!event.scopeId) return

    upsertScopeRunState(event.scopeId, (previous) => {
      const toolTrace = previous?.toolTrace || []
      const nextTrace = event.toolEvent
        ? [
          ...toolTrace,
          {
            id: event.toolEvent.id,
            kind: event.toolEvent.kind,
            text: event.toolEvent.text,
            timestamp: new Date(event.toolEvent.timestamp),
          },
        ]
        : toolTrace
      const patch = deriveScopeRunStatePatch(event, previous)

      return {
        scopeId: event.scopeId,
        agent: previous?.agent || event.agent,
        requestId: event.runId || previous?.requestId || null,
        phase: patch.phase || event.phase,
        toolTrace: nextTrace,
        startedAt: previous?.startedAt || event.timestamp,
        updatedAt: event.timestamp,
        latestText: patch.latestText ?? previous?.latestText ?? null,
        blockedReason: patch.blockedReason ?? previous?.blockedReason ?? null,
        controllerId: patch.controllerId ?? previous?.controllerId ?? null,
        ownerTabId: patch.ownerTabId ?? previous?.ownerTabId ?? null,
        checkpointExpiresAt: patch.checkpointExpiresAt ?? previous?.checkpointExpiresAt ?? null,
        stepMetrics: patch.stepMetrics ?? previous?.stepMetrics ?? {
          toolCalls: 0,
          toolResults: 0,
          lastToolAt: null,
        },
        error: patch.error ?? event.error ?? previous?.error ?? null,
      }
    })

    const currentState = useAgent.getState()
    if (currentState.currentScopeId === event.scopeId) {
      if (event.type === 'started') {
        useAgent.setState({
          streamingRequestId: event.runId || currentState.streamingRequestId,
        })
      }
      if (event.phase === 'done' || event.phase === 'error' || event.phase === 'cancelled') {
        useAgent.setState({
          streamingRequestId: null,
        })
      }
    }
    })
    : () => { /* scope run event not available in older test stubs */ }

  const cleanupConversationEvent = window.electronAPI.agent.onConversationEvent((data) => {
    const event = data as {
      type: 'scope_created' | 'scope_updated' | 'message_added'
      scope: ConversationScope
      message?: {
        id: string
        role: string
        content: string
        timestamp: string
        meta?: Record<string, unknown>
      }
    }
    useAgent.setState((state) => {
      const existing = state.scopes.find((scope) => scope.id === event.scope.id)
      const mergedScopes = existing
        ? state.scopes.map((scope) => scope.id === event.scope.id ? event.scope : scope)
        : [event.scope, ...state.scopes]
      const nextState: Partial<AgentState> = {
        scopes: mergedScopes,
        conversations: mergedScopes.map(mapScopeToConversation),
      }

      if (state.currentScopeId === event.scope.id) {
        nextState.currentScope = event.scope
      }

      if (event.type === 'message_added' && event.message && state.currentScopeId === event.scope.id) {
        const nextMessage: AgentMessage = {
          id: event.message.id,
          agent: event.scope.agent,
          content: event.message.content,
          type: event.message.role === 'user' ? 'user' : event.message.role === 'assistant' ? 'agent' : 'system',
          timestamp: new Date(event.message.timestamp),
          attachments: extractAttachmentsFromMeta(event.message.meta),
          meta: event.message.meta || {},
        }
        const hasMessage = state.messages.some((message) => message.id === nextMessage.id)
        nextState.messages = hasMessage ? state.messages : [...state.messages, nextMessage]
      }

      return nextState as AgentState
    })
  })

  return () => {
    listenersInitialized = false
    cleanupStream()
    cleanupStatus()
    cleanupError()
    cleanupToolAction()
    cleanupScopeRunEvent()
    cleanupConversationEvent()
  }
}
