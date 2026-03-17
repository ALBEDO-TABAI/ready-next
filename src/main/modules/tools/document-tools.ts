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
    name: 'document_insert_widget',
    description: '向文档插入一个 show-widget 可视化组件代码围栏。',
    action: 'document.insertWidget',
    params: [
      { name: 'title', type: 'string', description: 'widget 标题（建议 snake_case 或简短标题）', required: true },
      { name: 'widgetCode', type: 'string', description: 'widget 的 HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）', required: true },
      { name: 'position', type: 'string', description: '插入位置：append_end 或 after_section', required: true },
      { name: 'sectionTitle', type: 'string', description: '当 position=after_section 时，目标章节标题', required: false },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_list_widgets',
    description: '列出当前文档中的 show-widget 组件，便于后续更新或删除。',
    action: 'document.listWidgets',
    params: [{ name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false }],
  },
  {
    name: 'document_update_widget',
    description: '更新文档中某个已有 widget 的内容，可按标题或序号定位；可选重命名标题。',
    action: 'document.updateWidget',
    params: [
      { name: 'target', type: 'string', description: '目标 widget 标题关键词或 1-based 序号', required: true },
      { name: 'widgetCode', type: 'string', description: '新的 widget HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）', required: true },
      { name: 'title', type: 'string', description: '可选，更新后的新标题', required: false },
      { name: 'occurrence', type: 'number', description: '当标题命中多个 widget 时，指定第几处（从 1 开始）', required: false },
      { name: 'tabId', type: 'string', description: '可选，目标标签 ID', required: false },
    ],
  },
  {
    name: 'document_remove_widget',
    description: '删除文档中某个已有 widget，可按标题或序号定位。',
    action: 'document.removeWidget',
    params: [
      { name: 'target', type: 'string', description: '目标 widget 标题关键词或 1-based 序号', required: true },
      { name: 'occurrence', type: 'number', description: '当标题命中多个 widget 时，指定第几处（从 1 开始）', required: false },
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
    name: 'document_replace_exact',
    description: '精准替换文档中的单个目标片段。若目标出现多次，可传 occurrence 指定第几处（从 1 开始）。',
    action: 'document.replaceExact',
    params: [
      { name: 'target', type: 'string', description: '要精准替换的原文片段', required: true },
      { name: 'replacement', type: 'string', description: '替换后的新内容', required: true },
      { name: 'occurrence', type: 'number', description: '可选，第几处匹配（从 1 开始）', required: false },
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
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
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
  if (toolName === 'document_insert_widget') {
    if (typeof args.title !== 'string' || typeof args.widgetCode !== 'string' || typeof args.position !== 'string') {
      return 'Error: title, widgetCode and position are required'
    }
  }
  if (toolName === 'document_update_widget') {
    if (typeof args.target !== 'string' || typeof args.widgetCode !== 'string') {
      return 'Error: target and widgetCode are required'
    }
  }
  if (toolName === 'document_remove_widget') {
    if (typeof args.target !== 'string') {
      return 'Error: target is required'
    }
  }
  if (toolName === 'document_replace_text') {
    if (typeof args.from !== 'string' || typeof args.to !== 'string') {
      return 'Error: from and to are required'
    }
  }
  if (toolName === 'document_replace_exact') {
    if (typeof args.target !== 'string' || typeof args.replacement !== 'string') {
      return 'Error: target and replacement are required'
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
  if (context?.requestModuleToolAction) {
    try {
      const payload = await context.requestModuleToolAction(tool.action, args)
      const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
      if (summary) return summary
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Document action failed: ${tool.action} - ${message}`
    }
  }
  if (toolName === 'document_open_tab' || toolName === 'document_switch_tab') {
    return `Document navigation queued: ${tool.action}. This does NOT modify content yet.`
  }
  if (toolName === 'document_list_widgets') {
    return `Document inspection queued: ${tool.action}`
  }
  if (
    toolName === 'document_set_content' ||
    toolName === 'document_append_content' ||
    toolName === 'document_insert_widget' ||
    toolName === 'document_update_widget' ||
    toolName === 'document_remove_widget' ||
    toolName === 'document_replace_text' ||
    toolName === 'document_replace_exact' ||
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
