import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
import { useDocTabs } from '../../stores/useDocTabs'
import { useMode } from '../../stores/useMode'

interface DocActionPayload {
  type: string
  [key: string]: unknown
}

export interface CommandResult {
  handled: boolean
  text: string
  isError?: boolean
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

  const numericHeading = line.match(/^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[\.、]))\s+(.+)$/)
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

export function buildActiveDocumentContext(): string | null {
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

export async function performDocAction(action: DocActionPayload): Promise<string> {
  const docStore = useDocTabs.getState()
  useMode.getState().setWorkbenchMode('document')

  const type = String(action.type || '').trim()
  if (!type) return '文档动作缺少 type 字段'

  if (type === 'new_tab') {
    docStore.openTab('')
    const title = typeof action.title === 'string' ? action.title.trim() : ''
    const created = getActiveDocTab()
    if (created && title) docStore.renameTab(created.id, title)
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
    if (!loaded.success) return `已打开文档：${path}（读取失败：${loaded.error || '未知错误'}）`

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
    if (!formatted.found) return `未找到章节“${sectionTitle}”，未做改动`
    if (formatted.content === tab.content) return `章节“${formatted.matchedTitle || sectionTitle}”已是目标格式，未做改动`
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
    if (!rewritten.found) return `未找到章节“${sectionTitle}”，未做改动`
    if (rewritten.content === tab.content) return `章节“${rewritten.matchedTitle || sectionTitle}”内容无变化，未做改动`
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
    if (typeof window === 'undefined' || !window.electronAPI?.document?.writeFile) return '当前环境不支持保存文档'
    const result = await window.electronAPI.document.writeFile(tab.path, tab.content)
    if (!result.success) return `保存失败：${result.error || tab.title}`
    docStore.markTabSaved(tab.id)
    return `已保存文档：${tab.path}`
  }

  return `不支持的文档动作：${type}`
}

export function mapToolActionToDocAction(tool: string, args: Record<string, unknown>): DocActionPayload | null {
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
    if (!tab.path) return { handled: true, text: `文档 ${tab.title} 还没有文件路径，暂不能保存`, isError: true }
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
