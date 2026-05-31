import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
import { useDocTabs } from '../../stores/useDocTabs'
import { useMode } from '../../stores/useMode'
import { parseShowWidgetFences, tryParseWidgetPayload } from '../../components/document/widget-fence-parser'
import {
  buildDocumentWidgetFenceSource,
  collectDocumentWidgets,
  summarizeWidgetRecord,
  type DocumentWidgetComponentSpecSummary,
  type DocumentWidgetRecord,
} from '../../../shared/document-widget-parse'
import { compileDocumentWidgetComponentSpec } from './documentWidgetOpenUI'
import type { DocumentWidgetComponentSpec } from '../../../shared/document-widget-openui'
import { mergeComponentSpecPatch } from '../../../shared/document-widget-patch'
import {
  findDocumentVisualSyntaxIssue,
  findShowWidgetBoundaryViolation,
} from '../../../shared/document-visual-syntax'

const MERMAID_FENCE_REGEX = /```mermaid[^\n]*\n([\s\S]*?)```/gi

export interface DocActionPayload {
  type: string
  [key: string]: unknown
}

export type DocActionMutationReason =
  | 'changed'
  | 'saved'
  | 'no_match'
  | 'identical'
  | 'rejected'
  | 'cancelled'
  | 'validation_failed'
  | 'not_mutation'

export interface DocActionMutationOutcome {
  mutated: boolean
  mutationReason: DocActionMutationReason
  documentSaved?: boolean
  errorKind?: 'widget_boundary_violation' | 'document_visual_syntax_invalid'
  recoverable?: boolean
}

function raceWithTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`docaction-timeout:${label}:${ms}`)), ms)
    op.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

const widgetWriteLocks = new Map<string, Promise<void>>()

const pendingToolDocumentWrites = new Map<string, {
  content: string
  baseContent: string
  action: string
  updatedAt: number
}>()

const RECENT_TOOL_TARGET_TTL_MS = 10 * 60 * 1000
let recentToolTargetTab: { tabId: string; updatedAt: number } | null = null

function rememberPendingToolDocumentWrite(tabId: string, content: string, action: string, baseContent: string): void {
  if (!tabId) return
  pendingToolDocumentWrites.set(tabId, { content, baseContent, action, updatedAt: Date.now() })
  rememberToolTargetTab(tabId)
}

function getPendingToolDocumentWrite(tabId: string): {
  content: string
  baseContent: string
  action: string
  updatedAt: number
} | null {
  return pendingToolDocumentWrites.get(tabId) || null
}

function clearPendingToolDocumentWrite(tabId: string): void {
  if (!tabId) return
  pendingToolDocumentWrites.delete(tabId)
}

function rememberToolTargetTab(tabId: string): void {
  if (!tabId) return
  recentToolTargetTab = { tabId, updatedAt: Date.now() }
}

function clearRecentToolTargetTab(tabId?: string): void {
  if (!recentToolTargetTab) return
  if (!tabId || recentToolTargetTab.tabId === tabId) recentToolTargetTab = null
}

// Per-tab epoch: bumped whenever a pending widget write for that tab should be
// treated as cancelled. runUpdate captures the epoch at enqueue time; before
// committing to the store it re-checks and bails if the epoch has advanced.
const widgetWriteEpoch = new Map<string, number>()

export function cancelPendingWidgetWritesForTab(tabId: string): void {
  widgetWriteEpoch.set(tabId, (widgetWriteEpoch.get(tabId) || 0) + 1)
}

export function cancelAllPendingWidgetWrites(): void {
  for (const tabId of Array.from(widgetWriteEpoch.keys())) {
    widgetWriteEpoch.set(tabId, (widgetWriteEpoch.get(tabId) || 0) + 1)
  }
}

function emitWidgetCommitted(tabId: string, widgetId: string | null | undefined): void {
  if (!tabId || !widgetId) return
  if (typeof window === 'undefined') return
  const api = (window as unknown as { electronAPI?: { document?: { notifyWidgetCommitted?: (payload: {
    tabId: string; widgetId: string; requestId?: string; committedAt: number
  }) => void } } }).electronAPI
  api?.document?.notifyWidgetCommitted?.({
    tabId,
    widgetId: String(widgetId),
    committedAt: Date.now(),
  })
}

function normalizeContentForCompare(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function hashContent(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0xdeadbeef
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822507)
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0
  h2 = (h2 ^ (h2 >>> 13)) >>> 0
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

function describeWidgetSkip(existing: string, incoming: string): {
  reason: 'byte_identical' | 'normalized_identical' | 'mismatch'
  summary: string
  detail: {
    existingLen: number
    incomingLen: number
    existingHash: string
    incomingHash: string
    normalizedExistingHash: string
    normalizedIncomingHash: string
    firstDiffOffset: number | null
  }
} {
  const normalizedExisting = normalizeContentForCompare(existing)
  const normalizedIncoming = normalizeContentForCompare(incoming)
  let firstDiffOffset: number | null = null
  const minLen = Math.min(existing.length, incoming.length)
  for (let i = 0; i < minLen; i++) {
    if (existing.charCodeAt(i) !== incoming.charCodeAt(i)) { firstDiffOffset = i; break }
  }
  if (firstDiffOffset === null && existing.length !== incoming.length) firstDiffOffset = minLen
  const detail = {
    existingLen: existing.length,
    incomingLen: incoming.length,
    existingHash: hashContent(existing),
    incomingHash: hashContent(incoming),
    normalizedExistingHash: hashContent(normalizedExisting),
    normalizedIncomingHash: hashContent(normalizedIncoming),
    firstDiffOffset,
  }
  if (existing === incoming) {
    return { reason: 'byte_identical', summary: `完全一致 hash=${detail.existingHash} len=${detail.existingLen}`, detail }
  }
  if (normalizedExisting === normalizedIncoming) {
    return {
      reason: 'normalized_identical',
      summary: `规范化后一致 len=${detail.existingLen}/${detail.incomingLen} diff@${detail.firstDiffOffset}`,
      detail,
    }
  }
  return {
    reason: 'mismatch',
    summary: `存在实际差异 len=${detail.existingLen}/${detail.incomingLen} diff@${detail.firstDiffOffset}`,
    detail,
  }
}

function logWidgetSkip(scope: string, tabTitle: string, info: ReturnType<typeof describeWidgetSkip>): void {
  try {
    console.info(`[widget-skip:${scope}]`, { tab: tabTitle, reason: info.reason, ...info.detail })
  } catch {
    // Best-effort diagnostics must never block widget updates.
  }
}

function collectMermaidBlocks(content: string): string[] {
  MERMAID_FENCE_REGEX.lastIndex = 0
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = MERMAID_FENCE_REGEX.exec(content)) !== null) {
    const code = String(match[1] || '').trim()
    if (code) blocks.push(code)
  }
  return blocks
}

function mermaidSvgContainsSourceLeak(svg: string): boolean {
  return /(?:%%|--&gt;|-->|-\.-&gt;|---\|?|graph\s+(?:TD|TB|BT|LR|RL)|flowchart\s+(?:TD|TB|BT|LR|RL))/i.test(svg)
}

async function validateMermaidPreviewRender(content: string): Promise<string | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const blocks = collectMermaidBlocks(content)
  if (blocks.length === 0) return null
  try {
    const module = await import('mermaid')
    const mermaid = module.default
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
    })
    for (let index = 0; index < blocks.length; index += 1) {
      const renderId = `ready-doc-tool-mermaid-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
      const result = await raceWithTimeout(
        mermaid.render(renderId, blocks[index]),
        3_000,
        'mermaid_validate',
      )
      if (mermaidSvgContainsSourceLeak(result.svg)) {
        return '目标文档里的 Mermaid 预览结果仍包含源码痕迹'
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `目标文档里的 Mermaid 无法完成真实预览渲染：${message}`
  }
  return null
}

async function buildVisualSyntaxRejection(actionLabel: string, content: string): Promise<string | null> {
  const visualSyntaxIssue = findDocumentVisualSyntaxIssue(content)
  const previewIssue = visualSyntaxIssue || await validateMermaidPreviewRender(content)
  return previewIssue
    ? `${actionLabel}已拒绝：${previewIssue}。请把所有 graph/flowchart 节点和连线放在同一个 \`\`\`mermaid 代码块里；如果真实预览仍不稳定，请改成 Markdown 表格。`
    : null
}

function buildWidgetBoundaryRejection(actionLabel: string): string {
  return `${actionLabel}已拒绝：不能用普通文本替换工具修改 show-widget 代码块内部内容。请改用 document_update_widget。`
}

function findAllReplacementRanges(source: string, target: string): Array<{ start: number; end: number }> {
  if (!target) return []
  const ranges: Array<{ start: number; end: number }> = []
  let searchFrom = 0
  while (searchFrom <= source.length) {
    const nextIndex = source.indexOf(target, searchFrom)
    if (nextIndex < 0) break
    ranges.push({ start: nextIndex, end: nextIndex + target.length })
    searchFrom = nextIndex + Math.max(1, target.length)
  }
  return ranges
}

