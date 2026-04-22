/**
 * Golden snapshot for file_management domain (Phase 2.5 PR 6).
 * Commit BEFORE swapping file-management-tools.ts to Zod-derived params.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

// Pulled from the pure defs module (not file-management-tools.ts) so tests
// don't drag in search-engine/ipc-handler's electron imports.
import {
  getFileManagementAnthropicTools,
  getFileManagementOpenAITools,
} from '../main/modules/tools/file-management-tool-defs'

const EXPECTED_ANTHROPIC = [
  {
    name: 'file_search',
    description:
      '跨源全局搜索（文档、书签、RSS、日程、Agent 会话）。支持 #tag / [[wikilink]] / "短语" / src:xxx 前缀语法；返回命中清单（path / name / snippet / sourceType / tagsHit / linksHit）。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索表达式；例如 "#project src:document keyword"',
        },
        sources: {
          type: 'array',
          description:
            '可选，过滤到指定 sourceType 列表（document / bookmark / rss / calendar / agent）',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: '返回上限（默认 20）' },
        workspaceRoot: { type: 'string', description: '可选，限定 workspace 根' },
      },
      required: ['query'],
    },
  },
  {
    name: 'file_locate',
    description:
      '定位文件中的特定锚点。传 path + 可选 anchor（章节标题 / 首个命中关键词），返回 { path, line, sectionTitle } 供导航。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或索引内 path' },
        anchor: {
          type: 'string',
          description: '可选：目标章节标题或关键词；不传则返回首行',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_get_backlinks',
    description: '列出引用目标文档的所有来源文件（wikilink 反向链接）。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径' },
        limit: { type: 'number', description: '返回上限（默认 50）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_get_graph',
    description:
      '返回索引图谱子图 { nodes, edges }。节点包含 documents / tags / ghost（未解析 wikilink）；边包含 wikilink / mdlink / tag-of。可选指定 centerPath + depth 限制 BFS 范围。',
    input_schema: {
      type: 'object',
      properties: {
        centerPath: { type: 'string', description: '可选，作为 BFS 起点的路径' },
        depth: { type: 'number', description: 'BFS 深度（默认 2）' },
        workspaceRoot: { type: 'string', description: '可选，限定 workspace 根' },
      },
      required: [],
    },
  },
  {
    name: 'file_classify',
    description:
      '为 .md 文件写入/修改 frontmatter 标签与元数据；仅 markdown 文件可用。addTags / removeTags 会与已有 tags 合并，setFrontmatter 覆盖指定键。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '.md 文件绝对路径' },
        addTags: {
          type: 'array',
          description: '要新增的标签数组',
          items: { type: 'string' },
        },
        removeTags: {
          type: 'array',
          description: '要移除的标签数组',
          items: { type: 'string' },
        },
        setFrontmatter: { type: 'object', description: '要覆盖的 frontmatter 键值对' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_rename',
    description:
      '重命名文件（路径不变、只改文件名或在同目录内改扩展名）。必须在 workspace 根内；默认不覆盖已有文件。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '原文件绝对路径' },
        newName: { type: 'string', description: '新文件名（含扩展名，不含目录）' },
        overwrite: {
          type: 'boolean',
          description: '可选：目标已存在时是否覆盖（默认 false）',
        },
      },
      required: ['path', 'newName'],
    },
  },
  {
    name: 'file_move',
    description:
      '把文件移动到另一个目录，可选同时改名。源路径与目标目录都必须在同一 workspace 根内。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '原文件绝对路径' },
        destDir: { type: 'string', description: '目标目录绝对路径' },
        newName: { type: 'string', description: '可选：新文件名' },
        overwrite: {
          type: 'boolean',
          description: '可选：目标存在时是否覆盖（默认 false）',
        },
      },
      required: ['path', 'destDir'],
    },
  },
]

test('getFileManagementAnthropicTools matches the locked LLM-facing payload', () => {
  assert.deepEqual(getFileManagementAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getFileManagementOpenAITools matches the locked LLM-facing payload', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getFileManagementOpenAITools(), expected)
})
