import { calendarEventReadyRef } from '../../../../shared/calendar-event-identity'
import { toReadyUri } from '../../../../shared/ready-ref'
import type { RSSReference } from '../../../../shared/rss-reference'
import { extractPrimaryUserInstruction as extractPrimaryUserInstructionFromText } from '../../claude-bridge/tool-policy-heuristics'
import { validateWorkspaceRoot } from '../../../../shared/workspace-validation'
import type { ActionAuthorizationMode } from '../../../../shared/action-authorization-mode'

export type InputChunkSource =
  | 'user_message'
  | 'ui_resource_ref'
  | 'environment_hint'
  | 'session_recall'
  | 'attachment_body'
  | 'document_excerpt'
  | 'tool_echo'
  | 'system_generated'

export interface InputChunk {
  source: InputChunkSource
  text: string
  participatesInFirstPassIntent: boolean
}

export interface RequestEnvelopeResourceRef {
  kind: 'mention' | 'path' | 'widget' | 'document' | 'browser'
  value: string
}

export type RequestEnvelopeResourceKind =
  | 'attachment'
  | 'document_context'
  | 'document_quote'
  | 'browser_reference'
  | 'calendar_event'
  | 'calendar_window'
  | 'rss_item'
  | 'rss_source'
  | 'mcp_resource'
  | 'folder_reference'
  | 'widget_target'
  // P1-1 — 显式 @[技能] 引用：未被解析成任何既有资源的 @[token]。envelope 不校验技能存在性（授权层校验）。
  | 'skill_reference'
  | 'rss_reference'
  | 'library_resource'

export type RequestEnvelopeResourceSource =
  | 'user_attachment'
  | 'explicit_reference'
  | 'current_document'
  | 'document_quote'
  | 'browser_context'
  | 'calendar_context'
  | 'rss_context'
  | 'mcp_context'
  | 'folder_reference'
  | 'widget_target'

export interface RequestEnvelopeResource {
  id: string
  kind: RequestEnvelopeResourceKind
  source: RequestEnvelopeResourceSource
  name: string
  path: string | null
  documentPath?: string | null
  tabId?: string | null
  widgetId?: string | null
  text: string
  summary: string | null
  order: number
  canRead: boolean
  canWrite: boolean
  /** Trusted retry-only applicability carried by a Main-resolved skill reference. */
  applicableToolNames?: string[]
  // Optional fingerprint of the widget's componentSpec / widgetCode. When `text` is synthesized
  //   empty (e.g., lease-driven fallback target), cache-key builders fall back to this so different
  //   widget states don't collide on the same hash key.
  rssReference?: RSSReference
  widgetFingerprint?: string | null
  // Optional non-empty text slice from the widget body. Used symmetrically with widgetFingerprint
  //   to differentiate cache keys when the synthesized resource has no snapshot content.
  widgetTextSample?: string | null
}

export interface TrustedFolderReference {
  name: string
  path: string
}

export interface TrustedRequestEnvironment {
  workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar'
  browserPageRef?: {
    tabId: string
    physicalTargetToken: string
    mainFrameId: string
    mainFrameDocumentToken: string
    profileId?: string | null
  } | null
}

export interface RequestEnvelope {
  rawUserText: string
  pureUserText: string
  primaryInstruction: string
  chunks: InputChunk[]
  resources: RequestEnvelopeResource[]
  referencedResources: RequestEnvelopeResourceRef[]
  environmentHints: {
    hasDocumentContext: boolean
    hasWidgetTargetContext: boolean
    hasAttachments: boolean
    hasBootstrapContext: boolean
    workspaceRoots?: string[]
    workbenchMode?: TrustedRequestEnvironment['workbenchMode']
    browserPageRef?: TrustedRequestEnvironment['browserPageRef']
  }
  provenanceSummary: {
    countsBySource: Record<InputChunkSource, number>
    userControllableSourcesOnly: boolean
  }
  /**
   * Stage T PR-T5 — conversation scope id. Plumbed end-to-end into
   * `ToolPolicy.scopeId` as the per-turn product scope identity.
   * Optional — omitted in unit-test contexts that don't have a scope.
   *
   * Round-1 (Codex) fix — populated by `buildRequestEnvelope` from its
   * optional `scopeId` parameter; turn-engine forwards the value at the
   * envelope-construction call site.
   */
  scopeId?: string
  /**
   * Round-1 (Codex) — paired session identifier, kept symmetric with
   * `scopeId` so resolvers downstream don't have to reach back into the
   * raw `TurnEngineRequest`. Also optional.
   */
  sessionId?: string
  actionAuthorizationMode?: ActionAuthorizationMode
}