function buildWidgetBoundaryRejectionForRanges(
  actionLabel: string,
  source: string,
  ranges: Array<{ start: number; end: number }>,
): string | null {
  const issue = findShowWidgetBoundaryViolation(source, ranges)
  return issue ? buildWidgetBoundaryRejection(actionLabel) : null
}

export function classifyDocActionMutationOutcome(
  action: DocActionPayload,
  summary: string,
): DocActionMutationOutcome {
  const type = String(action.type || '').trim()
  const normalized = summary.trim()

  if (type === 'save_tab') {
    if (/保存失败|不支持保存|另存为已取消|当前环境不支持/.test(normalized)) {
      return { mutated: false, mutationReason: 'validation_failed' }
    }
    return {
      mutated: false,
      mutationReason: 'saved',
      documentSaved: /已保存文档|已另存文档|文档未改动，已跳过保存/.test(normalized),
    }
  }

  const mutationActions = new Set([
    'set_content',
    'append_content',
    'insert_widget',
    'update_widget',
    'remove_widget',
    'replace_text',
    'replace_exact',
    'format_section',
    'rewrite_section',
  ])
  if (!mutationActions.has(type)) {
    return { mutated: false, mutationReason: 'not_mutation' }
  }
  if (/不能用普通文本替换工具修改 show-widget/.test(normalized)) {
    return {
      mutated: false,
      mutationReason: 'rejected',
      errorKind: 'widget_boundary_violation',
      recoverable: true,
    }
  }
  if (/Mermaid|show-widget JSON|show-widget SVG|视觉|源码裸露/.test(normalized) && /已拒绝|不能进入完成态|无法解析|没有闭合/.test(normalized)) {
    return {
      mutated: false,
      mutationReason: 'validation_failed',
      errorKind: 'document_visual_syntax_invalid',
      recoverable: true,
    }
  }
  if (/已取消|被取消/.test(normalized)) return { mutated: false, mutationReason: 'cancelled' }
  if (/未匹配到|未找到|没有可|缺少/.test(normalized)) return { mutated: false, mutationReason: 'no_match' }
  if (/内容未变化|无变化|未做改动|已跳过|已是目标格式/.test(normalized)) {
    return { mutated: false, mutationReason: 'identical' }
  }
  if (/已写入|已追加|已插入|已在[^，。]*插入|已更新|已删除|已替换|已精准替换|已优化章节格式|已重写/.test(normalized)) {
    return { mutated: true, mutationReason: 'changed' }
  }
  if (/已拒绝|失败|无法/.test(normalized)) return { mutated: false, mutationReason: 'rejected' }
  return { mutated: false, mutationReason: 'validation_failed' }
}

function extractDeclaredWidgetAspect(widgetCode: string): { width: number; height: number } | null {
  const rootMatch = /<\s*(div|section|svg|article|main)\b([^>]*)>/i.exec(widgetCode)
  if (!rootMatch) return null
  const attrs = rootMatch[2] || ''
  let width: number | null = null
  let height: number | null = null
  const styleMatch = /style\s*=\s*["']([^"']*)["']/i.exec(attrs)
  if (styleMatch) {
    const style = styleMatch[1] || ''
    const w = /(?:^|[;\s])width\s*:\s*(\d+(?:\.\d+)?)\s*px/i.exec(style)
    const h = /(?:^|[;\s])height\s*:\s*(\d+(?:\.\d+)?)\s*px/i.exec(style)
    if (w) width = parseFloat(w[1])
    if (h) height = parseFloat(h[1])
  }
  if (width == null) {
    const m = /\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i.exec(attrs)
    if (m) width = parseFloat(m[1])
  }
  if (height == null) {
    const m = /\bheight\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i.exec(attrs)
    if (m) height = parseFloat(m[1])
  }
  if (width && height && width > 0 && height > 0) return { width, height }
  return null
}

function assertAspectPreserved(
  existingCode: string,
  incomingCode: string,
): { ok: true } | { ok: false; reason: string } {
  const oldAspect = extractDeclaredWidgetAspect(existingCode)
  const newAspect = extractDeclaredWidgetAspect(incomingCode)
  if (!oldAspect || !newAspect) return { ok: true }
  const oldRatio = oldAspect.width / oldAspect.height
  const newRatio = newAspect.width / newAspect.height
  const drift = Math.abs(oldRatio - newRatio) / oldRatio
  if (drift <= 0.05) return { ok: true }
  const flipped = (oldRatio > 1) !== (newRatio > 1)
  return {
    ok: false,
    reason: `widget 根元素声明尺寸从 ${oldAspect.width}×${oldAspect.height}（ratio=${oldRatio.toFixed(3)}）变为 ${newAspect.width}×${newAspect.height}（ratio=${newRatio.toFixed(3)}）${flipped ? '，纵横翻转' : ''}，偏差 ${(drift * 100).toFixed(1)}% 超过 5%。请保持原 widget 的宽高与纵横比。`,
  }
}

export interface CommandResult {
  handled: boolean
  text: string
  isError?: boolean
}

function normalizeComponentSpecForFence(spec: unknown): DocumentWidgetComponentSpecSummary | undefined {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return undefined
  const record = spec as Record<string, unknown>
  const component = typeof record.component === 'string' ? record.component.trim() : ''
  if (!component) return undefined
  const summary: DocumentWidgetComponentSpecSummary = { component }
  if (record.props && typeof record.props === 'object' && !Array.isArray(record.props)) {
    summary.props = record.props as Record<string, unknown>
  }
  if (record.dataSource && typeof record.dataSource === 'object' && !Array.isArray(record.dataSource)) {
    summary.dataSource = record.dataSource as Record<string, unknown>
  }
  return summary
}

async function resolveWidgetCodeInput(
  widgetCode: string,
  componentSpec: unknown,
): Promise<{
  widgetCode: string
  componentName?: string
  componentSpec?: DocumentWidgetComponentSpecSummary
} | { error: string }> {
  const normalizedWidgetCode = widgetCode.trim()
  if (normalizedWidgetCode) {
    return {
      widgetCode: normalizedWidgetCode,
      componentSpec: normalizeComponentSpecForFence(componentSpec),
    }
  }

  if (!componentSpec || typeof componentSpec !== 'object') {
    return { error: '缺少 widgetCode 或 componentSpec' }
  }

  try {
    const compiled = await raceWithTimeout(
      compileDocumentWidgetComponentSpec(componentSpec as DocumentWidgetComponentSpec),
      10_000,
      'compile_widget_spec',
    )
    return {
      widgetCode: compiled.widgetCode,
      componentName: compiled.component,
      componentSpec: normalizeComponentSpecForFence(componentSpec),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
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

function resolveDocActionTab(action: DocActionPayload): ReturnType<typeof getActiveDocTab> {
  const explicitTabId = typeof action.tabId === 'string' ? action.tabId : ''
  if (explicitTabId.trim()) return resolveDocTab(explicitTabId)

  if (recentToolTargetTab && Date.now() - recentToolTargetTab.updatedAt <= RECENT_TOOL_TARGET_TTL_MS) {
    const store = useDocTabs.getState()
    const target = store.tabs.find((tab) => tab.id === recentToolTargetTab?.tabId)
    if (target) return target
    recentToolTargetTab = null
  }

  return getActiveDocTab()
}

function normalizeText(input: string): string {
  return input.replace(/\\n/g, '\n').trim()
}

function normalizeSectionKey(value: string): string {
  const punctuationPattern = new RegExp("[`*_~#>:：,.，。!?！？;；、()\\[\\]{}'\"“”‘’\\s]+", 'g')
  return value
    .toLowerCase()
    .replace(punctuationPattern, '')
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
  if (!/^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[.、]))\s+/.test(nextLine)) {
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

  const numericHeading = line.match(/^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[.、]))\s+(.+)$/)
  if (numericHeading && line.length <= 100) {
    const numericCore = numericHeading[1].replace(/[、.]$/, '')
    const depth = numericCore.split('.').filter(Boolean).length
    return {
      level: Math.min(6, depth + 1),
      title: `${numericCore} ${numericHeading[2].trim()}`.trim(),
    }
  }

  const chineseOrdinalHeading = line.match(/^(?:([一二三四五六七八九十百千]+)[、.．]\s*(.+)|[（(]([一二三四五六七八九十百千]+)[）)]\s*(.+))$/)
  if (chineseOrdinalHeading && line.length <= 100) {
    const ordinal = chineseOrdinalHeading[1] || chineseOrdinalHeading[3] || ''
    const body = chineseOrdinalHeading[2] || chineseOrdinalHeading[4] || ''
    return {
      level: 2,
      title: `${ordinal} ${body.trim()}`.trim(),
    }
  }

  const plainHeading = line.match(/^(第[一二三四五六七八九十百千万0-9]+(?:部分|章|节)|引言|序言|前言|摘要|结语|结论|附录)\s*([：:]\s*.+)?$/)
  if (!plainHeading || line.length > 80) return null

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

  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
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
  if (ordinal < 1 || sectionAnchors.length === 0) return null
  const minLevel = Math.min(...sectionAnchors.map((item) => item.level))
  const topLevelAnchors = sectionAnchors.filter((item) => item.level === minLevel)
  return topLevelAnchors[ordinal - 1] || null
}

