export type StructuredDocumentIntent =
  | 'document_read_then_widget_create'
  | null

const READ_DOCUMENT_PATTERNS = [
  /(先|请先|先去)?(阅读|读一下|读完|读懂|看完|通读|理解)\s*(当前|这份|这个)?(文档|文稿|文章|项目文档)/i,
  /(根据|围绕|基于|从)\s*(当前|这份|这个)?(文档|文稿|文章|项目文档)/i,
  /(看完|阅读完)\s*(当前|这份|这个)?(文档|文稿|文章|项目文档)/i,
] as const

const CREATE_WIDGET_PATTERNS = [
  /(做|生成|制作|整理成|输出为|写成)\s*(一个|一张)?\s*(信息卡|卡片摘要|摘要卡|info card|stats card|comparison card|widget|show-widget|卡片)/i,
  /(生成|制作|做一个)\s*(项目定位|项目摘要|结论|总结).*(信息卡|卡片|widget)/i,
] as const

const EXISTING_WIDGET_UPDATE_PATTERNS = [
  /(更新|修改|调整|优化|重做|替换|改成|改为).*(这个|当前|已有|现有|上面).*(widget|卡片|信息卡)/i,
  /(把|将).*(这个|当前|已有|现有).*(信息卡|卡片|widget).*(改成|改为|换成)/i,
  /(查看|列出|看看).*(widget|卡片)/i,
  /(删除|删掉|移除).*(widget|卡片)/i,
] as const

export function classifyStructuredDocumentIntent(userText: string): StructuredDocumentIntent {
  const text = String(userText || '').trim()
  if (!text) return null

  if (EXISTING_WIDGET_UPDATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return null
  }

  const wantsReadDocument = READ_DOCUMENT_PATTERNS.some((pattern) => pattern.test(text))
  const wantsWidgetCreate = CREATE_WIDGET_PATTERNS.some((pattern) => pattern.test(text))

  return wantsReadDocument && wantsWidgetCreate
    ? 'document_read_then_widget_create'
    : null
}
