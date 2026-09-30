import type { ChatAttachment } from '../../../stores/useAgent'

export function formatDesignAttachmentSummary(attachment: ChatAttachment): string {
  return [
    '### 设计项目引用',
    `- 项目: ${attachment.name}`,
    attachment.path && attachment.path.startsWith('/')
      ? `- 文件: ${attachment.path}`
      : '- 文件: (未保存草稿)',
    attachment.dirty
      ? '- 状态: 有未保存更改'
      : attachment.saveStatus
        ? `- 状态: ${attachment.saveStatus}`
        : null,
    attachment.selectionSummary ? `- 选择状态: ${attachment.selectionSummary}` : null,
    attachment.currentToolContext ? `- 当前工具: ${attachment.currentToolContext}` : null,
    attachment.snapshotHash ? `- 快照哈希: ${attachment.snapshotHash}` : null
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatDocumentQuoteAttachmentSummary(attachment: ChatAttachment): string {
  const lineLabel =
    attachment.lineStart && attachment.lineEnd
      ? attachment.lineStart === attachment.lineEnd
        ? `第 ${attachment.lineStart} 行`
        : `第 ${attachment.lineStart}-${attachment.lineEnd} 行`
      : null

  return [
    '### 文档引用',
    `- 文档: ${attachment.title || attachment.name}`,
    `- 路径: ${attachment.path}`,
    attachment.sectionTitle ? `- 章节: ${attachment.sectionTitle}` : null,
    lineLabel ? `- 位置: ${lineLabel}` : null,
    attachment.selection ? '' : null,
    attachment.selection ? '```quote' : null,
    attachment.selection || null,
    attachment.selection ? '```' : null
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatDocumentWidgetTargetSummary(attachment: ChatAttachment): string {
  return [
    '### Widget 更新目标',
    `- 文档: ${attachment.documentTitle || '(未保存草稿)'}`,
    `- 目标 widget: ${attachment.widgetTitle || attachment.title || attachment.name}`,
    `- 路径: ${attachment.path}`,
    attachment.widgetMode ? `- 当前模式: ${attachment.widgetMode}` : null,
    '',
    '```show-widget',
    JSON.stringify({
      title: attachment.widgetTitle || attachment.title || attachment.name,
      widget_code: attachment.widgetCode || ''
    }),
    '```'
  ]
    .filter(Boolean)
    .join('\n')
}

export function getDocumentQuoteTooltip(attachment: ChatAttachment): string {
  return [
    attachment.title || attachment.name,
    attachment.sectionTitle ? `章节: ${attachment.sectionTitle}` : null,
    attachment.lineStart && attachment.lineEnd
      ? attachment.lineStart === attachment.lineEnd
        ? `第 ${attachment.lineStart} 行`
        : `第 ${attachment.lineStart}-${attachment.lineEnd} 行`
      : null,
    attachment.selection ? attachment.selection.slice(0, 200) : null
  ]
    .filter(Boolean)
    .join('\n')
}

export function getAttachmentMetaSummary(attachment: ChatAttachment): string | null {
  if (attachment.source === 'rss-reference') return attachment.rssReference?.kind === 'excerpt' ? 'RSS 选区引用' : attachment.rssReference?.kind === 'article' ? 'RSS 文章引用' : attachment.rssReference?.kind === 'digest' ? 'RSS 刊物引用' : 'RSS 筛选结果引用'
  if (attachment.isDirectory) {
    return '文件夹'
  }

  if (attachment.source === 'document-quote') {
    const lineLabel =
      attachment.lineStart && attachment.lineEnd
        ? attachment.lineStart === attachment.lineEnd
          ? `L${attachment.lineStart}`
          : `L${attachment.lineStart}-${attachment.lineEnd}`
        : null
    return [attachment.sectionTitle, lineLabel].filter(Boolean).join(' · ') || '文档引用'
  }

  if (attachment.source === 'skill-folder') {
    return attachment.skillId ? `skill · ${attachment.skillId}` : 'skill'
  }

  if (attachment.source === 'browser-tab') {
    return '网页引用'
  }

  if (attachment.source === 'document-tab') {
    return attachment.dirty ? '文档标签 · 未保存' : '文档标签'
  }

  if (attachment.source === 'calendar-event') {
    return '日程引用'
  }

  if (attachment.source === 'document-widget-target') {
    return [
      attachment.widgetTitle || attachment.title || attachment.name,
      attachment.documentTitle ? `文档: ${attachment.documentTitle}` : null,
      attachment.widgetMode || 'widget 更新'
    ]
      .filter(Boolean)
      .join('\n')
  }

  return null
}

export function formatFolderAttachmentSummary(attachment: ChatAttachment): string {
  return [
    '### 文件夹引用',
    `- 名称: ${attachment.name}`,
    `- 路径: ${attachment.path}`,
    '- 用途: 可让 agent 直接基于这个目录继续定位文件、生成结果或说明目标落点。'
  ].join('\n')
}
