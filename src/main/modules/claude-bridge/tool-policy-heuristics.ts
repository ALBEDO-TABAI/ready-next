const CONTEXT_MARKERS = [
  '### 当前文档上下文',
  '### Widget 更新上下文',
  '--- 文档内容开始 ---',
  '--- 附件:',
]

export type DocumentWidgetTaskKind = 'create' | 'inspect' | 'update' | 'remove' | null

const BOOTSTRAP_HEADER_PATTERN =
  /^##\s+(L1 会话上下文|L2 按需规则|当前 Scope|最近会话摘要|\d{4}-\d{2}-\d{2}\.md)\b/i

function stripTrailingContexts(raw: string): string {
  let cut = raw.length
  for (const marker of CONTEXT_MARKERS) {
    const index = raw.indexOf(marker)
    if (index >= 0) cut = Math.min(cut, index)
  }
  return raw.slice(0, cut).trim()
}

function scoreInstructionChunk(chunk: string): number {
  const text = chunk.trim()
  if (!text) return Number.NEGATIVE_INFINITY

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const metadataLines = lines.filter((line) => (
    BOOTSTRAP_HEADER_PATTERN.test(line)
    || /^[-*]\s+(标题|来源|线程|项目|文件|状态|选择状态|当前工具|快照哈希)[:：]/i.test(line)
    || /^(用户|助手|系统):/i.test(line)
  )).length

  const actionableKeyword =
    /(文档|文稿|原文|文章|段落|章节|docx?|markdown|\.md\b|widget|show-widget|图表|趋势图|卡片|信息卡|提示块|表格|对比卡|进度卡|日程卡|待办|习惯|计划板|计算器|修改|改写|重写|润色|整理|优化|调整|写入|追加|替换|保存|新建|编辑|插入|创建|生成|删除|移除|查看|列出|格式|排版)/i

  let score = 0
  if (BOOTSTRAP_HEADER_PATTERN.test(lines[0] || '')) score -= 24
  if (actionableKeyword.test(text)) score += 18
  if (/[？?]$/.test(text) || /^(请|帮我|在|给我)/.test(text)) score += 4
  if (metadataLines > 0) score -= metadataLines * 6
  if (lines.every((line) => BOOTSTRAP_HEADER_PATTERN.test(line) || /^[-*]\s+/.test(line) || /^(用户|助手|系统):/i.test(line))) {
    score -= 18
  }
  if (text.length > 420) score -= 2

  return score
}

export function extractPrimaryUserInstruction(raw: string): string {
  if (!raw) return ''

  const stripped = stripTrailingContexts(raw)
  if (!stripped) return raw.trim()

  // Check if there's a "用户:" prefix - extract only user's input
  const userPrefixMatch = stripped.match(/用户:\s*(.+?)(?:\n|$)/s)
  if (userPrefixMatch) {
    return userPrefixMatch[1].trim()
  }

  const chunks = stripped
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  if (chunks.length <= 1) return stripped

  let bestChunk = chunks[chunks.length - 1]
  let bestScore = scoreInstructionChunk(bestChunk)

  for (const chunk of chunks) {
    const score = scoreInstructionChunk(chunk)
    if (score >= bestScore) {
      bestChunk = chunk
      bestScore = score
    }
  }

  if (bestScore > Number.NEGATIVE_INFINITY) return bestChunk
  return stripped
}

export function shouldForceDocumentToolCall(userText: string): boolean {
  if (!userText) return false
  const primaryInstruction = extractPrimaryUserInstruction(userText)
  if (!primaryInstruction) return false
  const widgetTaskKind = inferDocumentWidgetTaskKind(primaryInstruction)
  const normalized = userText.toLowerCase()
  const hasDocContext =
    userText.includes('### 当前文档上下文') ||
    userText.includes('--- 文档内容开始 ---') ||
    normalized.includes('current document context')
  const editIntent = /(直接|帮我|请|请你)?(修改|改写|重写|润色|整理|优化|调整|写入|追加|替换|保存|新建|编辑)|\b(edit|rewrite|refine|update|replace|append|save)\b/i
  if (hasDocContext && editIntent.test(primaryInstruction)) return true

  const hasDocKeyword = /(文档|文稿|原文|文章|段落|docx?|markdown|\.md\b)/i
  const hasWidgetKeyword = /(widget|show-widget|图表|趋势图|卡片|信息卡|提示块|表格|对比卡|进度卡|日程卡|待办|习惯|计划板)/i
  const existingWidgetReference = /(这个|当前|现有|已有|上面|上面这个|图里|卡片里|widget里|趋势图里|波动图里|收益图里|股价图里)/i
  const widgetSurfaceReference = /(预览|输入框|边框|底色|灰色底|卡片|面板|背景|外边框|垫底色块|计算器)/i
  const strongDirectness = /(直接|立刻|马上|立即|在原文中|就地)/i
  if (widgetTaskKind && (
    hasDocContext ||
    hasDocKeyword.test(primaryInstruction) ||
    hasWidgetKeyword.test(primaryInstruction) ||
    existingWidgetReference.test(primaryInstruction) ||
    widgetSurfaceReference.test(primaryInstruction)
  )) {
    return true
  }
  return (
    hasDocKeyword.test(primaryInstruction) &&
    strongDirectness.test(primaryInstruction) &&
    editIntent.test(primaryInstruction)
  )
}