const LEADING_BOOTSTRAP_TITLES = new Set([
  'L1 会话上下文',
  '跨会话回看',
  '自动跨会话回看',
  'L2 按需规则',
])

export const REQUEST_CONTEXT_MARKERS = [
  '## 环境信息',
  '## 当前 Scope',
  '## 最近会话摘要',
  '### Widget 更新上下文',
  '### 当前设计画布上下文',
  '### 设计项目引用',
  '### 当前文档上下文',
  '### 文档引用',
  '### 浏览页面引用',
  '### 日程事件引用',
  '### 文件夹引用',
  '### 技能目录引用',
  '--- 测试模式附件路径 ---',
  '--- 引用设计项目:',
  '--- 引用技能目录:',
  '--- 文档摘要开始 ---',
  '--- 文档内容开始 ---',
  '--- 引用文件:',
  '--- 附件:',
] as const

const STRUCTURED_MARKERS: Array<{ marker: string; source: InputChunkSource }> = [
  { marker: '## L1 会话上下文', source: 'system_generated' },
  { marker: '## 跨会话回看', source: 'session_recall' },
  { marker: '## 自动跨会话回看', source: 'session_recall' },
  { marker: '## L2 按需规则', source: 'system_generated' },
  { marker: '## 环境信息', source: 'environment_hint' },
  { marker: '### Widget 更新上下文', source: 'ui_resource_ref' },
  { marker: '### 当前设计画布上下文', source: 'ui_resource_ref' },
  { marker: '### 设计项目引用', source: 'ui_resource_ref' },
  { marker: '### 当前文档上下文', source: 'document_excerpt' },
  { marker: '### 文档引用', source: 'ui_resource_ref' },
  { marker: '### 浏览页面引用', source: 'ui_resource_ref' },
  { marker: '### 日程事件引用', source: 'ui_resource_ref' },
  { marker: '### 文件夹引用', source: 'ui_resource_ref' },
  { marker: '### 技能目录引用', source: 'ui_resource_ref' },
  { marker: '--- 引用技能目录:', source: 'ui_resource_ref' },
  { marker: '--- 引用文件:', source: 'attachment_body' },
  { marker: '--- 附件:', source: 'attachment_body' },
]

const USER_CONTROLLABLE_SOURCES = new Set<InputChunkSource>([
  'user_message',
  'ui_resource_ref',
  'environment_hint',
])

const WRITABLE_DOCUMENT_PATTERN = /\.(md|markdown|txt|docx?)$/i

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectMarkerStarts(raw: string, marker: string): number[] {
  const starts: number[] = []
  const pattern = new RegExp(`(^|\\n)${escapeRegExp(marker)}`, 'g')
  let match = pattern.exec(raw)
  while (match) {
    starts.push(match.index + match[1].length)
    match = pattern.exec(raw)
  }
  return starts
}

interface StructuredBlock {
  marker: string
  source: InputChunkSource
  text: string
  index: number
}

function collectStructuredBlocks(raw: string): StructuredBlock[] {
  const markers = STRUCTURED_MARKERS
    .flatMap((entry) => collectMarkerStarts(raw, entry.marker).map((index) => ({
      marker: entry.marker,
      source: entry.source,
      index,
    })))
    .sort((left, right) => left.index - right.index)

  return markers.map((entry, index) => ({
    ...entry,
    text: raw.slice(entry.index, markers[index + 1]?.index ?? raw.length).trim(),
  }))
}