function findSectionAnchor(sectionAnchors: SectionAnchor[], sectionTitle: string): SectionAnchor | null {
  const targetKey = normalizeSectionKey(sectionTitle)
  if (!targetKey) return null
  const exact = sectionAnchors.find((item) => item.key === targetKey)
  if (exact) return exact
  const fuzzy = sectionAnchors.find((item) => item.key.includes(targetKey) || targetKey.includes(item.key)) || null
  if (fuzzy) return fuzzy
  const ordinal = extractSectionOrdinal(sectionTitle)
  return ordinal ? pickOrdinalAnchor(sectionAnchors, ordinal) : null
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
    if (!options?.appendIfMissing) return { content: normalizedSource, found: false }
    const body = nextSectionBody.replace(/\r\n/g, '\n').trim()
    const appended = [
      normalizedSource.trimEnd(),
      normalizedSource.trim().length > 0 ? '' : null,
      `## ${sectionTitle.trim() || '新章节'}`,
      body,
      '',
    ].filter((item): item is string => item !== null).join('\n')
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

interface WidgetFenceOptions {
  id?: string
  componentSpec?: DocumentWidgetComponentSpecSummary
  widgetState?: object | null
}

function buildShowWidgetFence(title: string, widgetCode: string, opts?: WidgetFenceOptions): string {
  return buildDocumentWidgetFenceSource(title, widgetCode, {
    id: opts?.id,
    componentSpec: opts?.componentSpec,
    widgetState: opts?.widgetState ?? null,
  })
}

function validateWidgetCode(widgetCode: string): { valid: boolean; reason?: string } {
  const normalized = widgetCode.trim()
  if (!normalized) {
    return { valid: false, reason: 'widget 内容为空' }
  }

  if (/<svg\b/i.test(normalized)) {
    const textCount = (normalized.match(/<text\b/gi) || []).length
    const scriptCount = (normalized.match(/<script\b/gi) || []).length
    const shapeCount = (normalized.match(/<(rect|circle|ellipse|line|polyline|polygon|path|image|foreignObject|use)\b/gi) || []).length

    if (textCount === 0 && scriptCount === 0 && shapeCount <= 1) {
      return {
        valid: false,
        reason: 'SVG 看起来只有背景壳，没有实际文本、图形内容或交互逻辑',
      }
    }
  }

  return { valid: true }
}

function normalizeWidgetTitleKey(title: string): string {
  return title.trim().toLowerCase()
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
}

function resolveWidgetRecord(
  widgets: DocumentWidgetRecord[],
  target: string,
  occurrence?: number,
): { widget: DocumentWidgetRecord | null; error?: string } {
  if (widgets.length === 0) {
    return { widget: null, error: '当前文档中没有 widget' }
  }

  const trimmed = target.trim()
  if (!trimmed) {
    return { widget: null, error: '缺少 widget 目标' }
  }

  const numeric = Number(trimmed)
  if (Number.isInteger(numeric) && numeric >= 1) {
    const byIndex = widgets[numeric - 1]
    return byIndex ? { widget: byIndex } : { widget: null, error: `未找到序号为 ${numeric} 的 widget` }
  }

  const byId = widgets.find((widget) => widget.id === trimmed)
  if (byId) {
    return { widget: byId }
  }

  const normalizedTarget = normalizeWidgetTitleKey(trimmed)
  const exactMatches = widgets.filter((widget) => normalizeWidgetTitleKey(widget.title) === normalizedTarget)
  const fuzzyMatches = exactMatches.length > 0
    ? exactMatches
    : widgets.filter((widget) => {
        const titleKey = normalizeWidgetTitleKey(widget.title)
        return titleKey.includes(normalizedTarget) || normalizedTarget.includes(titleKey)
      })

  if (fuzzyMatches.length === 0) {
    return { widget: null, error: `未找到标题匹配“${trimmed}”的 widget` }
  }

  if (fuzzyMatches.length === 1 && occurrence == null) {
    return { widget: fuzzyMatches[0] }
  }

  const pickedOccurrence = occurrence == null ? 1 : Math.trunc(occurrence)
  if (!Number.isFinite(pickedOccurrence) || pickedOccurrence < 1) {
    return { widget: null, error: `occurrence=${String(occurrence)} 无效，请提供从 1 开始的整数` }
  }
  const selected = fuzzyMatches[pickedOccurrence - 1]
  if (!selected) {
    return {
      widget: null,
      error: `标题“${trimmed}”共匹配到 ${fuzzyMatches.length} 个 widget，请使用更精确标题或正确的 occurrence`,
    }
  }
  return { widget: selected }
}

function updateWidgetInDocument(
  source: string,
  target: string,
  widgetCode: string,
  title?: string,
  occurrence?: number,
  componentSpec?: DocumentWidgetComponentSpecSummary,
): { content: string; found: boolean; widget?: DocumentWidgetRecord; error?: string } {
  const validation = validateWidgetCode(widgetCode)
  if (!validation.valid) {
    return { content: source, found: false, error: validation.reason }
  }

  const widgets = collectDocumentWidgets(source)
  const resolved = resolveWidgetRecord(widgets, target, occurrence)
  if (!resolved.widget) {
    return { content: source, found: false, error: resolved.error }
  }

  const aspectCheck = assertAspectPreserved(resolved.widget.widgetCode, widgetCode)
  if (!aspectCheck.ok) {
    return {
      content: source,
      found: false,
      widget: resolved.widget,
      error: `widget 更新已拒绝：${aspectCheck.reason}`,
    }
  }

  const nextTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : resolved.widget.title
  const nextComponentSpec = componentSpec ?? resolved.widget.componentSpec ?? undefined
  const replacementFence = buildShowWidgetFence(nextTitle, widgetCode, {
    id: resolved.widget.id,
    componentSpec: nextComponentSpec || undefined,
    widgetState: resolved.widget.widgetState ?? undefined,
  })
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const nextContent = `${normalizedSource.slice(0, resolved.widget.start)}${replacementFence}${normalizedSource.slice(resolved.widget.end)}`
  return {
    content: ensureTrailingNewline(nextContent.replace(/\n{3,}/g, '\n\n').trimEnd()),
    found: true,
    widget: resolved.widget,
  }
}

function removeWidgetFromDocument(
  source: string,
  target: string,
  occurrence?: number,
): { content: string; found: boolean; widget?: DocumentWidgetRecord; error?: string } {
  const widgets = collectDocumentWidgets(source)
  const resolved = resolveWidgetRecord(widgets, target, occurrence)
  if (!resolved.widget) {
    return { content: source, found: false, error: resolved.error }
  }

  const normalizedSource = source.replace(/\r\n/g, '\n')
  const nextContent = `${normalizedSource.slice(0, resolved.widget.start)}${normalizedSource.slice(resolved.widget.end)}`
  return {
    content: ensureTrailingNewline(nextContent.replace(/\n{3,}/g, '\n\n').trim()),
    found: true,
    widget: resolved.widget,
  }
}

function upsertWidgetFenceByTitle(
  source: string,
  title: string,
  widgetCode: string,
  componentSpec?: DocumentWidgetComponentSpecSummary,
): { content: string; replaced: boolean; removedDuplicates: number } | null {
  const normalizedTitle = normalizeWidgetTitleKey(title)
  if (!normalizedTitle) return null

  const normalizedSource = source.replace(/\r\n/g, '\n')
  const regex = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g
  const chunks: string[] = []
  let cursor = 0
  let matchedCount = 0

  for (const match of normalizedSource.matchAll(regex)) {
    const fullMatch = match[0]
    const body = match[1] || ''
    const start = match.index ?? 0
    const parsed = tryParseWidgetPayload(body, fullMatch)
    const sameTitle = parsed?.title && normalizeWidgetTitleKey(parsed.title) === normalizedTitle

    chunks.push(normalizedSource.slice(cursor, start))
    if (sameTitle) {
      matchedCount += 1
      if (matchedCount === 1) {
        const fence = buildShowWidgetFence(title, widgetCode, {
          id: parsed?.id,
          componentSpec: componentSpec ?? parsed?.componentSpec ?? undefined,
          widgetState: parsed?.widgetState ?? undefined,
        })
        chunks.push(fence)
      }
    } else {
      chunks.push(fullMatch)
    }
    cursor = start + fullMatch.length
  }

  if (matchedCount === 0) return null

  chunks.push(normalizedSource.slice(cursor))
  const compacted = chunks.join('').replace(/\n{3,}/g, '\n\n').trimEnd()
  return {
    content: ensureTrailingNewline(compacted),
    replaced: true,
    removedDuplicates: Math.max(0, matchedCount - 1),
  }
}

function extractStandaloneWidgets(content: string): Array<{ title?: string; widgetCode: string }> | null {
  const segments = parseShowWidgetFences(content.replace(/\r\n/g, '\n'))
  const widgets: Array<{ title?: string; widgetCode: string }> = []

  for (const segment of segments) {
    if (segment.type === 'widget') {
      widgets.push({
        title: segment.data.title,
        widgetCode: segment.data.widgetCode,
      })
      continue
    }
    if (segment.content.trim().length > 0) {
      return null
    }
  }

  return widgets.length > 0 ? widgets : null
}

function mergeStandaloneWidgetsIntoDocument(
  source: string,
  incomingContent: string,
): { content: string; inserted: number; updated: number; removedDuplicates: number; error?: string } | null {
  const widgets = extractStandaloneWidgets(incomingContent)
  if (!widgets) return null

  let nextContent = source.replace(/\r\n/g, '\n')
  let inserted = 0
  let updated = 0
  let removedDuplicates = 0

  widgets.forEach((widget, index) => {
    if (inserted < 0) return
    const validation = validateWidgetCode(widget.widgetCode)
    if (!validation.valid) {
      inserted = -1
      updated = 0
      removedDuplicates = 0
      nextContent = source.replace(/\r\n/g, '\n')
      return
    }
    const fallbackTitle = widget.title?.trim() || `widget_${index + 1}`
    const upserted = widget.title ? upsertWidgetFenceByTitle(nextContent, widget.title, widget.widgetCode) : null
    if (upserted) {
      nextContent = upserted.content
      updated += 1
      removedDuplicates += upserted.removedDuplicates
      return
    }

    const appended = insertWidgetIntoDocument(nextContent, fallbackTitle, widget.widgetCode, 'append_end')
    nextContent = appended.content
    inserted += 1
  })

  if (inserted < 0) {
    const invalidWidget = widgets.find((widget) => !validateWidgetCode(widget.widgetCode).valid)
    return {
      content: source.replace(/\r\n/g, '\n'),
      inserted: 0,
      updated: 0,
      removedDuplicates: 0,
      error: validateWidgetCode(invalidWidget?.widgetCode || '').reason || 'widget 内容不完整',
    }
  }

  return {
    content: nextContent,
    inserted,
    updated,
    removedDuplicates,
  }
}

function normalizePotentialWidgetPayloadContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized || normalized.includes('```show-widget')) return content

  const parts = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return content

  const fences = parts.map((part) => {
    const widget = part.startsWith('{') && part.endsWith('}')
      ? tryParseWidgetPayload(part, part)
      : null
    if (!widget) return null
    return buildShowWidgetFence(widget.title || `widget_${Math.random().toString(36).slice(2, 8)}`, widget.widgetCode, {
      id: widget.id,
      componentSpec: widget.componentSpec ?? undefined,
      widgetState: widget.widgetState,
    })
  })

  if (fences.every(Boolean)) {
    return `${fences.join('\n\n')}\n`
  }

  return content
}

