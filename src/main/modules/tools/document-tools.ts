import { basename } from 'node:path'

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
    description: '新建一个文档标签页，可选指定标题或目标保存路径；默认不切换当前可见文档。',
    action: 'document.newTab',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_new_tab) as ToolParam[],
  },
  {
    name: 'document_open_tab',
    description: '按绝对路径准备一个文档文件标签页；默认不切换当前可见文档。',
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
    description: '向文档插入一个 show-widget 可视化组件代码围栏。信息卡/摘要卡/对比卡/图表/关系图/流程图等卡片类内容必须经本工具以 componentSpec 结构化落地（Ready 设计系统渲染）；禁止用 document_replace_text / document_replace_exact 把 markdown 表格或手写 HTML 写进正文冒充卡片。',
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
    name: 'document_read_section',
    description: '读取当前或指定文档标签的正文片段，支持全文、章节/编号标题和行号范围。',
    action: 'document.readSection',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_read_section) as ToolParam[],
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
    description: '在文档中查找并替换文本。仅用于文本修正；插入信息卡/图表等卡片类内容必须改用 document_insert_widget。',
    action: 'document.replaceText',
    params: zodObjectToParamList(DOCUMENT_SCHEMAS.document_replace_text) as ToolParam[],
  },
  {
    name: 'document_replace_exact',
    description: '精准替换文档中的单个目标片段。若目标出现多次，可传 occurrence 指定第几处（从 1 开始）。仅用于文本修正；插入信息卡/图表等卡片类内容必须改用 document_insert_widget。',
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
    description: '保存当前、指定或最近工具目标文档标签，可选直接保存到目标路径。',
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

const DOCUMENT_MUTATION_TOOLS = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
])

function cleanPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function pathFromSaveSummary(summary: string): string | null {
  const match = summary.match(/(?:已保存文档|已另存文档|文档未改动，已跳过保存)[:：]\s*([^\n\r]+)/)
  return cleanPath(match?.[1])
}

function documentArtifact(path: string, createdAt: string): Record<string, unknown> {
  const name = basename(path) || path
  return {
    id: `document-save:${path}`,
    module: 'document',
    kind: 'delivered_file',
    label: name,
    path,
    mimeType: name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain',
    sourceRunId: null,
    createdAt,
    meta: {
      deliverySource: 'document.saveTab',
      deliveryStatus: 'verified',
      requestedTarget: true,
    },
  }
}

function documentMutationFailed(summary: string, data: Record<string, unknown>): boolean {
  const mutationReason = typeof data.mutationReason === 'string' ? data.mutationReason : ''
  if (
    data.ok === false
    || typeof data.errorKind === 'string'
    || mutationReason === 'validation_failed'
    || mutationReason === 'rejected'
    || mutationReason === 'no_match'
    || mutationReason === 'cancelled'
  ) {
    return true
  }
  if (data.mutated === true || mutationReason === 'changed' || data.ok === true) return false
  if (
    'mutated' in data ||
    'ok' in data ||
    Boolean(mutationReason) ||
    'documentTabId' in data ||
    'documentTitle' in data ||
    'documentSaveState' in data ||
    'documentDirty' in data
  ) {
    return false
  }
  return /(?:^Error:|Document action failed|failed|失败|无法|没有可|未匹配到|未找到|缺少|已拒绝|被拒绝|已取消|被取消)/i.test(summary)
}

function documentMutationSkipped(data: Record<string, unknown>): boolean {
  const mutationReason = typeof data.mutationReason === 'string' ? data.mutationReason : ''
  return data.mutated === false
    && (mutationReason === 'identical' || mutationReason === 'not_mutation')
}

function documentProjectionPatch(toolName: string, summary: string, data: Record<string, unknown>): Record<string, unknown> | null {
  const now = new Date().toISOString()
  if (toolName === 'document_new_tab') {
    return {
      taskTitle: '正在创建文档',
      taskSummary: summary,
      steps: [{ id: 'document_create', title: '已创建文档', status: 'done', updatedAt: now }],
      currentStepId: 'document_create',
      waitingFor: 'none',
    }
  }
  if (DOCUMENT_MUTATION_TOOLS.has(toolName)) {
    if (documentMutationFailed(summary, data)) {
      return {
        taskTitle: '文档写入失败',
        taskSummary: summary,
        steps: [{ id: 'document_write', title: '写入内容失败', status: 'error', updatedAt: now }],
        currentStepId: 'document_write',
        waitingFor: 'none',
      }
    }
    if (documentMutationSkipped(data)) {
      return {
        taskTitle: '文档未改动',
        taskSummary: summary,
        steps: [{ id: 'document_write', title: '无需写入内容', status: 'done', updatedAt: now }],
        currentStepId: 'document_write',
        waitingFor: 'none',
      }
    }
    return {
      taskTitle: '正在写入文档',
      taskSummary: summary,
      steps: [{ id: 'document_write', title: '已写入内容', status: 'done', updatedAt: now }],
      currentStepId: 'document_write',
      waitingFor: 'none',
    }
  }
  if (toolName !== 'document_save_tab') return null

  const saved = data.documentSaved === true
  const skippedSave = /文档未改动，已跳过保存/.test(summary)
  if (!saved) {
    if (skippedSave) {
      return {
        taskTitle: '文档未改动',
        taskSummary: summary,
        steps: [{ id: 'document_save', title: '无需保存到指定目录', status: 'done', updatedAt: now }],
        currentStepId: 'document_save',
        waitingFor: 'none',
      }
    }
    return {
      taskTitle: '文档保存失败',
      taskSummary: summary,
      steps: [{ id: 'document_save', title: '保存到指定目录失败', status: 'error', updatedAt: now }],
      currentStepId: 'document_save',
      waitingFor: 'none',
    }
  }
  const path = cleanPath(data.path)
    || cleanPath(data.savedPath)
    || cleanPath(data.documentPath)
    || pathFromSaveSummary(summary)
  const artifact = path ? documentArtifact(path, now) : null
  return {
    taskTitle: '文档已保存',
    taskSummary: path ? `已保存到 ${path}` : summary,
    steps: [{ id: 'document_save', title: '已保存到指定目录', status: 'done', updatedAt: now }],
    currentStepId: 'document_save',
    waitingFor: 'none',
    ...(artifact ? { recentArtifacts: [artifact], artifactRefs: [artifact] } : {}),
  }
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
        const projectionPatch = documentProjectionPatch(toolName, summary, data)
        const hasData = Object.keys(data).length > 0
        return hasData || projectionPatch
          ? createToolExecutionOutput(summary, { shape: hasData ? 'json' : undefined, data: hasData ? data : null, projectionPatch })
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
  if (toolName === 'document_list_widgets' || toolName === 'document_read_section') {
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
