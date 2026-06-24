/**
 * Pure tool defs + LLM-facing schema builders for file_management (Phase 2.5 PR 6).
 *
 * Extracted from file-management-tools.ts so tests can verify the golden
 * snapshot without dragging in the search-engine IPC handler's electron
 * imports. The execution module (file-management-tools.ts) now re-exports
 * FILE_MANAGEMENT_TOOL_NAMES + getFileManagement{Anthropic,OpenAI}Tools from
 * here to preserve the public surface.
 *
 * Zod-backed: params for every tool are derived from FILE_MANAGEMENT_SCHEMAS
 * via zodObjectToParamList — the registry in schemas/file-management-schemas.ts
 * is the single source of truth.
 *
 * Pure module — Zod + schema builders only, no electron / runtime imports.
 */

import { FILE_MANAGEMENT_SCHEMAS } from './schemas/file-management-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
  items?: Record<string, unknown>
}

export interface FileManagementToolDef {
  name: string
  description: string
  params: ToolParam[]
}

export const FILE_MANAGEMENT_TOOLS: FileManagementToolDef[] = [
  {
    name: 'file_search',
    description:
      '跨源全局搜索（文档、书签、RSS、日程、Agent 会话）。支持 #tag / [[wikilink]] / "短语" / src:xxx 前缀语法；返回命中清单（path / name / snippet / sourceType / tagsHit / linksHit）。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_search) as ToolParam[],
  },
  {
    name: 'file_locate',
    description:
      '定位文件中的特定锚点。传 path（绝对路径、索引 path、唯一文件名或相对后缀）+ 可选 anchor（章节标题 / 首个命中关键词），返回 { path, line, sectionTitle } 供导航。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_locate) as ToolParam[],
  },
  {
    name: 'file_read_excerpt',
    description:
      '读取 workspace 内文档正文片段。可传 anchor 读取章节，或传 lineStart / lineEnd 读取行号范围；用于基于原文的总结、分析、改写和关系梳理。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_read_excerpt) as ToolParam[],
  },
  {
    name: 'file_get_backlinks',
    description: '列出引用目标文档的所有来源文件（wikilink 反向链接）。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_get_backlinks) as ToolParam[],
  },
  {
    name: 'file_get_graph',
    description:
      '返回索引图谱子图 { nodes, edges }。节点包含 documents / tags / ghost（未解析 wikilink）；边包含 wikilink / mdlink / tag-of。可选指定 centerPath + depth 限制 BFS 范围。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_get_graph) as ToolParam[],
  },
  {
    name: 'file_classify',
    description:
      '为 .md 文件写入/修改 frontmatter 标签与元数据；仅 markdown 文件可用。addTags / removeTags 会与已有 tags 合并，setFrontmatter 覆盖指定键。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_classify) as ToolParam[],
  },
  {
    name: 'file_rename',
    description:
      '重命名文件（路径不变、只改文件名或在同目录内改扩展名）。必须在 workspace 根内；默认不覆盖已有文件。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_rename) as ToolParam[],
  },
  {
    name: 'file_move',
    description:
      '把文件移动到另一个目录，可选同时改名。源路径与目标目录都必须在同一 workspace 根内。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_move) as ToolParam[],
  },
  {
    name: 'file_copy',
    description:
      '把文件复制到另一个目录，可选同时改名。源路径与目标目录都必须在同一 workspace 根内；默认不覆盖已有文件。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_copy) as ToolParam[],
  },
  {
    name: 'file_inventory',
    description:
      '盘点授权文件夹内的文件和子文件夹。支持分页、浅层递归和可选短摘要；用于批量整理前先了解目录内容。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_inventory) as ToolParam[],
  },
  {
    name: 'file_extract_text',
    description:
      '按需抽取授权 workspace 内单个文件的可读文本，支持文本、Markdown、DOCX、XLSX、PDF；返回截断状态和继续读取游标。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_extract_text) as ToolParam[],
  },
  {
    name: 'file_create_folder',
    description:
      '在授权 workspace 根内创建文件夹。只接受相对路径，不允许越界；用于批量整理前创建分类目录。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_create_folder) as ToolParam[],
  },
  {
    name: 'file_organize_preview',
    description:
      '校验批量整理方案并生成预览，不修改磁盘。返回 planId、冲突和待确认操作；执行前必须让用户确认。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_organize_preview) as ToolParam[],
  },
  {
    name: 'file_organize_apply',
    description:
      '执行用户已确认的 file_organize_preview 方案。未确认、过期、有冲突或越界的计划会被拒绝。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_organize_apply) as ToolParam[],
  },
  {
    name: 'file_organize_undo',
    description:
      '撤销一次已执行的批量整理日志。遇到目标冲突或源文件缺失会停止并报告，不删除用户新文件。',
    params: zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_organize_undo) as ToolParam[],
  },
]

export const FILE_MANAGEMENT_TOOL_NAMES = FILE_MANAGEMENT_TOOLS.map((tool) => tool.name)

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  const base: Record<string, unknown> = { type: param.type, description: param.description }
  if (param.type === 'array') base.items = param.items || { type: 'string' }
  return base
}

export function getFileManagementAnthropicTools(): Array<Record<string, unknown>> {
  return FILE_MANAGEMENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getFileManagementOpenAITools(): Array<Record<string, unknown>> {
  return FILE_MANAGEMENT_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}
