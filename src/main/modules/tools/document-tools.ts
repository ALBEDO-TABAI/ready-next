import { DOCUMENT_SCHEMAS } from './schemas/document-schemas'
import { zodObjectToParamList } from './zod-param-derivation'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tools-runtime/tool-error-metrics'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'

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
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_new_tab) as ToolParam[],
  },
  {
    name: 'document_open_tab',
    description: '按绝对路径打开一个文档文件标签页。',
    action: 'document.openTab',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_open_tab) as ToolParam[],
  },
  {
    name: 'document_switch_tab',
    description: '切换当前文档标签页，可传 tabId / 标题 / 序号。',
    action: 'document.switchTab',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_switch_tab) as ToolParam[],
  },
  {
    name: 'document_rename_tab',
    description: '重命名文档标签页。',
    action: 'document.renameTab',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_rename_tab) as ToolParam[],
  },
  {
    name: 'document_set_content',
    description: '覆盖写入文档内容。',
    action: 'document.setContent',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_set_content) as ToolParam[],
  },
  {
    name: 'document_append_content',
    description: '向文档尾部追加内容。',
    action: 'document.appendContent',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_append_content) as ToolParam[],
  },
  {
    name: 'document_insert_widget',
    description: '向文档插入一个 show-widget 可视化组件代码围栏。',
    action: 'document.insertWidget',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_insert_widget) as ToolParam[],
  },
  {
    name: 'document_list_widgets',
    description: '列出当前文档中的 show-widget 组件，便于后续更新或删除。',
    action: 'document.listWidgets',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_list_widgets) as ToolParam[],
  },
  {
    name: 'document_update_widget',
    description: '更新文档中某个已有 widget 的内容，可按标题或序号定位；可选重命名标题。重要：必须保留目标 widget 根元素已声明的宽高与纵横比（例如原先 1080×1920 的 9:16 竖版卡片就不能改成 1920×1080 的 16:9 或在底部追加一个 16:9 的背景块），避免导出图片尺寸与原卡片不一致。',
    action: 'document.updateWidget',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_update_widget) as ToolParam[],
  },
  {
    name: 'document_remove_widget',
    description: '删除文档中某个已有 widget，可按标题或序号定位。',
    action: 'document.removeWidget',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_remove_widget) as ToolParam[],
  },
  {
    name: 'document_replace_text',
    description: '在文档中查找并替换文本。',
    action: 'document.replaceText',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_replace_text) as ToolParam[],
  },
  {
    name: 'document_replace_exact',
    description: '精准替换文档中的单个目标片段。若目标出现多次，可传 occurrence 指定第几处（从 1 开始）。',
    action: 'document.replaceExact',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_replace_exact) as ToolParam[],
  },
  {
    name: 'document_format_section',
    description: '按章节标题定位并仅优化排版/格式，不改变原意；若找不到章节则不做修改。',
    action: 'document.formatSection',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_format_section) as ToolParam[],
  },
  {
    name: 'document_rewrite_section',
    description: '按章节标题定位并重写该章节内容；若找不到章节则不做修改。',
    action: 'document.rewriteSection',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_rewrite_section) as ToolParam[],
  },
  {
    name: 'document_save_tab',
    description: '保存当前或指定文档标签。',
    action: 'document.saveTab',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_save_tab) as ToolParam[],
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
): Promise<string | ToolExecutionOutput> {
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
    const hasWidgetCode = typeof args.widgetCode === 'string' && args.widgetCode.trim().length > 0
    const hasComponentSpec = !!args.componentSpec && typeof args.componentSpec === 'object'
    if (typeof args.title !== 'string' || typeof args.position !== 'string' || (!hasWidgetCode && !hasComponentSpec)) {
      return 'Error: title, position, and either widgetCode or componentSpec are required'
    }
  }
  if (toolName === 'document_update_widget') {
    const hasWidgetCode = typeof args.widgetCode === 'string' && args.widgetCode.trim().length > 0
    const hasComponentSpec = !!args.componentSpec && typeof args.componentSpec === 'object'
    const hasComponentSpecPatch = !!args.componentSpecPatch && typeof args.componentSpecPatch === 'object'
    if (typeof args.target !== 'string' || (!hasWidgetCode && !hasComponentSpec && !hasComponentSpecPatch)) {
      return 'Error: target and either widgetCode, componentSpec, or componentSpecPatch are required'
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
      if (summary) {
        const data = { ...payload }
        delete data.summary
        delete data.intent
        if (data.errorKind === 'widget_boundary_violation') {
          logAgentMetric(TOOL_ERROR_METRICS.widgetBoundaryViolation, {
            toolName,
            action: tool.action,
          })
        }
        return Object.keys(data).length > 0
          ? createToolExecutionOutput(summary, { shape: 'json', data })
          : summary
      }
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