function insertWidgetIntoDocument(
  source: string,
  title: string,
  widgetCode: string,
  position: 'append_end' | 'after_section',
  sectionTitle?: string,
  componentSpec?: DocumentWidgetComponentSpecSummary,
): { content: string; inserted: boolean; updatedExisting?: boolean; matchedTitle?: string; error?: string; removedDuplicates?: number } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const upserted = upsertWidgetFenceByTitle(normalizedSource, title, widgetCode, componentSpec)
  if (upserted) {
    return {
      content: upserted.content,
      inserted: true,
      updatedExisting: true,
      removedDuplicates: upserted.removedDuplicates,
    }
  }
  const fence = buildShowWidgetFence(title, widgetCode, { componentSpec })

  if (position === 'append_end') {
    const prefix = normalizedSource.trim().length > 0 ? `${normalizedSource.trimEnd()}\n\n` : ''
    return {
      content: `${prefix}${fence}\n`,
      inserted: true,
    }
  }

  if (!sectionTitle?.trim()) {
    return { content: normalizedSource, inserted: false, error: 'after_section 模式缺少 sectionTitle' }
  }

  const lines = normalizedSource.split('\n')
  const anchors = collectSectionAnchors(lines)
  const anchor = findSectionAnchor(anchors, sectionTitle)
  if (!anchor) {
    return { content: normalizedSource, inserted: false, error: `未找到章节“${sectionTitle}”` }
  }

  const sectionEndLine = getSectionEndLine(anchors, anchor, lines.length)
  const nextLines = [
    ...lines.slice(0, sectionEndLine),
    '',
    fence,
    '',
    ...lines.slice(sectionEndLine),
  ]

  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    inserted: true,
    matchedTitle: anchor.title,
  }
}

export function replaceExactTextInDocument(
  source: string,
  target: string,
  replacement: string,
  occurrence?: number,
): { content: string; found: boolean; totalMatches: number; occurrenceUsed?: number; range?: { start: number; end: number }; error?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const normalizedTarget = target.replace(/\r\n/g, '\n')
  const normalizedReplacement = replacement.replace(/\r\n/g, '\n')

  if (!normalizedTarget) {
    return { content: normalizedSource, found: false, totalMatches: 0, error: '精准替换缺少 target' }
  }

  const matchIndexes: number[] = []
  let searchFrom = 0
  while (searchFrom <= normalizedSource.length) {
    const nextIndex = normalizedSource.indexOf(normalizedTarget, searchFrom)
    if (nextIndex < 0) break
    matchIndexes.push(nextIndex)
    searchFrom = nextIndex + normalizedTarget.length
  }

  if (matchIndexes.length === 0) {
    return { content: normalizedSource, found: false, totalMatches: 0, error: '未匹配到目标片段' }
  }

  const targetOccurrence = occurrence == null
    ? (matchIndexes.length === 1 ? 1 : null)
    : Math.trunc(occurrence)

  if (targetOccurrence == null || !Number.isFinite(targetOccurrence) || targetOccurrence < 1) {
    return {
      content: normalizedSource,
      found: false,
      totalMatches: matchIndexes.length,
      error: `目标片段共匹配到 ${matchIndexes.length} 处，请提供 occurrence 指定替换位置`,
    }
  }

  const targetIndex = matchIndexes[targetOccurrence - 1]
  if (targetIndex == null) {
    return {
      content: normalizedSource,
      found: false,
      totalMatches: matchIndexes.length,
      error: `occurrence=${targetOccurrence} 超出范围，当前仅匹配到 ${matchIndexes.length} 处`,
    }
  }

  const content = `${normalizedSource.slice(0, targetIndex)}${normalizedReplacement}${normalizedSource.slice(targetIndex + normalizedTarget.length)}`
  return {
    content,
    found: true,
    totalMatches: matchIndexes.length,
    occurrenceUsed: targetOccurrence,
    range: {
      start: targetIndex,
      end: targetIndex + normalizedTarget.length,
    },
  }
}

function formatParagraphIntoReadableChunks(paragraph: string): string {
  const cleaned = paragraph.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (cleaned.length < 130 || !/[。！？；!?;]/.test(cleaned)) return cleaned
  const chunks = cleaned.split(/(?<=[。！？；!?;])\s*/g).map((item) => item.trim()).filter(Boolean)
  return chunks.length <= 1 ? cleaned : chunks.join('\n')
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

function formatSectionInDocument(source: string, sectionTitle: string): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const target = findSectionAnchor(sectionAnchors, sectionTitle)
  if (!target) return { content: normalizedSource, found: false }

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

const TEXT_SAVE_BLOCKED_EXTENSIONS = new Set(['doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf'])

function getPathExtension(path: string | null | undefined): string {
  if (!path) return ''
  const file = path.split('/').pop() || ''
  const dot = file.lastIndexOf('.')
  return dot >= 0 ? file.slice(dot + 1).toLowerCase() : ''
}

function getDirectSaveBlockReason(path: string | null | undefined): string | null {
  const ext = getPathExtension(path)
  if (!ext || !TEXT_SAVE_BLOCKED_EXTENSIONS.has(ext)) return null
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
      if (!result.success) return { success: false, content: '', error: result.error || '文件读取失败' }
      return { success: true, content: result.content || '' }
    }

    if (ext === 'docx') {
      const result = await window.electronAPI.document.parseDocx(path)
      if (!result.success) return { success: false, content: '', error: result.error || 'DOCX 解析失败' }
      const rawText = typeof result.data?.rawText === 'string' ? result.data.rawText : ''
      const html = typeof result.data?.html === 'string'
        ? result.data.html
        : typeof result.html === 'string'
          ? result.html
          : ''
      const markdownish = convertDocxHtmlToMarkdownText(html, rawText || result.content || result.html || '')
      return { success: true, content: markdownish }
    }

    return { success: true, content: `# 暂不支持该格式\n\n文件: ${path}` }
  } catch (error) {
    return { success: false, content: '', error: error instanceof Error ? error.message : String(error) }
  }
}

function sanitizeAutosaveName(title: string): string {
  const cleaned = String(title || '新文档')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || '新文档'
}