function stripLeadingBootstrapSections(raw: string): string {
  let remaining = String(raw || '').trim()
  while (remaining.startsWith('## ')) {
    const sectionMatch = remaining.match(/^##\s*([^\n]+)[\s\S]*?(?=(?:\n\n##\s+|\n\n[^\s#]|\n\n$|$))/)
    const headerMatch = sectionMatch?.[0]?.match(/^##\s*([^\n]+)/)
    const header = headerMatch?.[1]?.trim() || ''
    if (!LEADING_BOOTSTRAP_TITLES.has(header)) break
    if (!sectionMatch?.[0]) return ''
    remaining = remaining.slice(sectionMatch[0].length).trimStart()
  }
  return remaining
}

export function extractPureUserInput(userText: string): string {
  const strippedBootstrap = stripLeadingBootstrapSections(userText)
  if (!strippedBootstrap) return ''

  let pureInput = strippedBootstrap
  for (const marker of REQUEST_CONTEXT_MARKERS) {
    const index = collectMarkerStarts(pureInput, marker)[0] ?? -1
    if (index >= 0) {
      pureInput = pureInput.slice(0, index).trim()
    }
  }

  const userPrefixMatch = pureInput.match(/(?:^|\n)用户:\s*(.+?)(?:\n|$)/s)
  return (userPrefixMatch?.[1] || pureInput).trim()
}

function stripStructuredResourceBoilerplate(text: string): string {
  return String(text || '')
    .replace(/^---\s*(引用文件|附件):[^\n]*\n?/gm, '')
    .replace(/^(###\s*当前文档上下文|###\s*文档引用|###\s*浏览页面引用|###\s*日程事件引用|###\s*文件夹引用|###\s*Widget 更新上下文)\s*\n?/gm, '')
    .replace(/(?:^|\n)-\s*(标题|文档|路径|类型|字符数|链接|主标题|当前选中文本|页面摘要|名称|用途|目标 widget|标签页ID|widgetId|当前模式|约束|eventId|时间|日历|地点|全天|平台|状态|备注):\s*[^\n]*/g, '')
    .replace(/---\s*文档(摘要|内容)开始\s*---/g, '')
    .replace(/---\s*文档(摘要|内容)结束\s*---/g, '')
    .replace(/```(?:show-widget|quote)?[\s\S]*?```/g, '')
    .trim()
}

function extractNamedBlockValue(text: string, label: string): string | null {
  const match = text.match(new RegExp(`(?:^|\\n)-\\s*${escapeRegExp(label)}:[ \t]*([^\\n]+)`))
  return match?.[1]?.trim() || null
}

function isWritableDocumentResource(name: string, path: string | null, kind: RequestEnvelopeResourceKind): boolean {
  if (kind === 'document_context' || kind === 'widget_target') return true
  const identity = `${path || ''}\n${name}`.trim()
  return WRITABLE_DOCUMENT_PATTERN.test(identity)
}

function summarizeResourceText(text: string): string | null {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ')
  return normalized ? normalized.slice(0, 240) : null
}

function buildResourceFromBlock(
  block: StructuredBlock,
  order: number,
  trustedFolderReferences: readonly TrustedFolderReference[],
): RequestEnvelopeResource | null {
  if (block.marker === '--- 附件:' || block.marker === '--- 引用文件:') {
    const name = block.text.match(/^---\s*(?:引用文件|附件):\s*(.+?)\s*---/m)?.[1]?.trim()
    if (!name) return null
    const path = extractNamedBlockValue(block.text, '路径')
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'attachment',
      source: block.marker === '--- 附件:' ? 'user_attachment' : 'explicit_reference',
      name,
      path,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: isWritableDocumentResource(name, path, 'attachment'),
    }
  }

  if (block.marker === '### 当前文档上下文') {
    const name = extractNamedBlockValue(block.text, '标题')
      || extractNamedBlockValue(block.text, '路径')
      || '当前文档'
    const path = extractNamedBlockValue(block.text, '路径')
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'document_context',
      source: 'current_document',
      name,
      path,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: isWritableDocumentResource(name, path, 'document_context'),
    }
  }

  if (block.marker === '### 文档引用') {
    const name = extractNamedBlockValue(block.text, '文档') || '文档引用'
    const path = extractNamedBlockValue(block.text, '路径')
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'document_quote',
      source: 'document_quote',
      name,
      path,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: false,
    }
  }

  if (block.marker === '### 浏览页面引用') {
    const name = extractNamedBlockValue(block.text, '标题') || '浏览页面'
    const path = extractNamedBlockValue(block.text, '链接')
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'browser_reference',
      source: 'browser_context',
      name,
      path,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: false,
    }
  }

  if (block.marker === '### 日程事件引用') {
    const name = extractNamedBlockValue(block.text, '标题') || '日程事件'
    const eventId = extractNamedBlockValue(block.text, 'eventId')
    const allDay = extractNamedBlockValue(block.text, '全天')
    const ref = calendarEventReadyRef(eventId, allDay === '是' ? true : allDay === '否' ? false : undefined)
    const path = ref ? toReadyUri(ref) : null
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'calendar_event',
      source: 'calendar_context',
      name,
      path,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: false,
    }
  }

  if (block.marker === '### 文件夹引用') {
    const parsedName = extractNamedBlockValue(block.text, '名称') || '文件夹引用'
    const parsedPath = extractNamedBlockValue(block.text, '路径')
    const trusted = trustedFolderReferences.find((folder) => folder.name === parsedName && folder.path === parsedPath)
    if (!trusted) return null
    const { name, path } = trusted
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'folder_reference',
      source: 'folder_reference',
      name,
      path,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: false,
    }
  }

  if (block.marker === '### Widget 更新上下文') {
    const name = extractNamedBlockValue(block.text, '目标 widget') || '当前 widget'
    const path = extractNamedBlockValue(block.text, '路径')
    const tabId = extractNamedBlockValue(block.text, '标签页ID')
    const widgetId = extractNamedBlockValue(block.text, 'widgetId')
    const text = stripStructuredResourceBoilerplate(block.text)
    return {
      id: `${block.marker}-${order}-${name}`,
      kind: 'widget_target',
      source: 'widget_target',
      name,
      path,
      documentPath: path,
      tabId,
      widgetId,
      text,
      summary: summarizeResourceText(text),
      order,
      canRead: true,
      canWrite: true,
    }
  }

  return null
}

