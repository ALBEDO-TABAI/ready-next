const CONTEXT_MARKERS = [
  '### 当前文档上下文',
  '### Widget 更新上下文',
  '--- 文档内容开始 ---',
  '### 当前设计画布上下文',
  '### 设计项目引用',
  '--- 引用设计项目:',
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

  const designKeyword =
    /(画板|画布|设计稿|设计图|设计模式|设计项目|封面|封面图|海报|版式|排版框架|视觉框架|小红书|首图|缩略图|youtube|shorts?|thumbnail|9[:：]16|16[:：]9|3[:：]4|4[:：]3|1[:：]1|\d{3,4}\s*[x×]\s*\d{3,4}|poster|cover|layout)/i
  const designCreateIntent =
    /(新建|创建|生成|搭一个|搭建|做一个|做版式|出一个|再来一个|再来个|再来一版|再出一版|来一个|来一版|换一个|换个|换一版|换个版式|换一种|放到画板|在画板|在画布|给我一个框架|给我一个版式|替换内容|直接替换|可直接替换|继续做封面|继续完成|塞到|排版|长图文|文本排版|诗歌排版|散文排版)/i
  const docKeyword = /(文档|文稿|原文|文章|段落|docx?|markdown|\.md\b)/i

  let score = 0
  if (BOOTSTRAP_HEADER_PATTERN.test(lines[0] || '')) score -= 24
  if (designKeyword.test(text)) score += 18
  if (designCreateIntent.test(text)) score += 16
  if (/[？?]$/.test(text) || /^(请|帮我|在|给我)/.test(text)) score += 4
  if (docKeyword.test(text)) score -= 4
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

/**
 * Determine if design tools should be suggested (not forced)
 * This function receives pure user input without environment context pollution
 */
export function shouldSuggestDesignTools(pureUserInput: string, hasDesignEnvironment: boolean): boolean {
  if (!pureUserInput) return false
  const primaryInstruction = extractPrimaryUserInstruction(pureUserInput)
  if (!primaryInstruction) return false

  // 1. Exclude pure conversational questions
  const conversationalQuestion =
    /^(你是谁|你叫什么|你能做什么|你会什么|介绍一下|自我介绍|你好|谢谢|好的|明白|知道了|了解|收到|OK|ok|okay)/i
  if (conversationalQuestion.test(primaryInstruction.trim())) return false

  // 2. Exclude explanation questions (unless explicitly about design)
  const explanationQuestion =
    /(解释|说明|告诉我|什么是|为什么|怎么理解|如何理解|是什么意思|能不能说|讲讲|介绍下)/i
  const designKeyword =
    /(画板|画布|设计稿|设计图|设计模式|设计项目|封面|封面图|海报|版式|排版框架|视觉框架|小红书|首图|缩略图|youtube|shorts?|thumbnail|9[:：]16|16[:：]9|3[:：]4|4[:：]3|1[:：]1|\d{3,4}\s*[x×]\s*\d{3,4}|poster|cover|layout)/i
  if (explanationQuestion.test(primaryInstruction) && !designKeyword.test(primaryInstruction)) return false

  // 3. Exclude general questions (unless explicitly about design)
  const generalQuestion =
    /^(帮我|请|可以|能不能|能否)?(查|搜|找|看|问|想知道|了解|学习)/i
  if (generalQuestion.test(primaryInstruction) && !designKeyword.test(primaryInstruction)) return false

  // 4. Check design operation intent
  const designCreateIntent =
    /(新建|创建|生成|搭一个|搭建|做一个|做版式|出一个|再来一个|再来个|再来一版|再出一版|来一个|来一版|换一个|换个|换一版|换个版式|换一种|放到画板|在画板|在画布|给我一个框架|给我一个版式|替换内容|直接替换|可直接替换|继续做封面|继续完成|塞到|排版|长图文|文本排版|诗歌排版|散文排版)/i
  const designEditIntent =
    /(调整|修改|修正|优化|改成|偏左|偏右|偏上|偏下|去掉|不要|减少|增加|保留|延续|继续改|基于这个|在这个基础上|轻一点|重一点|更像|收紧|拉开|标题再|底部再|版面再|不要按钮|不要粗线|只有标题|字要更大|元素更大|更显著|标题占画幅|红色主题|蓝色主题|绿色主题|黑色主题)/i
  const designStyleFollowUp =
    /(版式|封面|标题|子标题|账号名|主题|颜色|红色|蓝色|绿色|黑色|字体|字要更大|元素更大|更显著|占画幅|标题旁边|附加信息)/i
  const explicitDocumentIntent =
    /(文档|文稿|原文|文章|章节|段落|markdown|docx?|\.md\b)/i

  // 5. Judgment logic
  const hasDesignKeyword = designKeyword.test(primaryInstruction)
  const hasDesignIntent = designCreateIntent.test(primaryInstruction) || designEditIntent.test(primaryInstruction)
  const hasStyleFollowUp = hasDesignEnvironment && designStyleFollowUp.test(primaryInstruction)

  // Must satisfy:
  // - Has design keyword OR (in design environment AND has design intent)
  // - Has explicit design operation intent (create/edit/style)
  // - Not a document operation
  return (
    (hasDesignKeyword || (hasDesignEnvironment && hasDesignIntent) || hasStyleFollowUp) &&
    (designCreateIntent.test(primaryInstruction) || (hasDesignEnvironment && (designEditIntent.test(primaryInstruction) || designStyleFollowUp.test(primaryInstruction)))) &&
    !explicitDocumentIntent.test(primaryInstruction)
  )
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use shouldSuggestDesignTools with pure input
 */
export function shouldForceDesignToolCall(userText: string): boolean {
  if (!userText) return false
  const primaryInstruction = extractPrimaryUserInstruction(userText)
  if (!primaryInstruction) return false

  // 排除纯对话性问题 - 这些不应该触发设计工具
  const conversationalQuestion =
    /^(你是谁|你叫什么|你能做什么|你会什么|介绍一下|自我介绍|你好|谢谢|好的|明白|知道了|了解|收到|OK|ok|okay)/i
  const explanationQuestion =
    /(解释|说明|告诉我|什么是|为什么|怎么理解|如何理解|是什么意思|能不能说|讲讲|介绍下)/i
  const generalQuestion =
    /^(帮我|请|可以|能不能|能否)?(查|搜|找|看|问|想知道|了解|学习)/i

  // 如果是纯对话性问题，直接返回 false
  if (conversationalQuestion.test(primaryInstruction.trim())) return false
  if (explanationQuestion.test(primaryInstruction) && !/(设计|画板|画布|封面|海报|版式)/.test(primaryInstruction)) return false
  if (generalQuestion.test(primaryInstruction) && !/(设计|画板|画布|封面|海报|版式)/.test(primaryInstruction)) return false

  const hasDesignContext =
    userText.includes('### 当前设计画布上下文') ||
    userText.includes('### 设计项目引用') ||
    userText.includes('--- 引用设计项目:') ||
    userText.includes('## 环境信息') && userText.includes('当前模式: 设计模式')
  const designKeyword =
    /(画板|画布|设计稿|设计图|设计模式|设计项目|封面|封面图|海报|版式|排版框架|视觉框架|小红书|首图|缩略图|youtube|shorts?|thumbnail|9[:：]16|16[:：]9|3[:：]4|4[:：]3|1[:：]1|\d{3,4}\s*[x×]\s*\d{3,4}|poster|cover|layout)/i
  const designCreateIntent =
    /(新建|创建|生成|搭一个|搭建|做一个|做版式|出一个|再来一个|再来个|再来一版|再出一版|来一个|来一版|换一个|换个|换一版|换个版式|换一种|放到画板|在画板|在画布|给我一个框架|给我一个版式|替换内容|直接替换|可直接替换|继续做封面|继续完成|塞到|排版|长图文|文本排版|诗歌排版|散文排版)/i
  const designEditIntent =
    /(调整|修改|修正|优化|改成|偏左|偏右|偏上|偏下|去掉|不要|减少|增加|保留|延续|继续改|基于这个|在这个基础上|轻一点|重一点|更像|收紧|拉开|标题再|底部再|版面再|不要按钮|不要粗线|只有标题|字要更大|元素更大|更显著|标题占画幅|红色主题|蓝色主题|绿色主题|黑色主题)/i
  const designStyleFollowUp =
    /(版式|封面|标题|子标题|账号名|主题|颜色|红色|蓝色|绿色|黑色|字体|字要更大|元素更大|更显著|占画幅|标题旁边|附加信息)/i
  const explicitDocumentIntent =
    /(文档|文稿|原文|文章|章节|段落|markdown|docx?|\.md\b)/i

  // 必须同时满足：
  // 1. 有设计上下文或设计关键词
  // 2. 有明确的设计操作意图（创建/编辑/样式调整）
  // 3. 不是文档操作
  return (
    (hasDesignContext || designKeyword.test(primaryInstruction)) &&
    (designCreateIntent.test(primaryInstruction) || (hasDesignContext && (designEditIntent.test(primaryInstruction) || designStyleFollowUp.test(primaryInstruction)))) &&
    !explicitDocumentIntent.test(primaryInstruction)
  )
}

export function inferPreferredDesignTool(userText: string): string | null {
  if (!shouldForceDesignToolCall(userText)) return null

  const primaryInstruction = extractPrimaryUserInstruction(userText)
  if (!primaryInstruction) return null

  return 'design_run_task_controller'
}

export function shouldAllowMultipleDesignArtifacts(userText: string): boolean {
  if (!shouldForceDesignToolCall(userText)) return false
  const primaryInstruction = extractPrimaryUserInstruction(userText)
  if (!primaryInstruction) return false

  return /(多个版本|多个方案|两个版本|两个方案|三个版本|三种方案|多版|多套|给我几个|几种方向|AB版|A\/B|variation|variations|options|三版|两版)/i
    .test(primaryInstruction)
}

export function shouldForceDocumentToolCall(userText: string): boolean {
  if (!userText) return false
  if (shouldForceDesignToolCall(userText)) return false
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
  const existingWidgetReference = /(这个|当前|现有|已有|上面|上面这个|图里|卡片里|widget里|趋势图里|波动图里|收益图里|股价图里)/i
  const widgetSurfaceReference = /(预览|输入框|边框|底色|灰色底|卡片|面板|背景|外边框|垫底色块|计算器)/i
  const strongDirectness = /(直接|立刻|马上|立即|在原文中|就地)/i
  if (widgetTaskKind && (
    hasDocContext ||
    hasDocKeyword.test(primaryInstruction) ||
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
    /(widget|show-widget|生成式\s*ui|交互组件|可视化说明|可视化组件|图表|趋势图|波动图|折线图|柱状图|统计图|走势图|价格图|股价图|收益图|对比图|小工具|卡片组件|计算器|输入框|边框|底色|灰色底|卡片|预览)/i
  if (!widgetKeyword.test(primaryInstruction)) return null

  const existingWidgetReference = /(这个|当前|现有|已有|上面|上面这个|图里|卡片里|widget里|趋势图里|波动图里|收益图里|股价图里)/i
  const widgetSurfaceEdit = /(预览|输入框|边框|底色|灰色底|卡片|面板|背景|外边框|垫底色块)/i

  if (/(列出|查看|看看|有哪些|当前.*widget|list)/i.test(primaryInstruction)) {
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
  if (shouldForceDesignToolCall(userText)) return false
  const formatIntent =
    /(格式|排版|版式|结构清晰|阅读流畅|可读性|美观|整洁|格式化|format|layout|typography|readability)/i
  const rewriteIntent =
    /(改写|重写|重构|总结|缩写|扩写|重述|rewrite|paraphrase|summarize|rephrase)/i
  return formatIntent.test(userText) && !rewriteIntent.test(userText)
}

export function shouldPreferSectionRewrite(userText: string): boolean {
  if (!userText) return false
  if (shouldForceDesignToolCall(userText)) return false
  if (shouldPreferFormatOnly(userText)) return false
  const sectionHint =
    /(第[一二三四五六七八九十百0-9]+部分|第[一二三四五六七八九十百0-9]+章|章节|段落|开头|结尾|引言|摘要|第一部分|第二部分|第三部分)/i
  const scopedEditIntent =
    /(修改|改写|重写|润色|优化|整理|调整|替换|rewrite|refine|polish|revise|section|paragraph)/i
  return sectionHint.test(userText) && scopedEditIntent.test(userText)
}