export function inferDocumentWidgetTaskKind(userText: string): DocumentWidgetTaskKind {
  if (!userText) return null
  const primaryInstruction = extractPrimaryUserInstruction(userText)
  if (!primaryInstruction) return null

  const widgetKeyword =
    /(widget|show-widget|生成式\s*ui|交互组件|可视化说明|可视化组件|图表|趋势图|波动图|折线图|柱状图|统计图|走势图|价格图|股价图|收益图|对比图|小工具|卡片组件|计算器|输入框|边框|底色|灰色底|卡片|信息卡|卡片式总结|提示块|表格|对比卡|进度卡|日程卡|待办|习惯|计划板|预览)/i
  if (!widgetKeyword.test(primaryInstruction)) return null

  const existingWidgetReference = /(这个|当前|现有|已有|上面|上面这个|图里|卡片里|widget里|趋势图里|波动图里|收益图里|股价图里)/i
  const widgetSurfaceEdit = /(预览|输入框|边框|底色|灰色底|卡片|面板|背景|外边框|垫底色块)/i

  if (/((列出|查看|看看).*(widget|组件|图表|卡片)|有哪些|当前.*widget|\blist\b)/i.test(primaryInstruction)) {
    return 'inspect'
  }

  if (/(删除|删掉|移除|remove)/i.test(primaryInstruction)) {
    return 'remove'
  }

  if (existingWidgetReference.test(primaryInstruction) && /(增加|添加|加入|补充|扩展|加一个|加上|append|extend|enhance)/i.test(primaryInstruction)) {
    return 'update'
  }

  if (existingWidgetReference.test(primaryInstruction) && /(风格|样式|配色|视觉|主题|统一|一致|协调|美化|润色|改一下风格|统一一下)/i.test(primaryInstruction)) {
    return 'update'
  }

  if (widgetSurfaceEdit.test(primaryInstruction) && /(修改|调整|优化|需要|去掉|拿掉|补上|统一|改成|改为|恢复|简化|极简)/i.test(primaryInstruction)) {
    return 'update'
  }

  if (/(更新|修改|改成|改为|替换|rewrite|update)/i.test(primaryInstruction)) {
    return 'update'
  }

  if (/(插入|新建|创建|生成|做一个|加一个|append|insert|create)/i.test(primaryInstruction)) {
    return 'create'
  }

  return null
}

export function shouldPreferFormatOnly(userText: string): boolean {
  if (!userText) return false
  const formatIntent =
    /(格式|排版|版式|结构清晰|阅读流畅|可读性|美观|整洁|格式化|format|layout|typography|readability)/i
  const rewriteIntent =
    /(改写|重写|重构|总结|缩写|扩写|重述|rewrite|paraphrase|summarize|rephrase)/i
  return formatIntent.test(userText) && !rewriteIntent.test(userText)
}

export function shouldPreferSectionRewrite(userText: string): boolean {
  if (!userText) return false
  if (shouldPreferFormatOnly(userText)) return false
  const sectionHint =
    /(第[一二三四五六七八九十百0-9]+部分|第[一二三四五六七八九十百0-9]+章|章节|段落|开头|结尾|引言|摘要|第一部分|第二部分|第三部分)/i
  const scopedEditIntent =
    /(修改|改写|重写|润色|优化|整理|调整|替换|rewrite|refine|polish|revise|section|paragraph)/i
  return sectionHint.test(userText) && scopedEditIntent.test(userText)
}
