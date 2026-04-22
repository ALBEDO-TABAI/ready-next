/**
 * Zod schemas for the 7 file_management domain tools (Phase 2.5 PR 6).
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

export type FileManagementToolName =
  | 'file_search'
  | 'file_locate'
  | 'file_get_backlinks'
  | 'file_get_graph'
  | 'file_classify'
  | 'file_rename'
  | 'file_move'

export const FILE_MANAGEMENT_SCHEMAS: Record<FileManagementToolName, z.ZodObject<z.ZodRawShape>> = {
  file_search: FileSearchSchema,
  file_locate: FileLocateSchema,
  file_get_backlinks: FileGetBacklinksSchema,
  file_get_graph: FileGetGraphSchema,
  file_classify: FileClassifySchema,
  file_rename: FileRenameSchema,
  file_move: FileMoveSchema,
}
