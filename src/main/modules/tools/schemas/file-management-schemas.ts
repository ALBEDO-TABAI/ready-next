/**
 * Zod schemas for the file_management domain tools (Phase 2.5 PR 6).
 *
 * Observations:
 * - file-management-tools' toSchemaParam always emits `items: {type: 'string'}`
 *   for any array-typed param regardless of declared items, so the LLM sees a
 *   uniform string-array shape even though hand-rolled params omit items.
 *   We match this by using `z.array(z.string())` for every array field — the
 *   derivation emits items:{type:'string'} which downstream is idempotent.
 * - file_classify.setFrontmatter is a free-form record: z.record keeps it
 *   type=object with no nested properties, matching the hand-rolled output.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

export const FileSearchSchema = z.object({
  query: z.string().describe('搜索表达式；例如 "#project src:document keyword"'),
  sources: z
    .array(z.string())
    .optional()
    .describe('可选，过滤到指定 sourceType 列表（document / bookmark / rss / calendar / agent）'),
  limit: z.number().optional().describe('返回上限（默认 20）'),
  workspaceRoot: z.string().optional().describe('可选，限定 workspace 根'),
})

export const FileLocateSchema = z.object({
  path: z.string().describe('文件绝对路径或索引内 path'),
  anchor: z.string().optional().describe('可选：目标章节标题或关键词；不传则返回首行'),
})

export const FileReadExcerptSchema = z.object({
  path: z.string().describe('文件绝对路径、索引 path，或本轮冻结的 logicalResourceId / @[文件名] / 唯一文件名'),
  anchor: z.string().optional().describe('可选：章节标题或关键词；命中标题时读取该章节'),
  lineStart: z.number().optional().describe('可选：起始行号（从 1 开始）'),
  lineEnd: z.number().optional().describe('可选：结束行号（包含该行）'),
  maxChars: z.number().optional().describe('可选：最大返回字符数（默认 32000，上限 40000）'),
})

export const FileGetBacklinksSchema = z.object({
  path: z.string().describe('目标文件路径'),
  limit: z.number().optional().describe('返回上限（默认 50）'),
})

export const FileGetGraphSchema = z.object({
  centerPath: z.string().optional().describe('可选，作为 BFS 起点的路径'),
  depth: z.number().optional().describe('BFS 深度（默认 2）'),
  workspaceRoot: z.string().optional().describe('可选，限定 workspace 根'),
})

export const FileClassifySchema = z.object({
  path: z.string().describe('.md 文件绝对路径'),
  addTags: z.array(z.string()).optional().describe('要新增的标签数组'),
  removeTags: z.array(z.string()).optional().describe('要移除的标签数组'),
  setFrontmatter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('要覆盖的 frontmatter 键值对'),
})

export const TagForgeProposalSchema = z.object({
  facet: z.enum(['form','domain','entity','use']).describe('内容标签分面；工作流状态不属于标签提案'),
  label: z.string().describe('归一后的标签名'),
  evidenceCode: z.string().describe('短证据类型，例如 title_topic 或 body_topic'),
  evidenceExcerpt: z.string().min(2).describe('原文中的准确短摘录；每个内容标签都必需'),
  confidence: z.number().describe('0 到 1；>=0.92 且证据可回查的新领域/实体/用途可自动采用'),
})

export const TagForgePrepareBatchSchema = z.object({
  rootPath: z.string().optional().describe('新建批次时必需：授权 Markdown 或文件夹的绝对路径、logicalResourceId、@[名称] 或唯一名称'),
  batchId: z.string().optional().describe('继续既有批次时传入上一轮 batchId'),
  limit: z.number().optional().describe('本批返回的待处理文档数（默认 4，上限 4，并受正文总量限制）'),
})

export const TagForgeApplyBatchSchema = z.object({
  batchId: z.string().describe('tag_forge_prepare_batch 返回的批次 id'),
  items: z.array(z.object({
    itemId: z.string().describe('prepare 返回的不透明文档 id；不要改写或用文件路径代替'),
    expectedRevision: z.string().describe('prepare 返回的版本凭证；必须原样回传'),
    proposals: z.array(TagForgeProposalSchema).min(1).describe('本文档的完整内容标签提案；每项都必须带正文证据'),
  })).min(1).describe('本批每份文档的版本凭证和带正文证据的完整标签提案'),
})

export const TagForgeReviewBatchSchema = z.object({
  batchId: z.string().describe('出现 reviewRequired 的原 Tag Forge 批次 id'),
  confirmationCardId: z.string().describe('用户已提交的对应 ask_user_questions 反问卡 id；代码会核对问题、答案和本轮身份'),
})

export const FileRenameSchema = z.object({
  path: z.string().describe('原文件绝对路径'),
  newName: z.string().describe('新文件名（含扩展名，不含目录）'),
  overwrite: z.boolean().optional().describe('可选：目标已存在时是否覆盖（默认 false）'),
})

export const FileMoveSchema = z.object({
  path: z.string().describe('原文件绝对路径'),
  destDir: z.string().describe('目标目录绝对路径'),
  newName: z.string().optional().describe('可选：新文件名'),
  overwrite: z.boolean().optional().describe('可选：目标存在时是否覆盖（默认 false）'),
})

export const FileCopySchema = z.object({
  path: z.string().describe('原文件绝对路径'),
  destDir: z.string().describe('目标目录绝对路径'),
  newName: z.string().optional().describe('可选：新文件名'),
  overwrite: z.boolean().optional().describe('可选：目标存在时是否覆盖（默认 false）'),
})

const OrganizeOperationSchema = z.object({
  path: z.string().describe('原文件绝对路径'),
  destDir: z.string().describe('目标目录绝对路径'),
  newName: z.string().optional().describe('可选：新文件名'),
})

export const FileInventorySchema = z.object({
  rootPath: z.string().describe('要盘点的授权文件夹：绝对路径，或本轮冻结的 logicalResourceId / @[文件夹名]'),
  cursor: z.string().optional().describe('可选：上一页返回的 nextCursor'),
  limit: z.number().optional().describe('可选：返回上限（默认 100，上限 500）'),
  recursive: z.boolean().optional().describe('可选：是否递归扫描（默认 false）'),
  maxDepth: z.number().optional().describe('可选：递归最大深度（默认 2，上限 5）'),
  includeSummaries: z.boolean().optional().describe('可选：是否为支持的文件返回短摘要（默认 false）'),
})

export const FileExtractTextSchema = z.object({
  path: z.string().describe('要抽取文本的文件绝对路径'),
  offset: z.number().optional().describe('可选：从第几个字符开始返回（默认 0）'),
  maxChars: z.number().optional().describe('可选：最大返回字符数（默认 20000，上限 40000）'),
})

export const FileCreateFolderSchema = z.object({
  rootPath: z.string().describe('授权工作区根目录绝对路径'),
  relativePath: z.string().describe('要创建的相对文件夹路径'),
})

export const FileOrganizePreviewSchema = z.object({
  rootPath: z.string().describe('授权工作区根目录绝对路径'),
  createFolders: z.array(z.string()).optional().describe('要创建的相对文件夹路径列表'),
  operations: z.array(OrganizeOperationSchema).describe('要预览的移动/改名操作列表'),
})

export const FileOrganizeApplySchema = z.object({
  planId: z.string().describe('file_organize_preview 返回的 planId'),
  confirmed: z.boolean().describe('用户已确认该预览方案时传 true'),
  confirmedVia: z.enum(['ask_user_questions', 'ui_action']).describe('确认来源'),
})

export const FileOrganizeUndoSchema = z.object({
  journalId: z.string().describe('file_organize_apply 返回的 journalId'),
})

export type FileManagementToolName =
  | 'file_search'
  | 'file_locate'
  | 'file_read_excerpt'
  | 'file_get_backlinks'
  | 'file_get_graph'
  | 'file_classify'
  | 'tag_forge_prepare_batch'
  | 'tag_forge_apply_batch'
  | 'tag_forge_review_batch'
  | 'file_rename'
  | 'file_move'
  | 'file_copy'
  | 'file_inventory'
  | 'file_extract_text'
  | 'file_create_folder'
  | 'file_organize_preview'
  | 'file_organize_apply'
  | 'file_organize_undo'

export const FILE_MANAGEMENT_SCHEMAS: Record<FileManagementToolName, z.ZodObject<z.ZodRawShape>> = {
  file_search: FileSearchSchema,
  file_locate: FileLocateSchema,
  file_read_excerpt: FileReadExcerptSchema,
  file_get_backlinks: FileGetBacklinksSchema,
  file_get_graph: FileGetGraphSchema,
  file_classify: FileClassifySchema,
  tag_forge_prepare_batch: TagForgePrepareBatchSchema,
  tag_forge_apply_batch: TagForgeApplyBatchSchema,
  tag_forge_review_batch: TagForgeReviewBatchSchema,
  file_rename: FileRenameSchema,
  file_move: FileMoveSchema,
  file_copy: FileCopySchema,
  file_inventory: FileInventorySchema,
  file_extract_text: FileExtractTextSchema,
  file_create_folder: FileCreateFolderSchema,
  file_organize_preview: FileOrganizePreviewSchema,
  file_organize_apply: FileOrganizeApplySchema,
  file_organize_undo: FileOrganizeUndoSchema,
}
