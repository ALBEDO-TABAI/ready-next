/**
 * Zod schemas for the 16 document domain tools (Phase 2.5 PR 7).
 *
 * componentSpec / componentSpecPatch are intentionally declared as
 * z.record(z.string(), z.unknown()) so derivation emits {type: 'object'} with
 * no nested properties — matching the hand-rolled output which only emits
 * {type, description} for object params. The structured OpenUI spec is still
 * validated downstream by the widget arbitration layer; the dispatch-time
 * schema only needs to confirm the field is an object.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

export const DocumentNewTabSchema = z.object({
  title: z.string().optional().describe('新标签标题（可选）'),
  path: z.string().optional().describe('可选，目标保存路径；提供后创建或复用该路径的后台标签'),
})

export const DocumentOpenTabSchema = z.object({
  path: z.string().describe('文档绝对路径'),
})

export const DocumentSwitchTabSchema = z.object({
  target: z.string().describe('tabId、标题关键词或序号'),
})

export const DocumentRenameTabSchema = z.object({
  title: z.string().describe('新标题'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentSetContentSchema = z.object({
  content: z.string().describe('完整文档内容'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentAppendContentSchema = z.object({
  content: z.string().describe('要追加的内容'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentInsertWidgetSchema = z.object({
  title: z.string().describe('widget 标题（建议 snake_case 或简短标题）'),
  widgetCode: z
    .string()
    .optional()
    .describe('可选：直接提供 widget 的 HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）'),
  componentSpec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('可选：结构化 OpenUI 组件规格，例如 { component, props?, dataSource? }。优先使用它而不是自由 HTML。'),
  position: z.string().describe('插入位置：prepend_start（文档开头/大标题之后，用户要求"开头/顶部/标题下"时用它）、append_end（文末）或 after_section（指定章节后）'),
  sectionTitle: z.string().optional().describe('当 position=after_section 时，目标章节标题'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentListWidgetsSchema = z.object({
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentReadSectionSchema = z.object({
  tabId: z.string().optional().describe('可选，目标标签 ID；current 表示当前活动文档'),
  range: z
    .string()
    .optional()
    .describe('可选，读取范围：full、section:<标题或序号>、chapter:<序号>、lines:<起始>-<结束>'),
  sectionTitle: z.string().optional().describe('可选，章节标题或编号；优先级低于 range'),
  lineStart: z.number().optional().describe('可选，1-based 起始行'),
  lineEnd: z.number().optional().describe('可选，1-based 结束行（含）'),
  maxChars: z.number().optional().describe('可选，最多返回字符数，默认 12000'),
})

export const DocumentUpdateWidgetSchema = z.object({
  target: z.string().describe('目标 widget 标题关键词或 1-based 序号'),
  widgetCode: z
    .string()
    .optional()
    .describe('可选：新的 widget HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）'),
  componentSpec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('可选：结构化 OpenUI 组件规格，例如 { component, props?, dataSource? }。优先使用它而不是自由 HTML。'),
  componentSpecPatch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('可选：仅包含变更字段的 componentSpec patch。适合在已有结构化 widget 上做小改。'),
  title: z.string().optional().describe('可选，更新后的新标题'),
  occurrence: z
    .number()
    .optional()
    .describe('当标题命中多个 widget 时，指定第几处（从 1 开始）'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentRemoveWidgetSchema = z.object({
  target: z.string().describe('目标 widget 标题关键词或 1-based 序号'),
  occurrence: z
    .number()
    .optional()
    .describe('当标题命中多个 widget 时，指定第几处（从 1 开始）'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentReplaceTextSchema = z.object({
  from: z.string().describe('要替换的原文'),
  to: z.string().describe('替换后的文本'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentReplaceExactSchema = z.object({
  target: z.string().describe('要精准替换的原文片段'),
  replacement: z.string().describe('替换后的新内容'),
  occurrence: z.number().optional().describe('可选，第几处匹配（从 1 开始）'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentFormatSectionSchema = z.object({
  sectionTitle: z.string().describe('章节标题（例如：引言、第二部分）'),
  style: z.string().optional().describe('可选，格式化风格（默认 readable）'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentRewriteSectionSchema = z.object({
  sectionTitle: z.string().describe('章节标题（例如：引言、第二部分）'),
  content: z.string().describe('章节完整新内容（不含标题行）'),
  tabId: z.string().optional().describe('可选，目标标签 ID'),
})

export const DocumentSaveTabSchema = z.object({
  tabId: z.string().optional().describe('可选，目标标签 ID'),
  path: z.string().optional().describe('可选，直接保存到该绝对路径'),
  tagProposals: z.array(z.object({facet:z.enum(['form','domain','entity','use']),label:z.string().trim().min(1),evidenceCode:z.string().trim().min(1),evidenceExcerpt:z.string().trim().min(2),confidence:z.number().min(0).max(1)})).min(1).optional().describe('新建 Markdown 只需提交现有标签尚未覆盖的候选；已有标签可直接满足形态/主题，无需补充时可省略。每项都要附最终正文中的准确摘录，state/project 不由模型填写'),
})

export type DocumentToolName =
  | 'document_new_tab'
  | 'document_open_tab'
  | 'document_switch_tab'
  | 'document_rename_tab'
  | 'document_set_content'
  | 'document_append_content'
  | 'document_insert_widget'
  | 'document_list_widgets'
  | 'document_read_section'
  | 'document_update_widget'
  | 'document_remove_widget'
  | 'document_replace_text'
  | 'document_replace_exact'
  | 'document_format_section'
  | 'document_rewrite_section'
  | 'document_save_tab'

export const DOCUMENT_SCHEMAS: Record<DocumentToolName, z.ZodObject<z.ZodRawShape>> = {
  document_new_tab: DocumentNewTabSchema,
  document_open_tab: DocumentOpenTabSchema,
  document_switch_tab: DocumentSwitchTabSchema,
  document_rename_tab: DocumentRenameTabSchema,
  document_set_content: DocumentSetContentSchema,
  document_append_content: DocumentAppendContentSchema,
  document_insert_widget: DocumentInsertWidgetSchema,
  document_list_widgets: DocumentListWidgetsSchema,
  document_read_section: DocumentReadSectionSchema,
  document_update_widget: DocumentUpdateWidgetSchema,
  document_remove_widget: DocumentRemoveWidgetSchema,
  document_replace_text: DocumentReplaceTextSchema,
  document_replace_exact: DocumentReplaceExactSchema,
  document_format_section: DocumentFormatSectionSchema,
  document_rewrite_section: DocumentRewriteSectionSchema,
  document_save_tab: DocumentSaveTabSchema,
}