function getHarnessAutosavePath(title: string): string | null {
  if (typeof window === 'undefined') return null
  const harnessEnabled = Boolean((window as unknown as { __READY_AGENT_TEST__?: unknown }).__READY_AGENT_TEST__)
    || window.localStorage?.getItem('ready.agentPanelTest') === '1'
    || window.localStorage?.getItem('ready:agent:test') === '1'
  if (!harnessEnabled) return null
  const root = String(window.localStorage?.getItem('ready-workspace-root') || '').trim()
  if (!root || !root.startsWith('/')) return null
  return `${root.replace(/\/+$/, '')}/${sanitizeAutosaveName(title)}-${Date.now()}.md`
}

async function saveTabWithDialog(tabId: string, title: string, content: string, existingPath?: string | null): Promise<{
  success: boolean
  path?: string
  error?: string
}> {
  if (typeof window === 'undefined') {
    return { success: false, error: '当前环境不支持另存为' }
  }

  const harnessAutosavePath = existingPath ? null : getHarnessAutosavePath(title)
  if (harnessAutosavePath && window.electronAPI?.document?.writeFile) {
    const result = await window.electronAPI.document.writeFile(harnessAutosavePath, content)
    if (!result.success) return { success: false, error: result.error || '测试模式自动保存失败' }
    const docStore = useDocTabs.getState()
    docStore.setTabPath(tabId, harnessAutosavePath)
    docStore.renameTab(tabId, harnessAutosavePath.split('/').pop() || title || '新文档')
    docStore.markTabSaved(tabId)
    return { success: true, path: harnessAutosavePath }
  }

  if (!window.electronAPI?.document?.saveFileAs) {
    return { success: false, error: '当前环境不支持另存为' }
  }

  const result = await window.electronAPI.document.saveFileAs({
    content,
    suggestedName: `${title || '新文档'}.md`,
    defaultPath: existingPath || null,
  })

  if (!result.success || !result.path) {
    return { success: false, error: result.error || '另存为已取消' }
  }

  const docStore = useDocTabs.getState()
  docStore.setTabPath(tabId, result.path)
  docStore.renameTab(tabId, result.path.split('/').pop() || title || '新文档')
  docStore.markTabSaved(tabId)
  return { success: true, path: result.path }
}

export function buildActiveDocumentContext(): string | null {
  const mode = useMode.getState().workbenchMode
  if (mode !== 'document') return null

  const docStore = useDocTabs.getState()
  const activeTab = docStore.tabs.find((tab) => tab.id === docStore.activeTabId)
  if (!activeTab) return null

  const ext = activeTab.path?.split('.').pop()?.toLowerCase() || 'untitled'
  const raw = activeTab.content || ''
  const clipped = raw.slice(0, 1_200)
  const truncated = raw.length > 1_200

  const lines = [
    '### 当前文档上下文',
    `- 标题: ${activeTab.title}`,
    `- 路径: ${activeTab.path || '(未保存草稿)'}`,
    `- 类型: ${ext}`,
    `- 字符数: ${raw.length}`,
    '',
    '--- 文档摘要开始 ---',
    clipped,
    truncated ? '...[文档摘要已截断]' : null,
    '--- 文档摘要结束 ---',
  ].filter(Boolean)

  return lines.join('\n')
}

export interface ActiveDocumentSnapshot {
  tabId: string
  title: string
  path: string | null
  content: string
  isDirty: boolean
  charCount: number
}

export function getActiveDocumentSnapshot(tabId?: string): ActiveDocumentSnapshot | null {
  const mode = useMode.getState().workbenchMode
  if (mode !== 'document') return null

  const docStore = useDocTabs.getState()
  const activeTab = typeof tabId === 'string' && tabId.trim().length > 0
    ? docStore.tabs.find((tab) => tab.id === tabId.trim())
    : docStore.tabs.find((tab) => tab.id === docStore.activeTabId)
  if (!activeTab) return null

  const content = activeTab.content || ''
  return {
    tabId: activeTab.id,
    title: activeTab.title,
    path: activeTab.path || null,
    content,
    isDirty: Boolean(activeTab.isDirty),
    charCount: content.length,
  }
}

