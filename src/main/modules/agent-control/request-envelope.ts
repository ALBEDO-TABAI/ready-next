import { extractPrimaryUserInstruction as extractPrimaryUserInstructionFromText } from '../claude-bridge/tool-policy-heuristics'

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

export interface RequestEnvelope {
  rawUserText: string
  pureUserText: string
  primaryInstruction: string
  chunks: InputChunk[]
  referencedResources: RequestEnvelopeResourceRef[]
  environmentHints: {
    hasDocumentContext: boolean
    hasWidgetTargetContext: boolean
    hasAttachments: boolean
    hasBootstrapContext: boolean
  }
  provenanceSummary: {
    countsBySource: Record<InputChunkSource, number>
    userControllableSourcesOnly: boolean
  }
}

const LEADING_BOOTSTRAP_TITLES = new Set([
  'L1 会话上下文',
  '跨会话回看',
  '自动跨会话回看',
  'L2 按需规则',
])

const CONTEXT_MARKERS = [
  '## 环境信息',
  '## 当前 Scope',
  '## 最近会话摘要',
  '### Widget 更新上下文',
  '### 当前设计画布上下文',
  '### 设计项目引用',
  '### 当前文档上下文',
  '### 文档引用',
  '### 浏览页面引用',
  '### 文件夹引用',
  '--- 引用设计项目:',
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
  { marker: '### 文件夹引用', source: 'ui_resource_ref' },
  { marker: '--- 引用文件:', source: 'attachment_body' },
  { marker: '--- 附件:', source: 'attachment_body' },
]

const USER_CONTROLLABLE_SOURCES = new Set<InputChunkSource>([
  'user_message',
  'ui_resource_ref',
  'environment_hint',
])

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

  const userPrefixMatch = strippedBootstrap.match(/用户:\s*(.+?)(?:\n|$)/s)
  if (userPrefixMatch) {
    return userPrefixMatch[1].trim()
  }

  let pureInput = strippedBootstrap
  for (const marker of CONTEXT_MARKERS) {
    const index = pureInput.indexOf(marker)
    if (index >= 0) {
      pureInput = pureInput.slice(0, index).trim()
    }
  }

  return pureInput.trim()
}

function extractStructuredChunk(raw: string, marker: string): string | null {
  const start = raw.indexOf(marker)
  if (start === -1) return null
  const nextMarkers = STRUCTURED_MARKERS
    .map((item) => item.marker)
    .filter((candidate) => candidate !== marker)
    .map((candidate) => raw.indexOf(candidate, start + marker.length))
    .filter((index) => index >= 0)
  const end = nextMarkers.length > 0 ? Math.min(...nextMarkers) : raw.length
  return raw.slice(start, end).trim()
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

export function buildRequestEnvelope(params: { userText: string }): RequestEnvelope {
  const rawUserText = String(params.userText || '')
  const pureUserText = extractPureUserInput(rawUserText)
  const primaryInstruction = extractPrimaryUserInstructionFromText(pureUserText || rawUserText).trim()

  const chunks: InputChunk[] = []
  if (pureUserText) {
    chunks.push({
      source: 'user_message',
      text: pureUserText,
      participatesInFirstPassIntent: true,
    })
  }

  for (const entry of STRUCTURED_MARKERS) {
    const text = extractStructuredChunk(rawUserText, entry.marker)
    if (!text) continue
    chunks.push({
      source: entry.source,
      text,
      participatesInFirstPassIntent: USER_CONTROLLABLE_SOURCES.has(entry.source),
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

  return {
    rawUserText,
    pureUserText,
    primaryInstruction,
    chunks,
    referencedResources: buildReferencedResources(rawUserText),
    environmentHints: {
      hasDocumentContext: rawUserText.includes('### 当前文档上下文') || rawUserText.includes('### 文档引用'),
      hasWidgetTargetContext: rawUserText.includes('### Widget 更新上下文'),
      hasAttachments: rawUserText.includes('--- 引用文件:') || rawUserText.includes('--- 附件:'),
      hasBootstrapContext: rawUserText.includes('## L1 会话上下文')
        || rawUserText.includes('## 跨会话回看')
        || rawUserText.includes('## 自动跨会话回看')
        || rawUserText.includes('## L2 按需规则'),
    },
    provenanceSummary: {
      countsBySource,
      userControllableSourcesOnly: chunks.every((chunk) => USER_CONTROLLABLE_SOURCES.has(chunk.source)),
    },
  }
}