function normalizeTrustedFolderReferences(value: unknown): TrustedFolderReference[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: TrustedFolderReference[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as { name?: unknown; path?: unknown }
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    const key = `${name}\0${path}`
    if (!name || !path || seen.has(key)) continue
    seen.add(key)
    result.push({ name, path })
  }
  return result
}

export function trustedFolderReferencesFromMessageMeta(meta: unknown): TrustedFolderReference[] {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
  const attachments = (meta as { attachments?: unknown }).attachments
  if (!Array.isArray(attachments)) return []
  return normalizeTrustedFolderReferences(attachments.filter((attachment) => (
    attachment && typeof attachment === 'object' && !Array.isArray(attachment)
    && (attachment as { isDirectory?: unknown }).isDirectory === true
  )))
}

function buildReferencedResources(raw: string): RequestEnvelopeResourceRef[] {
  const refs: RequestEnvelopeResourceRef[] = []
  for (const match of raw.matchAll(/@\[([^\]]+)\]/g)) {
    const value = String(match[1] || '').trim()
    if (!value) continue
    refs.push({ kind: 'mention', value })
  }

  for (const match of raw.matchAll(/(?:^|\n)-\s*路径:\s*([^\n]+)/g)) {
    const value = String(match[1] || '').trim()
    if (!value) continue
    refs.push({ kind: 'path', value })
  }

  const widgetMatch = raw.match(/(?:^|\n)-\s*目标 widget:\s*([^\n]+)/)
  if (widgetMatch?.[1]) {
    refs.push({ kind: 'widget', value: widgetMatch[1].trim() })
  }

  return refs
}