export async function performDocAction(action: DocActionPayload): Promise<string> {
  const docStore = useDocTabs.getState()

  const type = String(action.type || '').trim()
  if (!type) return '文档动作缺少 type 字段'

  if (type === 'new_tab') {
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    const path = typeof action.path === 'string' ? action.path.trim() : ''
    const createdId = path
      ? docStore.ensureTabForPath(path)
      : docStore.createBackgroundTab({ title })
    if (!createdId) return '创建文档标签失败'
    if (title && !path) docStore.renameTab(createdId, title)
    rememberToolTargetTab(createdId)
    const created = useDocTabs.getState().tabs.find((tab) => tab.id === createdId)
    return `已创建文档标签：${created?.title || title || '新文档'}${path ? `（${path}）` : ''}`
  }

  if (type === 'open_tab') {
    const path = typeof action.path === 'string' ? action.path.trim() : ''
    if (!path) return 'open_tab 缺少 path'
    const openedId = docStore.ensureTabForPath(path)
    if (!openedId) return `已打开文档：${path}`
    rememberToolTargetTab(openedId)
    const currentStore = useDocTabs.getState()
    const opened = currentStore.tabs.find((tab) => tab.id === openedId)
    if (!opened) return `已打开文档：${path}`

    let loaded: Awaited<ReturnType<typeof loadDocumentContentForEditing>>
    try {
      loaded = await raceWithTimeout(loadDocumentContentForEditing(path), 10_000, 'open_tab.load')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `已打开文档：${path}（读取超时或失败：${reason}）`
    }
    if (!loaded.success) return `已打开文档：${path}（读取失败：${loaded.error || '未知错误'}）`

    currentStore.updateTabContent(opened.id, loaded.content)
    currentStore.markTabSaved(opened.id)
    clearPendingToolDocumentWrite(opened.id)
    return `已打开并载入文档：${path}（${loaded.content.length} 字）`
  }

  if (type === 'switch_tab') {
    const target = typeof action.target === 'string' ? action.target : typeof action.tabId === 'string' ? action.tabId : undefined
    const tab = resolveDocTab(target)
    if (!tab) return `未找到文档标签：${target || '(空)'}`
    useMode.getState().setWorkbenchMode('document')
    docStore.setActiveTab(tab.id)
    rememberToolTargetTab(tab.id)
    return `已切换到文档：${tab.title}`
  }

  if (type === 'rename_tab') {
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    if (!title) return 'rename_tab 缺少 title'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可重命名的文档标签'
    docStore.renameTab(tab.id, title)
    return `已重命名标签：${title}`
  }

  if (type === 'set_content') {
    const content = typeof action.content === 'string' ? normalizePotentialWidgetPayloadContent(action.content) : ''
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可写入的文档标签'
    const visualSyntaxRejection = await buildVisualSyntaxRejection('文档写入', content)
    if (visualSyntaxRejection) return visualSyntaxRejection
    if (tab.content === content) return `内容未变化，已跳过写入：${tab.title}`
    docStore.setTabContent(tab.id, content)
    rememberPendingToolDocumentWrite(tab.id, content, 'set_content', tab.content)
    return `已写入内容到：${tab.title}`
  }

  if (type === 'append_content') {
    const content = typeof action.content === 'string' ? normalizePotentialWidgetPayloadContent(action.content) : ''
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可追加的文档标签'
    if (!content) return `追加内容为空，已跳过：${tab.title}`
    const visualSyntaxRejection = await buildVisualSyntaxRejection('文档追加', content)
    if (visualSyntaxRejection) return visualSyntaxRejection
    const mergedWidgets = mergeStandaloneWidgetsIntoDocument(tab.content, content)
    if (mergedWidgets) {
      if (mergedWidgets.error) return `widget 写入已拒绝：${mergedWidgets.error}`
      if (mergedWidgets.content === tab.content) return `widget 内容未变化，已跳过：${tab.title}`
      docStore.setTabContent(tab.id, mergedWidgets.content)
      rememberPendingToolDocumentWrite(tab.id, mergedWidgets.content, 'append_content', tab.content)
      if (mergedWidgets.updated > 0) {
        return `已更新 ${mergedWidgets.updated} 个 widget 到：${tab.title}${mergedWidgets.removedDuplicates > 0 ? `（已清理 ${mergedWidgets.removedDuplicates} 个重复块）` : ''}`
      }
      return `已追加 ${mergedWidgets.inserted} 个 widget 到：${tab.title}`
    }
    const nextContent = `${tab.content}${content}`
    docStore.setTabContent(tab.id, nextContent)
    rememberPendingToolDocumentWrite(tab.id, nextContent, 'append_content', tab.content)
    return `已追加内容到：${tab.title}`
  }

  if (type === 'insert_widget') {
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    const widgetCode = typeof action.widgetCode === 'string' ? action.widgetCode : ''
    const position = action.position === 'after_section' ? 'after_section' : 'append_end'
    const sectionTitle = typeof action.sectionTitle === 'string' ? action.sectionTitle.trim() : ''
    if (!title) return 'insert_widget 缺少 title'
    let resolvedWidget: Awaited<ReturnType<typeof resolveWidgetCodeInput>>
    try {
      resolvedWidget = await raceWithTimeout(
        resolveWidgetCodeInput(widgetCode, action.componentSpec),
        10_000,
        'insert_widget.compile',
      )
    } catch (error) {
      return `widget 写入已拒绝：${error instanceof Error ? error.message : String(error)}`
    }
    if ('error' in resolvedWidget) return `widget 写入已拒绝：${resolvedWidget.error}`
    const widgetValidation = validateWidgetCode(resolvedWidget.widgetCode)
    if (!widgetValidation.valid) return `widget 写入已拒绝：${widgetValidation.reason}`
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可插入 widget 的文档标签'
    const inserted = insertWidgetIntoDocument(tab.content, title, resolvedWidget.widgetCode, position, sectionTitle, resolvedWidget.componentSpec)
    if (!inserted.inserted) return inserted.error || 'widget 插入失败'
    if (normalizeContentForCompare(inserted.content) === normalizeContentForCompare(tab.content)) {
      const skip = describeWidgetSkip(tab.content, inserted.content)
      logWidgetSkip('insert_widget', tab.title, skip)
      return `widget 内容未变化，已跳过：${tab.title}（${skip.summary}）`
    }
    docStore.setTabContent(tab.id, inserted.content)
    rememberPendingToolDocumentWrite(tab.id, inserted.content, 'insert_widget', tab.content)
    if (inserted.updatedExisting) {
      return `已更新同标题 widget（${tab.title}）${inserted.removedDuplicates ? `，并清理 ${inserted.removedDuplicates} 个重复块` : ''}`
    }
    return position === 'after_section'
      ? `已在章节“${inserted.matchedTitle || sectionTitle}”后插入 widget（${tab.title}）`
      : `已在文档尾部插入 widget（${tab.title}）`
  }

  if (type === 'list_widgets') {
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可读取 widget 的文档标签'
    const widgets = collectDocumentWidgets(tab.content)
    if (widgets.length === 0) return `当前文档没有 widget（${tab.title}）`
    const summaries = widgets.map(summarizeWidgetRecord)
    // Contract: the ```json fence below is consumed by
    // src/shared/document-widget-parse.ts#parseListWidgetsToolOutput — keep the
    // fence intact (```json … ```) and the JSON as an array of DocumentWidgetSummary
    // when modifying output shape.
    return [
      `当前文档共有 ${widgets.length} 个 widget（${tab.title}）：`,
      ...summaries.map((item) => {
        const hint = item.componentHint ? ` · ${item.componentHint}` : ''
        const state = item.hasState ? ' · 带状态' : ''
        const patch = item.canPatch ? ' · 可 patch' : ' · 仅整卡替换'
        return `${item.index}. ${item.title} [${item.mode}] · id=${item.id}${hint}${state}${patch}${item.preview ? ` · ${item.preview}` : ''}`
      }),
      '',
      '```json',
      JSON.stringify(summaries),
      '```',
    ].join('\n')
  }

  if (type === 'update_widget') {
    const target = typeof action.target === 'string' ? action.target.trim() : ''
    const widgetCode = typeof action.widgetCode === 'string' ? action.widgetCode : ''
    const nextTitle = typeof action.title === 'string' ? action.title.trim() : ''
    const occurrence = typeof action.occurrence === 'number' ? action.occurrence : undefined
    if (!target) return 'update_widget 缺少 target'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可更新 widget 的文档标签'

    const tabId = tab.id
    const startEpoch = widgetWriteEpoch.get(tabId) || 0
    const runUpdate = async (): Promise<string> => {
      if ((widgetWriteEpoch.get(tabId) || 0) !== startEpoch) {
        return `update_widget 已取消：对标签 ${tabId} 的待写入请求已被更高优先级的抢占取消`
      }
      const liveTab = resolveDocActionTab(action)
      if (!liveTab || liveTab.id !== tabId) {
        return `update_widget 已取消：目标文档标签已切换（expected=${tabId}）`
      }
      const liveContent = liveTab.content
      const patchCandidate = action.componentSpecPatch && typeof action.componentSpecPatch === 'object' && !Array.isArray(action.componentSpecPatch)
        ? action.componentSpecPatch as Record<string, unknown>
        : null
      const shouldApplyPatch = Boolean(
        patchCandidate && Object.keys(patchCandidate).length > 0 && !widgetCode.trim() && !action.componentSpec,
      )
      if (shouldApplyPatch) {
        const widgetRecords = collectDocumentWidgets(liveContent)
        const resolveResult = resolveWidgetRecord(widgetRecords, target, occurrence)
        if (!resolveResult.widget) {
          const widgetCount = widgetRecords.length
          const isInternalId = /^widget_[a-z0-9]+$/.test(target)
          if (isInternalId) {
            return widgetCount > 0
              ? `未找到与你选择的卡片对应的 widget（当前文档共有 ${widgetCount} 个 widget），请重新选择卡片或在消息里提供标题。`
              : `当前文档里还没有 widget，请先插入一个再发起修改。`
          }
          if (resolveResult.error) return resolveResult.error
          return widgetCount > 0
            ? `未找到可更新的 widget，请用标题或序号重试（当前文档共有 ${widgetCount} 个 widget）。`
            : `当前文档里还没有 widget，请先插入一个再发起修改。`
        }
        const record = resolveResult.widget
        if (!record.componentSpec) {
          return `widget 更新已拒绝：目标 widget "${record.title}" 不带 component_spec，无法做字段级 patch，请改用完整 componentSpec 或 widgetCode 覆盖。`
        }
        const mergedSpec = mergeComponentSpecPatch(record.componentSpec, patchCandidate!)
        try {
          const compiled = await raceWithTimeout(
            compileDocumentWidgetComponentSpec(mergedSpec as DocumentWidgetComponentSpec),
            10_000,
            'compile_widget_spec',
          )
          const updated = updateWidgetInDocument(
            liveContent,
            record.id,
            compiled.widgetCode,
            nextTitle,
            undefined,
            normalizeComponentSpecForFence(mergedSpec),
          )
          if (!updated.found) return updated.error || 'widget 更新失败'
          if (normalizeContentForCompare(updated.content) === normalizeContentForCompare(liveContent)) {
            const skip = describeWidgetSkip(liveContent, updated.content)
            logWidgetSkip('update_widget_patch', liveTab.title, skip)
            return `widget 内容未变化，已跳过：${liveTab.title}（${skip.summary}）`
          }
          if ((widgetWriteEpoch.get(tabId) || 0) !== startEpoch) {
            return `update_widget 已取消：在写入前被更高优先级的抢占取消`
          }
          docStore.setTabContent(liveTab.id, updated.content)
          rememberPendingToolDocumentWrite(liveTab.id, updated.content, 'update_widget', liveContent)
          emitWidgetCommitted(liveTab.id, updated.widget?.id || record.id)
          return `已更新 widget（字段级 patch）：${nextTitle || updated.widget?.title || target}（${liveTab.title}）`
        } catch (error) {
          return `widget 更新已拒绝：${error instanceof Error ? error.message : String(error)}`
        }
      }

      const resolvedWidget = await resolveWidgetCodeInput(widgetCode, action.componentSpec)
      if ('error' in resolvedWidget) return `widget 写入已拒绝：${resolvedWidget.error}`
      const updated = updateWidgetInDocument(liveContent, target, resolvedWidget.widgetCode, nextTitle, occurrence, resolvedWidget.componentSpec)
      if (!updated.found) return updated.error || 'widget 更新失败'
      if (normalizeContentForCompare(updated.content) === normalizeContentForCompare(liveContent)) {
        const skip = describeWidgetSkip(liveContent, updated.content)
        logWidgetSkip('update_widget', liveTab.title, skip)
        return `widget 内容未变化，已跳过：${liveTab.title}（${skip.summary}）`
      }
      if ((widgetWriteEpoch.get(tabId) || 0) !== startEpoch) {
        return `update_widget 已取消：在写入前被更高优先级的抢占取消`
      }
      docStore.setTabContent(liveTab.id, updated.content)
      rememberPendingToolDocumentWrite(liveTab.id, updated.content, 'update_widget', liveContent)
      emitWidgetCommitted(liveTab.id, updated.widget?.id || target)
      return `已更新 widget：${nextTitle || updated.widget?.title || target}（${liveTab.title}）`
    }

    const prev = widgetWriteLocks.get(tabId) || Promise.resolve()
    const task = prev
      .catch(() => undefined)
      .then(() => raceWithTimeout(runUpdate(), 15_000, 'update_widget'))
    const lockPromise: Promise<void> = task.then(() => undefined, () => undefined)
    widgetWriteLocks.set(tabId, lockPromise)
    try {
      return await task
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      if (widgetWriteLocks.get(tabId) === lockPromise) widgetWriteLocks.delete(tabId)
    }
  }

  if (type === 'remove_widget') {
    const target = typeof action.target === 'string' ? action.target.trim() : ''
    const occurrence = typeof action.occurrence === 'number' ? action.occurrence : undefined
    if (!target) return 'remove_widget 缺少 target'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可删除 widget 的文档标签'
    const removed = removeWidgetFromDocument(tab.content, target, occurrence)
    if (!removed.found) return removed.error || 'widget 删除失败'
    if (normalizeContentForCompare(removed.content) === normalizeContentForCompare(tab.content)) {
      const skip = describeWidgetSkip(tab.content, removed.content)
      logWidgetSkip('remove_widget', tab.title, skip)
      return `widget 内容未变化，已跳过：${tab.title}（${skip.summary}）`
    }
    docStore.setTabContent(tab.id, removed.content)
    rememberPendingToolDocumentWrite(tab.id, removed.content, 'remove_widget', tab.content)
    return `已删除 widget：${removed.widget?.title || target}（${tab.title}）`
  }

  if (type === 'replace_text') {
    const from = typeof action.from === 'string' ? action.from : ''
    const to = typeof action.to === 'string' ? action.to : ''
    if (!from) return 'replace_text 缺少 from'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可替换的文档标签'
    if (!tab.content.includes(from)) return `未匹配到替换目标“${from}”，未做改动`
    const widgetBoundaryRejection = buildWidgetBoundaryRejectionForRanges(
      '文本替换',
      tab.content,
      findAllReplacementRanges(tab.content, from),
    )
    if (widgetBoundaryRejection) return widgetBoundaryRejection
    const nextContent = tab.content.split(from).join(to)
    const visualSyntaxRejection = await buildVisualSyntaxRejection('文本替换', nextContent)
    if (visualSyntaxRejection) return visualSyntaxRejection
    if (nextContent === tab.content) return `替换后内容无变化，已跳过：${tab.title}`
    docStore.setTabContent(tab.id, nextContent)
    rememberPendingToolDocumentWrite(tab.id, nextContent, 'replace_text', tab.content)
    return `已替换文本（${tab.title}）`
  }

  if (type === 'replace_exact') {
    const target = typeof action.target === 'string' ? action.target : ''
    const replacement = typeof action.replacement === 'string' ? action.replacement : ''
    const occurrence = typeof action.occurrence === 'number' ? action.occurrence : undefined
    if (!target) return 'replace_exact 缺少 target'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可精准替换的文档标签'
    const replaced = replaceExactTextInDocument(tab.content, target, replacement, occurrence)
    if (!replaced.found) return replaced.error || '未匹配到目标片段'
    const widgetBoundaryRejection = replaced.range
      ? buildWidgetBoundaryRejectionForRanges('精准替换', tab.content, [replaced.range])
      : null
    if (widgetBoundaryRejection) return widgetBoundaryRejection
    const visualSyntaxRejection = await buildVisualSyntaxRejection('精准替换', replaced.content)
    if (visualSyntaxRejection) return visualSyntaxRejection
    if (replaced.content === tab.content) return `精准替换后内容无变化，已跳过：${tab.title}`
    docStore.setTabContent(tab.id, replaced.content)
    rememberPendingToolDocumentWrite(tab.id, replaced.content, 'replace_exact', tab.content)
    return `已精准替换第 ${replaced.occurrenceUsed || 1} 处目标片段（${tab.title}）`
  }

  if (type === 'format_section') {
    const sectionTitle = typeof action.sectionTitle === 'string' ? action.sectionTitle.trim() : ''
    if (!sectionTitle) return 'format_section 缺少 sectionTitle'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可格式化章节的文档标签'
    const formatted = formatSectionInDocument(tab.content, sectionTitle)
    if (!formatted.found) return `未找到章节“${sectionTitle}”，未做改动`
    if (formatted.content === tab.content) return `章节“${formatted.matchedTitle || sectionTitle}”已是目标格式，未做改动`
    docStore.setTabContent(tab.id, formatted.content)
    rememberPendingToolDocumentWrite(tab.id, formatted.content, 'format_section', tab.content)
    return `已优化章节格式（${formatted.matchedTitle || sectionTitle}）`
  }

  if (type === 'rewrite_section') {
    const sectionTitle = typeof action.sectionTitle === 'string' ? action.sectionTitle.trim() : ''
    const content = typeof action.content === 'string' ? action.content : ''
    if (!sectionTitle) return 'rewrite_section 缺少 sectionTitle'
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可重写章节的文档标签'
    const rewritten = rewriteSectionInDocument(tab.content, sectionTitle, content, { appendIfMissing: false })
    if (!rewritten.found) return `未找到章节“${sectionTitle}”，未做改动`
    const visualSyntaxRejection = await buildVisualSyntaxRejection('章节重写', rewritten.content)
    if (visualSyntaxRejection) return visualSyntaxRejection
    if (rewritten.content === tab.content) return `章节“${rewritten.matchedTitle || sectionTitle}”内容无变化，未做改动`
    docStore.setTabContent(tab.id, rewritten.content)
    rememberPendingToolDocumentWrite(tab.id, rewritten.content, 'rewrite_section', tab.content)
    return `已重写章节（${rewritten.matchedTitle || sectionTitle}）`
  }

  if (type === 'save_tab') {
    const tab = resolveDocActionTab(action)
    if (!tab) return '没有可保存的文档标签'
    const requestedPath = typeof action.path === 'string' ? action.path.trim() : ''
    const targetPath = requestedPath || tab.path || ''
    if (requestedPath && requestedPath !== tab.path) {
      docStore.setTabPath(tab.id, requestedPath)
    }
    if (!targetPath) {
      const saved = await saveTabWithDialog(tab.id, tab.title, tab.content, null)
      if (saved.success) clearRecentToolTargetTab(tab.id)
      return saved.success ? `已另存文档：${saved.path}` : `保存失败：${saved.error || tab.title}`
    }
    const saveBlockedReason = getDirectSaveBlockReason(targetPath)
    if (saveBlockedReason) return saveBlockedReason
    if (typeof window === 'undefined' || !window.electronAPI?.document?.writeFile) return '当前环境不支持保存文档'
    const pendingToolWrite = getPendingToolDocumentWrite(tab.id)
    const shouldUsePendingToolWrite = Boolean(
      pendingToolWrite && (tab.content === pendingToolWrite.content || tab.content === pendingToolWrite.baseContent),
    )
    const contentToSave = shouldUsePendingToolWrite && pendingToolWrite ? pendingToolWrite.content : tab.content
    if (!tab.isDirty || shouldUsePendingToolWrite) {
      const disk = await window.electronAPI.document.readFile?.(targetPath).catch(() => null)
      const diskContent = disk && typeof disk === 'object' && 'success' in disk && disk.success
        ? String(disk.content || '')
        : null
      if (diskContent === null || diskContent === contentToSave) {
        if (pendingToolWrite) clearPendingToolDocumentWrite(tab.id)
        clearRecentToolTargetTab(tab.id)
        return `文档未改动，已跳过保存：${targetPath}`
      }
    }
    const result = await window.electronAPI.document.writeFile(targetPath, contentToSave)
    if (!result.success) return `保存失败：${result.error || tab.title}`
    if (contentToSave !== tab.content) {
      docStore.setTabContent(tab.id, contentToSave)
    }
    docStore.markTabSaved(tab.id)
    clearPendingToolDocumentWrite(tab.id)
    clearRecentToolTargetTab(tab.id)
    return `已保存文档：${targetPath}`
  }

  return `不支持的文档动作：${type}`
}

