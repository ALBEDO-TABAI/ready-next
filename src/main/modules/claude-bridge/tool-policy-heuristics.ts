const CONTEXT_MARKERS = [
  '### 当前文档上下文',
  '--- 文档内容开始 ---',
  '### 当前设计画布上下文',
  '### 设计项目引用',
  '--- 引用设计项目:',
  '--- 附件:',
]

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
    /(新建|创建|生成|搭一个|搭建|做一个|做版式|出一个|再来一个|再来个|再来一版|再出一版|来一个|来一版|换一个|换个|换一版|换个版式|换一种|放到画板|在画板|在画布|给我一个框架|给我一个版式|替换内容|直接替换|可直接替换|继续做封面|继续完成)/i
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

export function shouldForceDesignToolCall(userText: string): boolean {
  if (!userText) return false
  const primaryInstruction = extractPrimaryUserInstruction(userText)
  if (!primaryInstruction) return false

  const hasDesignContext =
    userText.includes('### 当前设计画布上下文') ||
    userText.includes('### 设计项目引用') ||
    userText.includes('--- 引用设计项目:')
  const designKeyword =
    /(画板|画布|设计稿|设计图|设计模式|设计项目|封面|封面图|海报|版式|排版框架|视觉框架|小红书|首图|缩略图|youtube|shorts?|thumbnail|9[:：]16|16[:：]9|3[:：]4|4[:：]3|1[:：]1|\d{3,4}\s*[x×]\s*\d{3,4}|poster|cover|layout)/i
  const designCreateIntent =
    /(新建|创建|生成|搭一个|搭建|做一个|做版式|出一个|再来一个|再来个|再来一版|再出一版|来一个|来一版|换一个|换个|换一版|换个版式|换一种|放到画板|在画板|在画布|给我一个框架|给我一个版式|替换内容|直接替换|可直接替换|继续做封面|继续完成)/i
  const designEditIntent =
    /(调整|修改|修正|优化|改成|偏左|偏右|偏上|偏下|去掉|不要|减少|增加|保留|延续|继续改|基于这个|在这个基础上|轻一点|重一点|更像|收紧|拉开|标题再|底部再|版面再|不要按钮|不要粗线|只有标题|字要更大|元素更大|更显著|标题占画幅|红色主题|蓝色主题|绿色主题|黑色主题)/i
  const designStyleFollowUp =
    /(版式|封面|标题|子标题|账号名|主题|颜色|红色|蓝色|绿色|黑色|字体|字要更大|元素更大|更显著|占画幅|标题旁边|附加信息)/i
  const explicitDocumentIntent =
    /(文档|文稿|原文|文章|章节|段落|markdown|docx?|\.md\b)/i

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
  const normalized = userText.toLowerCase()
  const hasDocContext =
    userText.includes('### 当前文档上下文') ||
    userText.includes('--- 文档内容开始 ---') ||
    normalized.includes('current document context')
  const editIntent = /(直接|帮我|请|请你)?(修改|改写|重写|润色|整理|优化|调整|写入|追加|替换|保存|新建|编辑)|\b(edit|rewrite|refine|update|replace|append|save)\b/i
  if (hasDocContext && editIntent.test(primaryInstruction)) return true

  const hasDocKeyword = /(文档|文稿|原文|文章|段落|docx?|markdown|\.md\b)/i
  const strongDirectness = /(直接|立刻|马上|立即|在原文中|就地)/i
  return (
    hasDocKeyword.test(primaryInstruction) &&
    strongDirectness.test(primaryInstruction) &&
    editIntent.test(primaryInstruction)
  )
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
