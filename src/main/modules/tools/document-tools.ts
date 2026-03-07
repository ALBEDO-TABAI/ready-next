interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
}

interface DocumentToolDef {
  name: string
  description: string
  action: string
  params: ToolParam[]
}

const DOCUMENT_TOOLS: DocumentToolDef[] = [
  {
    name: 'document_new_tab',
    description: '在文档模式中新建一个标签页，可选指定标题。',
    action: 'document.newTab',
    params: [{ name: 'title', type: 'string', description: '新标签标题（可选）', required: false }],
  },
  {
    name: 'document_open_tab',
    description: '按绝对路径打开一个文档文件标签页。',
    action: 'document.openTab',
    params: [{ name: 'path', type: 'string', description: '文档绝对路径', required: true }],
  },
  {
    name: 'document_switch_tab',
    description: '切换当前文档标签页，可传 tabId / 标题 / 序号。',
    action: 'document.switchTab',
    params: [{ name: 'target', type: 'string', description: 'tabId、标题关键词或序号', required: true }],
  },
  {
    name: 'document_rename_tab',
    description: '重命名文档标签页。',
    action: 'document.renameTab',
    params: [
      { name: 'title', type: 'string', description: '新标题', required: true },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_set_content',
    description: '覆盖写入文档内容。',
    action: 'document.setContent',
    params: [
      { name: 'content', type: 'string', description: '完整文档内容', required: true },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_append_content',
    description: '向文档尾部追加内容。',
    action: 'document.appendContent',
    params: [
      { name: 'content', type: 'string', description: '要追加的内容', required: true },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_replace_text',
    description: '在文档中查找并替换文本。',
    action: 'document.replaceText',
    params: [
      { name: 'from', type: 'string', description: '要替换的原文', required: true },
      { name: 'to', type: 'string', description: '替换后的文本', required: true },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_format_section',
    description: '按章节标题定位并仅优化排版/格式，不改变原意；若找不到章节则不做修改。',
    action: 'document.formatSection',
    params: [
      { name: 'sectionTitle', type: 'string', description: '章节标题（例如：引言、第二部分）', required: true },
      { name: 'style', type: 'string', description: '可选，格式化风格（默认 readable）', required: false },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_rewrite_section',
    description: '按章节标题定位并重写该章节内容；若找不到章节则不做修改。',
    action: 'document.rewriteSection',
    params: [
      { name: 'sectionTitle', type: 'string', description: '章节标题（例如：引言、第二部分）', required: true },
      { name: 'content', type: 'string', description: '章节完整新内容（不含标题行）', required: true },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_save_tab',
    description: '保存当前或指定文档标签。',
    action: 'document.saveTab',
    params: [{ name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false }],
  },
]

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  return {
    type: param.type,
    description: param.description,
  }
}

export function getDocumentAnthropicTools(): Array<Record<string, unknown>> {
  return DOCUMENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getDocumentOpenAITools(): Array<Record<string, unknown>> {
  return DOCUMENT_TOOLS.map((tool) => ({
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

interface DocumentToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
}

export async function executeDocumentTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: DocumentToolContext,
): Promise<string> {
  const tool = DOCUMENT_TOOLS.find((item) => item.name === toolName)
  if (!tool) return `Unknown document tool: ${toolName}`

  if (toolName === 'document_open_tab') {
    const path = String(args.path || '').trim()
    if (!path) return 'Error: path is required'
  }
  if (toolName === 'document_switch_tab') {
    const target = String(args.target || '').trim()
    if (!target) return 'Error: target is required'
  }
  if (toolName === 'document_rename_tab') {
    const title = String(args.title || '').trim()
    if (!title) return 'Error: title is required'
  }
  if (toolName === 'document_set_content' || toolName === 'document_append_content') {
    if (typeof args.content !== 'string') return 'Error: content is required'
  }
  if (toolName === 'document_replace_text') {
    if (typeof args.from !== 'string' || typeof args.to !== 'string') {
      return 'Error: from and to are required'
    }
  }
  if (toolName === 'document_format_section') {
    if (typeof args.sectionTitle !== 'string') {
      return 'Error: sectionTitle is required'
    }
  }
  if (toolName === 'document_rewrite_section') {
    if (typeof args.sectionTitle !== 'string' || typeof args.content !== 'string') {
      return 'Error: sectionTitle and content are required'
    }
  }

  context?.emitToolAction?.(tool.action, args)
  if (toolName === 'document_open_tab' || toolName === 'document_switch_tab') {
    return `Document navigation queued: ${tool.action}. This does NOT modify content yet.`
  }
  if (
    toolName === 'document_set_content' ||
    toolName === 'document_append_content' ||
    toolName === 'document_replace_text' ||
    toolName === 'document_format_section' ||
    toolName === 'document_rewrite_section'
  ) {
    return `Document content mutation queued: ${tool.action}`
  }
  if (toolName === 'document_save_tab') {
    return `Document save queued: ${tool.action}`
  }
  return `Document action queued: ${tool.action}`
}