export type DocActionFailureReason = 'target_not_resolved'

const DOC_ACTION_TARGET_NOT_RESOLVED_PATTERNS: ReadonlyArray<RegExp> = [
  /未找到与你选择的卡片对应的 widget/,
  /未找到可更新的 widget，请用标题或序号重试/,
  /当前文档里还没有 widget，请先插入一个再发起修改/,
  /未找到序号为\s*\d+\s*的 widget/,
  /未找到标题匹配.+?的 widget/,
]

export function classifyDocActionFailureReason(
  action: DocActionPayload,
  summary: string,
): DocActionFailureReason | null {
  if (!summary) return null
  const type = String(action.type || '').trim()
  if (type !== 'update_widget') return null
  return DOC_ACTION_TARGET_NOT_RESOLVED_PATTERNS.some((re) => re.test(summary))
    ? 'target_not_resolved'
    : null
}

export function mapToolActionToDocAction(tool: string, args: Record<string, unknown>): DocActionPayload | null {
  switch (tool) {
    case 'document.newTab':
      return { type: 'new_tab', title: args.title, path: args.path }
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
    case 'document.insertWidget':
      return {
        type: 'insert_widget',
        title: args.title,
        widgetCode: args.widgetCode,
        componentSpec: args.componentSpec,
        position: args.position,
        sectionTitle: args.sectionTitle,
        tabId: args.tabId,
      }
    case 'document.listWidgets':
      return { type: 'list_widgets', tabId: args.tabId }
    case 'document.updateWidget':
      return {
        type: 'update_widget',
        target: args.target,
        widgetCode: args.widgetCode,
        componentSpec: args.componentSpec,
        componentSpecPatch: args.componentSpecPatch,
        title: args.title,
        occurrence: args.occurrence,
        tabId: args.tabId,
      }
    case 'document.removeWidget':
      return {
        type: 'remove_widget',
        target: args.target,
        occurrence: args.occurrence,
        tabId: args.tabId,
      }
    case 'document.replaceText':
      return { type: 'replace_text', from: args.from, to: args.to, tabId: args.tabId }
    case 'document.replaceExact':
      return { type: 'replace_exact', target: args.target, replacement: args.replacement, occurrence: args.occurrence, tabId: args.tabId }
    case 'document.formatSection':
      return { type: 'format_section', sectionTitle: args.sectionTitle, style: args.style, tabId: args.tabId }
    case 'document.rewriteSection':
      return { type: 'rewrite_section', sectionTitle: args.sectionTitle, content: args.content, tabId: args.tabId }
    case 'document.saveTab':
      return { type: 'save_tab', tabId: args.tabId, path: args.path }
    default:
      return null
  }
}