function normalizeWorkspaceRoots(rawRoots: unknown): string[] {
  if (!Array.isArray(rawRoots)) return []
  const seen = new Set<string>()
  const roots: string[] = []
  for (const rawRoot of rawRoots) {
    if (typeof rawRoot !== 'string') continue
    const root = rawRoot.trim()
    if (!root || !validateWorkspaceRoot(root).ok || seen.has(root)) continue
    seen.add(root)
    roots.push(root)
  }
  return roots
}

/**
 * P1-4 — dormant controller 侧计算能力地板所需的两个布尔信号，直接从 envelope 结构化资源派生（envelope-only）。
 *   放在 contracts 层，供 domain-adapters 与 runtime-core 两条路径共用而不成环。
 *   skill_reference（name 可能形如 foo.md）不算本地文档资源。
 *   与 runtime-core `hasLocalDocumentResource(message, envelope)` 在 path-present 资源上一致；path-null-only
 *   资源上分歧（本函数按 path||name 命中，那侧 parseEnvelopeResourceReferences 要求 name+path）——controller
 *   复活为 live 前需统一到同一 doc-detection。
 */
export function envelopeHasLocalDocumentResource(envelope: RequestEnvelope): boolean {
  return envelope.resources.some((resource) =>
    resource.kind !== 'skill_reference' && resource.kind !== 'rss_reference'
    && (
      resource.kind === 'folder_reference'
      || resource.source === 'folder_reference'
      || /\.(?:md|markdown|txt|docx?)$/i.test(resource.path || resource.name || '')
    ))
}
export function envelopeHasCurrentDocumentContext(envelope: RequestEnvelope): boolean {
  return envelope.resources.some((resource) =>
    resource.kind === 'document_context' || resource.source === 'current_document')
}

export function envelopeHasFolderExportDestination(envelope: RequestEnvelope): boolean {
  return envelope.resources.some((resource) =>
    resource.kind === 'folder_reference' || resource.source === 'folder_reference')
}

