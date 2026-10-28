import { CALENDAR_SCHEMAS } from './schemas/calendar-schemas'
import { z } from 'zod'
import type { CalendarToolName } from './schemas/calendar-schemas'

interface CalendarToolDef {
  name: CalendarToolName
  description: string
  action: string
  intent: string
  executionKind: 'deterministic'
}

interface CalendarToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const CALENDAR_TOOLS: CalendarToolDef[] = [
  {
    name: 'calendar_list_window',
    description: '读取 Ready 应用内本地日历某个时间窗口的日程。这不是飞书日历。',
    action: 'calendar.listWindow',
    intent: 'list_calendar_window',
    executionKind: 'deterministic',
  },
  {
    name: 'calendar_create_event',
    description: '在 Ready 应用内的本地日历创建一个新日程。这不是飞书日历。',
    action: 'calendar.createEvent',
    intent: 'create_calendar_event',
    executionKind: 'deterministic',
  },
  {
    name: 'calendar_update_event',
    description: '更新 Ready 应用内本地日历中的现有日程。这不是飞书日历。',
    action: 'calendar.updateEvent',
    intent: 'update_calendar_event',
    executionKind: 'deterministic',
  },
  {
    name: 'calendar_delete_event',
    description: '删除 Ready 应用内本地日历中的日程。这不是飞书日历。',
    action: 'calendar.deleteEvent',
    intent: 'delete_calendar_event',
    executionKind: 'deterministic',
  },
  {
    name: 'calendar_capture_session',
    description: '读取 Ready 应用内本地日历工作面的会话快照、时间窗口和选中事件。这不是飞书日历。',
    action: 'calendar.captureSession',
    intent: 'capture_calendar_session',
    executionKind: 'deterministic',
  },
]

function calendarToolSchema(name:CalendarToolName):Record<string,unknown>{
  const { $schema: _dialect, ...schema } = z.toJSONSchema(CALENDAR_SCHEMAS[name], { target: 'draft-7', unrepresentable: 'any' })
  return schema
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
    input_schema: calendarToolSchema(tool.name),
  }))
}

export function getCalendarOpenAITools(): Array<Record<string, unknown>> {
  return CALENDAR_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: calendarToolSchema(tool.name),
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

  const parsed=CALENDAR_SCHEMAS[tool.name].safeParse(args)
  if(!parsed.success)return `Error: ${parsed.error.issues.map(issue=>issue.message).join('；')}`
  args=parsed.data

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
