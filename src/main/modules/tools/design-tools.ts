interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
}

interface DesignToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic' | 'interactive'
  params: ToolParam[]
}

interface DesignToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
}

const DESIGN_TOOLS: DesignToolDef[] = [
  {
    name: 'design_open_file',
    description: '打开一个现有 .tldr 设计文件并切换到设计模式。',
    action: 'design.openFile',
    intent: 'open_design_file',
    executionKind: 'deterministic',
    params: [{ name: 'path', type: 'string', description: '设计文件绝对路径', required: true }],
  },
  {
    name: 'design_create_text',
    description: '在当前设计画布上创建一个文本元素。',
    action: 'design.createText',
    intent: 'create_design_element',
    executionKind: 'interactive',
    params: [
      { name: 'text', type: 'string', description: '文本内容', required: true },
      { name: 'x', type: 'number', description: '可选，x 坐标', required: false },
      { name: 'y', type: 'number', description: '可选，y 坐标', required: false },
    ],
  },
  {
    name: 'design_save_project',
    description: '保存当前设计项目；如未绑定文件可指定 path。',
    action: 'design.saveProject',
    intent: 'save_design_project',
    executionKind: 'deterministic',
    params: [{ name: 'path', type: 'string', description: '可选，目标设计文件路径', required: false }],
  },
  {
    name: 'design_export_artifact',
    description: '将当前设计导出为 PNG 或 SVG。',
    action: 'design.exportArtifact',
    intent: 'export_design_artifact',
    executionKind: 'deterministic',
    params: [
      { name: 'format', type: 'string', description: 'png 或 svg', required: true },
      { name: 'path', type: 'string', description: '可选，导出路径', required: false },
      { name: 'defaultName', type: 'string', description: '可选，默认文件名', required: false },
    ],
  },
  {
    name: 'design_capture_session',
    description: '读取当前设计会话快照，包括文件、选区和导出状态。',
    action: 'design.captureSession',
    intent: 'capture_design_session',
    executionKind: 'deterministic',
    params: [],
  },
]

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  return {
    type: param.type,
    description: param.description,
  }
}

function toStructuredResult(tool: DesignToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    module: 'design',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  })
}

export function getDesignAnthropicTools(): Array<Record<string, unknown>> {
  return DESIGN_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getDesignOpenAITools(): Array<Record<string, unknown>> {
  return DESIGN_TOOLS.map((tool) => ({
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

export async function executeDesignTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: DesignToolContext,
): Promise<string> {
  const tool = DESIGN_TOOLS.find((item) => item.name === toolName)
  if (!tool) return `Unknown design tool: ${toolName}`

  if (toolName === 'design_open_file') {
    const path = String(args.path || '').trim()
    if (!path) return 'Error: path is required'
  }

  if (toolName === 'design_create_text') {
    const text = String(args.text || '').trim()
    if (!text) return 'Error: text is required'
  }

  if (toolName === 'design_export_artifact') {
    const format = String(args.format || '').trim().toLowerCase()
    if (format !== 'png' && format !== 'svg') return 'Error: format must be png or svg'
  }

  context?.emitToolAction?.(tool.action, args)

  if (toolName === 'design_capture_session') {
    return toStructuredResult(tool, '设计会话快照请求已发送。')
  }

  return toStructuredResult(tool, `${tool.action} 已排队执行。`, {
    ownerResourceId: typeof args.path === 'string' ? args.path : null,
  })
}