export function buildRequestEnvelope(params: {
  userText: string
  /**
   * Round-1 (Codex) — optional `sessionId` / `scopeId` so the envelope
   * carries scope identity end-to-end. `turn-engine.ts` reads
   * `requestEnvelope.scopeId` to build `ToolPolicy.scopeId`.
   * Optional — unit-test contexts that don't have a scope can omit.
   */
  sessionId?: string
  scopeId?: string
  workspaceRoots?: string[]
  contextRefIds?: string[]
  trustedFolderReferences?: TrustedFolderReference[]
  trustedResources?: readonly RequestEnvelopeResource[]
  trustedEnvironment?: TrustedRequestEnvironment
  actionAuthorizationMode?: ActionAuthorizationMode
}): RequestEnvelope {
  const rawUserText = String(params.userText || '')
  const pureUserText = extractPureUserInput(rawUserText)
  let primaryInstruction = extractPrimaryUserInstructionFromText(pureUserText || rawUserText).trim()
  const structuredBlocks = collectStructuredBlocks(rawUserText)
  const workspaceRoots = normalizeWorkspaceRoots(params.workspaceRoots)
  const trustedFolderReferences = normalizeTrustedFolderReferences(params.trustedFolderReferences)

  const chunks: InputChunk[] = []
  if (pureUserText) {
    chunks.push({
      source: 'user_message',
      text: pureUserText,
      participatesInFirstPassIntent: true,
    })
  }

  for (const block of structuredBlocks) {
    chunks.push({
      source: block.source,
      text: block.text,
      participatesInFirstPassIntent: USER_CONTROLLABLE_SOURCES.has(block.source),
    })
  }

  const resources = structuredBlocks
    .map((block, index) => buildResourceFromBlock(block, index, trustedFolderReferences))
    .filter(Boolean) as RequestEnvelopeResource[]
  for (const resource of params.trustedResources || []) {
    resources.push({ ...resource, order: resources.length })
  }

  // Resource labels are data. A news title such as article.md must not authorize document work.
  const rssNames = new Set(resources.filter((resource) => resource.kind === 'rss_reference').map((resource) => resource.name))
  primaryInstruction = primaryInstruction.replace(/@\[([^\]]+)\]/g, (token, name: string) => rssNames.has(name) ? '资料引用' : token)

  // P1-1 — 当前轮用户文本（pureUserText，已剥离装配上下文/bootstrap）里每个 @[token]，若没有被
  //   解析成任何既有资源（附件/文档/文件夹/widget/浏览器…），追加一条 skill_reference 资源。
  //   只扫 pureUserText 而非 rawUserText：装配上下文里的 stale @[技能] 提及不得升级成本轮结构化引用
  //   （与授权层文本兜底的 staleness 纪律同构）。envelope 保持哑数据：不做技能存在性校验（校验在授权层）。
  const resolvedResourceNames = new Set(resources.map((resource) => resource.name))
  const seenSkillReferenceTokens = new Set<string>()
  for (const match of pureUserText.matchAll(/@\[([^\]]+)\]/g)) {
    const token = String(match[1] || '').trim()
    if (!token) continue
    if (resolvedResourceNames.has(token) || seenSkillReferenceTokens.has(token)) continue
    seenSkillReferenceTokens.add(token)
    const order = resources.length
    resources.push({
      id: `skill_reference-${order}-${token}`,
      kind: 'skill_reference',
      source: 'explicit_reference',
      name: token,
      path: null,
      text: '',
      summary: null,
      order,
      canRead: false,
      canWrite: false,
    })
  }

  const countsBySource = {
    user_message: 0,
    ui_resource_ref: 0,
    environment_hint: 0,
    session_recall: 0,
    attachment_body: 0,
    document_excerpt: 0,
    tool_echo: 0,
    system_generated: 0,
  } satisfies Record<InputChunkSource, number>

  for (const chunk of chunks) {
    countsBySource[chunk.source] += 1
  }

  const carriedContextRefs = Array.isArray(params.contextRefIds)
    ? params.contextRefIds
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map<RequestEnvelopeResourceRef>((value) => ({
        kind: /^(?:\/|[A-Za-z]:[\\/])/.test(value) ? 'path' : 'mention',
        value,
      }))
    : []

  return {
    rawUserText,
    pureUserText,
    primaryInstruction,
    chunks,
    resources,
    referencedResources: [
      ...buildReferencedResources(rawUserText),
      ...carriedContextRefs,
    ].filter((ref, index, all) => all.findIndex((candidate) => candidate.kind === ref.kind && candidate.value === ref.value) === index),
    environmentHints: {
      hasDocumentContext: rawUserText.includes('### 当前文档上下文') || rawUserText.includes('### 文档引用'),
      hasWidgetTargetContext: rawUserText.includes('### Widget 更新上下文'),
      hasAttachments: rawUserText.includes('--- 引用文件:') || rawUserText.includes('--- 附件:'),
      hasBootstrapContext: rawUserText.includes('## L1 会话上下文')
        || rawUserText.includes('## 跨会话回看')
        || rawUserText.includes('## 自动跨会话回看')
        || rawUserText.includes('## L2 按需规则'),
      ...(workspaceRoots.length > 0 ? { workspaceRoots } : {}),
      ...(params.trustedEnvironment?.workbenchMode
        ? { workbenchMode: params.trustedEnvironment.workbenchMode }
        : {}),
      ...(params.trustedEnvironment?.browserPageRef
        ? { browserPageRef: { ...params.trustedEnvironment.browserPageRef } }
        : {}),
    },
    provenanceSummary: {
      countsBySource,
      userControllableSourcesOnly: chunks.every((chunk) => USER_CONTROLLABLE_SOURCES.has(chunk.source)),
    },
    // Round-1 (Codex) — only set when caller passed a non-empty value so
    // existing tests that omit `sessionId / scopeId` continue to see
    // `undefined` rather than empty strings.
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.scopeId ? { scopeId: params.scopeId } : {}),
    ...(params.actionAuthorizationMode
      ? { actionAuthorizationMode: params.actionAuthorizationMode }
      : {}),
  }
}
