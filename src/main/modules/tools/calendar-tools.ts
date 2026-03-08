interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
}

interface CalendarToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic'
  params: ToolParam[]
}

interface CalendarToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
}

const CALENDAR_TOOLS: CalendarToolDef[] = [
  {
    name: 'calendar_list_window',
    description: '读取某个时间窗口内的日程事件。',
    action: 'calendar.listWindow',
    intent: 'list_calendar_window',
    executionKind: 'deterministic',
    params: [
      { name: 'start', type: 'string', description: '开始时间 ISO 字符串', required: true },
      { name: 'end', type: 'string', description: '结束时间 ISO 字符串', required: true },
    ],
  },
  {
    name: 'calendar_create_event',
    description: '创建一个新的日程事件。',
    action: 'calendar.createEvent',
    intent: 'create_calendar_event',
    executionKind: 'deterministic',
    params: [
      { name: 'title', type: 'string', description: '事件标题', required: true },
      { name: 'startTime', type: 'string', description: '开始时间 ISO 字符串', required: true },
      { name: 'endTime', type: 'string', description: '结束时间 ISO 字符串', required: true },
      { name: 'calendarId', type: 'string', description: '目标日历 ID', required: false },
      { name: 'description', type: 'string', description: '事件描述', required: false },
    ],
  },
  {
    name: 'calendar_update_event',
    description: '更新一个现有日程事件。',
    action: 'calendar.updateEvent',
    intent: 'update_calendar_event',
    executionKind: 'deterministic',
    params: [
      { name: 'id', type: 'string', description: '事件 ID', required: true },
      { name: 'title', type: 'string', description: '可选，更新后的标题', required: false },
      { name: 'startTime', type: 'string', description: '可选，新的开始时间 ISO 字符串', required: false },
      { name: 'endTime', type: 'string', description: '可选，新的结束时间 ISO 字符串', required: false },
      { name: 'description', type: 'string', description: '可选，新的事件描述', required: false },
    ],
  },
  {
    name: 'calendar_delete_event',
    description: '删除一个日程事件。',
    action: 'calendar.deleteEvent',
    intent: 'delete_calendar_event',
    executionKind: 'deterministic',
    params: [{ name: 'id', type: 'string', description: '事件 ID', required: true }],
  },
  {
    name: 'calendar_capture_session',
    description: '读取当前日程模块会话快照、时间窗口和选中事件。',
    action: 'calendar.captureSession',
    intent: 'capture_calendar_session',
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

function toStructuredResult(tool: CalendarToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    module: 'calendar',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  })
}

export function getCalendarAnthropicTools(): Array<Record<string, unknown>> {
  return CALENDAR_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getCalendarOpenAITools(): Array<Record<string, unknown>> {
  return CALENDAR_TOOLS.map((tool) => ({
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

export async function executeCalendarTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: CalendarToolContext,
): Promise<string> {
  const tool = CALENDAR_TOOLS.find((item) => item.name === toolName)
  if (!tool) return `Unknown calendar tool: ${toolName}`

  if (toolName === 'calendar_list_window') {
    const start = String(args.start || '').trim()
    const end = String(args.end || '').trim()
    if (!start || !end) return 'Error: start and end are required'
  }

  if (toolName === 'calendar_create_event') {
    const title = String(args.title || '').trim()
    const startTime = String(args.startTime || '').trim()
    const endTime = String(args.endTime || '').trim()
    if (!title || !startTime || !endTime) return 'Error: title, startTime and endTime are required'
  }

  if (toolName === 'calendar_update_event' || toolName === 'calendar_delete_event') {
    const id = String(args.id || '').trim()
    if (!id) return 'Error: id is required'
  }

  context?.emitToolAction?.(tool.action, args)

  return toStructuredResult(tool, `${tool.action} 已排队执行。`, {
    ownerResourceId: typeof args.id === 'string' ? args.id : null,
  })
}
