/**
 * Golden snapshot for document domain LLM-facing schemas (Phase 2.5 PR 7).
 * Commit BEFORE swapping document-tools.ts params to Zod-derived.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getDocumentAnthropicTools,
  getDocumentOpenAITools,
} from '../main/modules/tools/document-tools'

const TAB_ID = { type: 'string', description: '可选，目标标签 ID' }

const EXPECTED_ANTHROPIC = [
  {
    name: 'document_new_tab',
    description: '在文档模式中新建一个标签页，可选指定标题。',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', description: '新标签标题（可选）' } },
      required: [],
    },
  },
  {
    name: 'document_open_tab',
    description: '按绝对路径打开一个文档文件标签页。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文档绝对路径' } },
      required: ['path'],
    },
  },
  {
    name: 'document_switch_tab',
    description: '切换当前文档标签页，可传 tabId / 标题 / 序号。',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'tabId、标题关键词或序号' } },
      required: ['target'],
    },
  },
  {
    name: 'document_rename_tab',
    description: '重命名文档标签页。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '新标题' },
        tabId: TAB_ID,
      },
      required: ['title'],
    },
  },
  {
    name: 'document_set_content',
    description: '覆盖写入文档内容。',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '完整文档内容' },
        tabId: TAB_ID,
      },
      required: ['content'],
    },
  },
  {
    name: 'document_append_content',
    description: '向文档尾部追加内容。',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要追加的内容' },
        tabId: TAB_ID,
      },
      required: ['content'],
    },
  },
  {
    name: 'document_insert_widget',
    description: '向文档插入一个 show-widget 可视化组件代码围栏。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'widget 标题（建议 snake_case 或简短标题）' },
        widgetCode: {
          type: 'string',
          description:
            '可选：直接提供 widget 的 HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）',
        },
        componentSpec: {
          type: 'object',
          description:
            '可选：结构化 OpenUI 组件规格，例如 { component, props?, dataSource? }。优先使用它而不是自由 HTML。',
        },
        position: { type: 'string', description: '插入位置：append_end 或 after_section' },
        sectionTitle: {
          type: 'string',
          description: '当 position=after_section 时，目标章节标题',
        },
        tabId: TAB_ID,
      },
      required: ['title', 'position'],
    },
  },
  {
    name: 'document_list_widgets',
    description: '列出当前文档中的 show-widget 组件，便于后续更新或删除。',
    input_schema: {
      type: 'object',
      properties: { tabId: TAB_ID },
      required: [],
    },
  },
  {
    name: 'document_update_widget',
    description:
      '更新文档中某个已有 widget 的内容，可按标题或序号定位；可选重命名标题。重要：必须保留目标 widget 根元素已声明的宽高与纵横比（例如原先 1080×1920 的 9:16 竖版卡片就不能改成 1920×1080 的 16:9 或在底部追加一个 16:9 的背景块），避免导出图片尺寸与原卡片不一致。',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标 widget 标题关键词或 1-based 序号' },
        widgetCode: {
          type: 'string',
          description:
            '可选：新的 widget HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）',
        },
        componentSpec: {
          type: 'object',
          description:
            '可选：结构化 OpenUI 组件规格，例如 { component, props?, dataSource? }。优先使用它而不是自由 HTML。',
        },
        componentSpecPatch: {
          type: 'object',
          description:
            '可选：仅包含变更字段的 componentSpec patch。适合在已有结构化 widget 上做小改。',
        },
        title: { type: 'string', description: '可选，更新后的新标题' },
        occurrence: {
          type: 'number',
          description: '当标题命中多个 widget 时，指定第几处（从 1 开始）',
        },
        tabId: TAB_ID,
      },
      required: ['target'],
    },
  },
  {
    name: 'document_remove_widget',
    description: '删除文档中某个已有 widget，可按标题或序号定位。',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标 widget 标题关键词或 1-based 序号' },
        occurrence: {
          type: 'number',
          description: '当标题命中多个 widget 时，指定第几处（从 1 开始）',
        },
        tabId: TAB_ID,
      },
      required: ['target'],
    },
  },
  {
    name: 'document_replace_text',
    description: '在文档中查找并替换文本。',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '要替换的原文' },
        to: { type: 'string', description: '替换后的文本' },
        tabId: TAB_ID,
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'document_replace_exact',
    description:
      '精准替换文档中的单个目标片段。若目标出现多次，可传 occurrence 指定第几处（从 1 开始）。',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要精准替换的原文片段' },
        replacement: { type: 'string', description: '替换后的新内容' },
        occurrence: {
          type: 'number',
          description: '可选，第几处匹配（从 1 开始）',
        },
        tabId: TAB_ID,
      },
      required: ['target', 'replacement'],
    },
  },
  {
    name: 'document_format_section',
    description: '按章节标题定位并仅优化排版/格式，不改变原意；若找不到章节则不做修改。',
    input_schema: {
      type: 'object',
      properties: {
        sectionTitle: { type: 'string', description: '章节标题（例如：引言、第二部分）' },
        style: { type: 'string', description: '可选，格式化风格（默认 readable）' },
        tabId: TAB_ID,
      },
      required: ['sectionTitle'],
    },
  },
  {
    name: 'document_rewrite_section',
    description: '按章节标题定位并重写该章节内容；若找不到章节则不做修改。',
    input_schema: {
      type: 'object',
      properties: {
        sectionTitle: { type: 'string', description: '章节标题（例如：引言、第二部分）' },
        content: { type: 'string', description: '章节完整新内容（不含标题行）' },
        tabId: TAB_ID,
      },
      required: ['sectionTitle', 'content'],
    },
  },
  {
    name: 'document_save_tab',
    description: '保存当前或指定文档标签。',
    input_schema: {
      type: 'object',
      properties: { tabId: TAB_ID },
      required: [],
    },
  },
]

test('getDocumentAnthropicTools matches the locked LLM-facing payload', () => {
  assert.deepEqual(getDocumentAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getDocumentOpenAITools matches the locked LLM-facing payload', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getDocumentOpenAITools(), expected)
})