export async function runDocCommand(raw: string): Promise<CommandResult> {
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
        '`/doc list-widgets`',
        '`/doc insert-widget 标题 => HTML/SVG/JS [:: append_end|after_section :: 章节标题]`',
        '`/doc update-widget 目标 => 新HTML/SVG/JS [:: 新标题] [:: occurrence]`',
        '`/doc remove-widget 目标 [:: occurrence]`',
        '`/doc replace 原文 => 新文`',
        '`/doc replace-exact 原文 => 新文 [:: occurrence]`',
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
    if (!loaded.success) return { handled: true, text: `已打开文档：${arg}（读取失败：${loaded.error || '未知错误'}）`, isError: true }
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

  if (command === 'insert-widget') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可插入 widget 的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) {
      return { handled: true, text: '插入 widget 格式：/doc insert-widget 标题 => HTML/SVG/JS [:: append_end|after_section :: 章节标题]', isError: true }
    }
    const title = arg.slice(0, sep).trim()
    const right = arg.slice(sep + 2).trim()
    const pieces = right.split('::').map((piece) => piece.trim()).filter(Boolean)
    const widgetCode = pieces[0] || ''
    const position = pieces[1] === 'after_section' ? 'after_section' : 'append_end'
    const sectionTitle = position === 'after_section' ? (pieces[2] || '') : ''
    const inserted = insertWidgetIntoDocument(tab.content, title, widgetCode, position, sectionTitle)
    if (!inserted.inserted) return { handled: true, text: inserted.error || 'widget 插入失败', isError: true }
    docStore.setTabContent(tab.id, inserted.content)
    return { handled: true, text: position === 'after_section' ? `已在章节后插入 widget：${inserted.matchedTitle || sectionTitle}` : `已在文档尾部插入 widget：${title}` }
  }

  if (command === 'list-widgets') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可读取 widget 的文档标签', isError: true }
    const widgets = collectDocumentWidgets(tab.content)
    if (widgets.length === 0) return { handled: true, text: `当前文档没有 widget：${tab.title}` }
    return {
      handled: true,
      text: [
        `当前文档共有 ${widgets.length} 个 widget：`,
        ...widgets.map((widget) => `${widget.index}. ${widget.title} [${widget.mode}]`),
      ].join('\n'),
    }
  }

  if (command === 'update-widget') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可更新 widget 的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) {
      return { handled: true, text: '更新 widget 格式：/doc update-widget 目标 => 新HTML/SVG/JS [:: 新标题] [:: occurrence]', isError: true }
    }
    const target = arg.slice(0, sep).trim()
    const right = arg.slice(sep + 2).trim()
    const pieces = right.split('::').map((piece) => piece.trim()).filter(Boolean)
    const widgetCode = pieces[0] || ''
    const title = pieces[1] || ''
    const occurrenceRaw = pieces[2] || ''
    const occurrence = occurrenceRaw ? Number(occurrenceRaw) : undefined
    const updated = updateWidgetInDocument(tab.content, target, widgetCode, title, Number.isFinite(occurrence) ? occurrence : undefined)
    if (!updated.found) return { handled: true, text: updated.error || 'widget 更新失败', isError: true }
    docStore.setTabContent(tab.id, updated.content)
    return { handled: true, text: `已更新 widget：${title || updated.widget?.title || target}` }
  }

  if (command === 'remove-widget') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可删除 widget 的文档标签', isError: true }
    const pieces = arg.split('::').map((piece) => piece.trim()).filter(Boolean)
    const target = pieces[0] || ''
    const occurrence = pieces[1] ? Number(pieces[1]) : undefined
    const removed = removeWidgetFromDocument(tab.content, target, Number.isFinite(occurrence) ? occurrence : undefined)
    if (!removed.found) return { handled: true, text: removed.error || 'widget 删除失败', isError: true }
    docStore.setTabContent(tab.id, removed.content)
    return { handled: true, text: `已删除 widget：${removed.widget?.title || target}` }
  }

  if (command === 'replace') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可替换的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) return { handled: true, text: '替换格式：/doc replace 原文 => 新文', isError: true }
    const from = arg.slice(0, sep).trim()
    const to = arg.slice(sep + 2).trim()
    docStore.setTabContent(tab.id, tab.content.split(from).join(to))
    return { handled: true, text: `已在 ${tab.title} 中完成替换` }
  }

  if (command === 'replace-exact') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可精准替换的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) return { handled: true, text: '精准替换格式：/doc replace-exact 原文 => 新文 [:: occurrence]', isError: true }
    const left = arg.slice(0, sep).trim()
    const right = arg.slice(sep + 2).trim()
    const occurrenceSep = right.lastIndexOf('::')
    const replacement = occurrenceSep > 0 ? right.slice(0, occurrenceSep).trim() : right
    const occurrenceRaw = occurrenceSep > 0 ? right.slice(occurrenceSep + 2).trim() : ''
    const occurrence = occurrenceRaw ? Number(occurrenceRaw) : undefined
    const replaced = replaceExactTextInDocument(tab.content, left, replacement, Number.isFinite(occurrence) ? occurrence : undefined)
    if (!replaced.found) return { handled: true, text: replaced.error || '未匹配到目标片段', isError: true }
    docStore.setTabContent(tab.id, replaced.content)
    return { handled: true, text: `已精准替换第 ${replaced.occurrenceUsed || 1} 处目标片段` }
  }

  if (command === 'format') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可格式化章节的文档标签', isError: true }
    const sectionTitle = arg.trim()
    if (!sectionTitle) return { handled: true, text: '章节格式优化格式：/doc format 章节标题', isError: true }
    const formatted = formatSectionInDocument(tab.content, sectionTitle)
    if (!formatted.found) return { handled: true, text: `未找到章节“${sectionTitle}”，未做改动`, isError: true }
    docStore.setTabContent(tab.id, formatted.content)
    return { handled: true, text: `已优化章节格式：${formatted.matchedTitle || sectionTitle}` }
  }

  if (command === 'rewrite') {
    const tab = getActiveDocTab()
    if (!tab) return { handled: true, text: '没有可重写章节的文档标签', isError: true }
    const sep = arg.indexOf('=>')
    if (sep <= 0) return { handled: true, text: '章节重写格式：/doc rewrite 章节标题 => 新章节内容', isError: true }
    const sectionTitle = arg.slice(0, sep).trim()
    const content = arg.slice(sep + 2).trim()
    if (!sectionTitle) return { handled: true, text: '章节重写缺少章节标题', isError: true }
    const rewritten = rewriteSectionInDocument(tab.content, sectionTitle, content, { appendIfMissing: false })
    if (!rewritten.found) return { handled: true, text: `未找到章节“${sectionTitle}”，未做改动`, isError: true }
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
    if (!tab.path) {
      const saved = await saveTabWithDialog(tab.id, tab.title, tab.content, null)
      return saved.success
        ? { handled: true, text: `已另存：${saved.path}` }
        : { handled: true, text: `保存失败：${saved.error || tab.title}`, isError: true }
    }
    if (!tab.isDirty) return { handled: true, text: `文档未改动，已跳过保存：${tab.path}` }
    const saveBlockedReason = getDirectSaveBlockReason(tab.path)
    if (saveBlockedReason) return { handled: true, text: saveBlockedReason, isError: true }
    if (typeof window === 'undefined' || !window.electronAPI?.document?.writeFile) return { handled: true, text: '当前环境不支持保存文档', isError: true }
    const result = await window.electronAPI.document.writeFile(tab.path, tab.content)
    if (!result.success) return { handled: true, text: `保存失败：${result.error || tab.path}`, isError: true }
    docStore.markTabSaved(tab.id)
    return { handled: true, text: `已保存：${tab.path}` }
  }

  return { handled: true, text: `未知文档命令：${command}`, isError: true }
}
