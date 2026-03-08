interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
}

interface VideoToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic' | 'job'
  params: ToolParam[]
}

interface VideoToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
}

const VIDEO_TOOLS: VideoToolDef[] = [
  {
    name: 'video_import_media',
    description: '导入一个媒体文件到视频项目时间线，并切换到剪辑模式。',
    action: 'video.importMedia',
    intent: 'import_video_media',
    executionKind: 'deterministic',
    params: [{ name: 'path', type: 'string', description: '媒体文件绝对路径', required: true }],
  },
  {
    name: 'video_inspect_media',
    description: '读取媒体信息并返回时长、分辨率、音视频流等元数据。',
    action: 'video.inspectMedia',
    intent: 'inspect_video_media',
    executionKind: 'deterministic',
    params: [{ name: 'path', type: 'string', description: '可选，媒体文件绝对路径', required: false }],
  },
  {
    name: 'video_render_export',
    description: '导出当前视频时间线为成片文件。',
    action: 'video.renderExport',
    intent: 'render_video_export',
    executionKind: 'job',
    params: [{ name: 'outputPath', type: 'string', description: '可选，输出路径', required: false }],
  },
  {
    name: 'video_capture_session',
    description: '读取当前视频项目会话快照、时间线摘要和渲染状态。',
    action: 'video.captureSession',
    intent: 'capture_video_session',
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

function toStructuredResult(tool: VideoToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    module: 'video',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  })
}

export function getVideoAnthropicTools(): Array<Record<string, unknown>> {
  return VIDEO_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getVideoOpenAITools(): Array<Record<string, unknown>> {
  return VIDEO_TOOLS.map((tool) => ({
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

export async function executeVideoTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: VideoToolContext,
): Promise<string> {
  const tool = VIDEO_TOOLS.find((item) => item.name === toolName)
  if (!tool) return `Unknown video tool: ${toolName}`

  if (toolName === 'video_import_media') {
    const path = String(args.path || '').trim()
    if (!path) return 'Error: path is required'
  }

  context?.emitToolAction?.(tool.action, args)

  return toStructuredResult(tool, `${tool.action} 已排队执行。`, {
    ownerResourceId: typeof args.path === 'string' ? args.path : null,
  })
}
