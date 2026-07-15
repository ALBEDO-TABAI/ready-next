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
      '定位文件中的特定锚点。传 path（绝对路径、索引 path、唯一文件名或相对后缀）+ 可选 anchor（章节标题 / 首个命中关键词），返回 { path, line, sectionTitle } 供导航。',
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
    name: 'file_read_excerpt',
    description:
      '读取 workspace 内文档正文片段。可传 anchor 读取章节，或传 lineStart / lineEnd 读取行号范围；用于基于原文的总结、分析、改写和关系梳理。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或索引内 path' },
        anchor: {
          type: 'string',
          description: '可选：章节标题或关键词；命中标题时读取该章节',
        },
        lineStart: { type: 'number', description: '可选：起始行号（从 1 开始）' },
        lineEnd: { type: 'number', description: '可选：结束行号（包含该行）' },
        maxChars: {
          type: 'number',
          description: '可选：最大返回字符数（默认 32000，上限 40000）',
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
    name: 'tag_forge_prepare_batch',
    description: 'Tag Forge 文件夹批量打标的唯一准备入口。首次传 rootPath 会读取文件夹内全部 Markdown，续跑只传 batchId；返回正文、不透明 itemId、版本凭证、当前受控词表和进度。',
    input_schema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '新建批次时必需：要批量打标的授权文件夹绝对路径' },
        batchId: { type: 'string', description: '继续既有批次时传入上一轮 batchId' },
        limit: { type: 'number', description: '本批返回的待处理文档数（默认 4，上限 4，并受正文总量限制）' },
      },
      required: [],
    },
  },
  {
    name: 'tag_forge_apply_batch',
    description: '按 prepare 返回的 itemId 和版本凭证写回多份 Markdown 内容标签。可靠标签立即写入；原文可核对的高置信新词自动采用；扫描完整个文件夹后，真正存疑的新词由宿主在 Agent 对话中集中确认一次。',
    input_schema: {
      type: 'object',
      properties: {
        batchId: { type: 'string', description: 'tag_forge_prepare_batch 返回的批次 id' },
        items: {
          type: 'array',
          description: '本批每份文档的版本凭证和带正文证据的完整标签提案',
          items: {
            type: 'object',
            properties: {
              itemId: {
                type: 'string',
                description: 'prepare 返回的不透明文档 id；不要改写或用文件路径代替',
              },
              expectedRevision: {
                type: 'string',
                description: 'prepare 返回的版本凭证；必须原样回传',
              },
              proposals: {
                minItems: 1,
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    facet: {
                      type: 'string',
                      enum: ['form', 'domain', 'entity', 'use'],
                      description: '内容标签分面；工作流状态不属于标签提案',
                    },
                    label: { type: 'string', description: '归一后的标签名' },
                    evidenceCode: {
                      type: 'string',
                      description: '短证据类型，例如 title_topic 或 body_topic',
                    },
                    evidenceExcerpt: {
                      type: 'string',
                      minLength: 2,
                      description: '原文中的准确短摘录；每个内容标签都必需',
                    },
                    confidence: {
                      type: 'number',
                      description: '0 到 1；>=0.92 且证据可回查的新领域/实体/用途可自动采用',
                    },
                  },
                  required: ['facet', 'label', 'evidenceCode', 'evidenceExcerpt', 'confidence'],
                  additionalProperties: false,
                },
                description: '本文档的完整内容标签提案；每项都必须带正文证据',
              },
            },
            required: ['itemId', 'expectedRevision', 'proposals'],
            additionalProperties: false,
          },
        },
      },
      required: ['batchId', 'items'],
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
  // Golden re-recorded for file_copy — added intentionally in ab524cc0
  // (skill delivery adjudication: controlled same-root egress for artifacts),
  // together with its schema, tool defs, and file-management-copy-contract.test.ts.
  {
    name: 'file_copy',
    description:
      '把文件复制到另一个目录，可选同时改名。源路径与目标目录都必须在同一 workspace 根内；默认不覆盖已有文件。',
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
  {
    name: 'file_inventory',
    description:
      '盘点授权文件夹内的文件和子文件夹。支持分页、浅层递归和可选短摘要；用于批量整理前先了解目录内容。',
    input_schema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '要盘点的授权文件夹绝对路径' },
        cursor: { type: 'string', description: '可选：上一页返回的 nextCursor' },
        limit: { type: 'number', description: '可选：返回上限（默认 100，上限 500）' },
        recursive: { type: 'boolean', description: '可选：是否递归扫描（默认 false）' },
        maxDepth: { type: 'number', description: '可选：递归最大深度（默认 2，上限 5）' },
        includeSummaries: { type: 'boolean', description: '可选：是否为支持的文件返回短摘要（默认 false）' },
      },
      required: ['rootPath'],
    },
  },
  {
    name: 'file_extract_text',
    description:
      '按需抽取授权 workspace 内单个文件的可读文本，支持文本、Markdown、DOCX、XLSX、PDF；返回截断状态和继续读取游标。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要抽取文本的文件绝对路径' },
        offset: { type: 'number', description: '可选：从第几个字符开始返回（默认 0）' },
        maxChars: { type: 'number', description: '可选：最大返回字符数（默认 20000，上限 40000）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_create_folder',
    description:
      '在授权 workspace 根内创建文件夹。只接受相对路径，不允许越界；用于批量整理前创建分类目录。',
    input_schema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '授权工作区根目录绝对路径' },
        relativePath: { type: 'string', description: '要创建的相对文件夹路径' },
      },
      required: ['rootPath', 'relativePath'],
    },
  },
  {
    name: 'file_organize_preview',
    description:
      '校验批量整理方案并生成预览，不修改磁盘。返回 planId、冲突和待确认操作；执行前必须让用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '授权工作区根目录绝对路径' },
        createFolders: {
          type: 'array',
          description: '要创建的相对文件夹路径列表',
          items: { type: 'string' },
        },
        operations: {
          type: 'array',
          description: '要预览的移动/改名操作列表',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '原文件绝对路径' },
              destDir: { type: 'string', description: '目标目录绝对路径' },
              newName: { type: 'string', description: '可选：新文件名' },
            },
            required: ['path', 'destDir'],
            additionalProperties: false,
          },
        },
      },
      required: ['rootPath', 'operations'],
    },
  },
  {
    name: 'file_organize_apply',
    description:
      '执行用户已确认的 file_organize_preview 方案。未确认、过期、有冲突或越界的计划会被拒绝。',
    input_schema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'file_organize_preview 返回的 planId' },
        confirmed: { type: 'boolean', description: '用户已确认该预览方案时传 true' },
        confirmedVia: { type: 'string', description: '确认来源' },
      },
      required: ['planId', 'confirmed', 'confirmedVia'],
    },
  },
  {
    name: 'file_organize_undo',
    description:
      '撤销一次已执行的批量整理日志。遇到目标冲突或源文件缺失会停止并报告，不删除用户新文件。',
    input_schema: {
      type: 'object',
      properties: {
        journalId: { type: 'string', description: 'file_organize_apply 返回的 journalId' },
      },
      required: ['journalId'],
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
