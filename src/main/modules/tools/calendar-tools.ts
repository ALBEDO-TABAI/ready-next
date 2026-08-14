import { CALENDAR_SCHEMAS } from './schemas/calendar-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

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
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const CALENDAR_TOOLS: CalendarToolDef[] = [
  {
    name: 'calendar_list_window',
    description: '读取某个时间窗口内的日程事件。',
    action: 'calendar.listWindow',
    intent: 'list_calendar_window',
    executionKind: 'deterministic',
    params: zodObjectToParamList(CALENDAR_SCHEMAS.calendar_list_window) as ToolParam[],
  },
  {
    name: 'calendar_create_event',
    description: '创建一个新的日程事件。',
    action: 'calendar.createEvent',
    intent: 'create_calendar_event',
    executionKind: 'deterministic',
    params: zodObjectToParamList(CALENDAR_SCHEMAS.calendar_create_event) as ToolParam[],
  },
  {
    name: 'calendar_update_event',
    description: '更新一个现有日程事件。',
    action: 'calendar.updateEvent',
    intent: 'update_calendar_event',
    executionKind: 'deterministic',
    params: zodObjectToParamList(CALENDAR_SCHEMAS.calendar_update_event) as ToolParam[],
  },
  {
    name: 'calendar_delete_event',
    description: '删除一个日程事件。',
    action: 'calendar.deleteEvent',
    intent: 'delete_calendar_event',
    executionKind: 'deterministic',
    params: zodObjectToParamList(CALENDAR_SCHEMAS.calendar_delete_event) as ToolParam[],
  },
  {
    name: 'calendar_capture_session',
    description: '读取当前日程模块会话快照、时间窗口和选中事件。',
    action: 'calendar.captureSession',
    intent: 'capture_calendar_session',
    executionKind: 'deterministic',
    params: zodObjectToParamList(CALENDAR_SCHEMAS.calendar_capture_session) as ToolParam[],
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

  if (toolName === 'calendar_create_event') {
    const title = String(args.title || '').trim()
    const startTime = String(args.startTime || '').trim()
    const endTime = String(args.endTime || '').trim()
    if (!title || !startTime || !endTime) return 'Error: title, startTime and endTime are required'
  }

  if (context?.requestModuleToolAction) {
    try {
      const payload = await context.requestModuleToolAction(tool.action, args)
      if (payload.ok === false) {
        return toStructuredResult(tool, typeof payload.summary === 'string' ? payload.summary : `${tool.action} 失败`, {
          ...payload,
          ok: false,
        })
      }
      const summary = typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary.trim()
        : `${tool.action} 已完成。`
      return toStructuredResult(tool, summary, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return toStructuredResult(tool, `calendar action failed: ${tool.action} - ${message}`, {
        ok: false,
        error: message,
      })
    }
  }

  return toStructuredResult(tool, `${tool.action} 缺少产品动作桥。`, {
    ok: false,
    errorKind: 'product_action_bridge_missing',
    ownerResourceId: typeof args.id === 'string' ? args.id : null,
  })
}
