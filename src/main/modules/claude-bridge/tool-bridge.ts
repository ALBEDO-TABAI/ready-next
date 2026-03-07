export interface TextToolBridgeCall {
  name: string
  args: Record<string, unknown>
}

export interface ParsedTextToolBridgeResponse {
  visibleText: string
  toolCalls: TextToolBridgeCall[]
}

const TOOL_CALL_BLOCK_REGEX = /:::tool_call\s*\n\s*({[\s\S]*?})\s*\n\s*:::/g

function normalizeSchemaType(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').join(' | ') || 'unknown'
  }
  return typeof value === 'string' ? value : 'unknown'
}

function formatToolDescription(tool: Record<string, unknown>): string | null {
  const fn = (tool.function && typeof tool.function === 'object') ? tool.function as Record<string, unknown> : null
  const name = typeof fn?.name === 'string' ? fn.name : ''
  if (!name) return null

  const description = typeof fn?.description === 'string' ? fn.description.trim() : ''
  const parameters = (fn?.parameters && typeof fn.parameters === 'object')
    ? fn.parameters as Record<string, unknown>
    : { type: 'object', properties: {}, required: [] }
  const properties = (parameters.properties && typeof parameters.properties === 'object')
    ? parameters.properties as Record<string, unknown>
    : {}
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === 'string')
    : []

  const lines = [`### ${name}`]
  if (description) lines.push(description)

  const propertyLines = Object.entries(properties).map(([paramName, schema]) => {
    const param = schema && typeof schema === 'object' ? schema as Record<string, unknown> : {}
    const type = normalizeSchemaType(param.type)
    const paramDescription = typeof param.description === 'string' ? param.description.trim() : ''
    const enumValues = Array.isArray(param.enum)
      ? param.enum.filter((item): item is string => typeof item === 'string')
      : []
    const requiredLabel = required.includes(paramName) ? ', required' : ''
    const enumLabel = enumValues.length > 0 ? `, enum: ${enumValues.join(' / ')}` : ''
    return `- ${paramName} (${type}${requiredLabel}${enumLabel}): ${paramDescription || '无额外说明'}`
  })

  if (propertyLines.length > 0) {
    lines.push('Parameters:')
    lines.push(...propertyLines)
  } else {
    lines.push('Parameters: 无')
  }

  return lines.join('\n')
}

export function buildTextToolBridgePrompt(
  tools: Array<Record<string, unknown>>,
  options?: { forceDocumentTool?: boolean },
): string {
  const toolDescriptions = tools
    .map((tool) => formatToolDescription(tool))
    .filter((item): item is string => Boolean(item))
    .join('\n\n')

  const extraRules = [
    options?.forceDocumentTool
      ? '- 本轮任务必须先执行真实工具调用，再给最终结论；不要只写说明。'
      : '',
  ].filter(Boolean)

  return [
    '你当前所在的模型通道无法稳定接收原生 function calling，因此需要改用文本工具桥接。',
    '注意：这不代表没有工具。下面列出的 Ready 工具都是真实可执行的；只要你输出 tool_call 块，宿主应用就会替你执行。',
    '当你需要调用 Ready 工具时，请输出下面这种独立块；可以连续输出多个：',
    '',
    ':::tool_call',
    '{"tool":"<tool_name>","args":{"key":"value"}}',
    ':::',
    '',
    '规则：',
    '- 只能调用下方列出的工具，参数必须是合法 JSON 对象。',
    '- 如果已有足够信息直接回答，不要输出 tool_call。',
    '- 不要回复“当前通道没有工具 / 没有网页操作工具 / tools unavailable”之类的话；当前就是可用工具模式。',
    '- 如果缺少关键信息，先提问澄清，不要伪造工具。',
    '- 收到 tool_result 后，先利用已有页面/上下文继续，不要重复搜索、重复跳转或重复点击。',
    '- 如果当前页面、输入框、上传入口或模式按钮仍然可疑但未确认，可以先做一次低成本探测，再继续决策。',
    ...extraRules,
    '',
    '可用工具如下：',
    toolDescriptions || '（当前没有可用工具）',
  ].join('\n')
}

export function parseTextToolBridgeResponse(text: string): ParsedTextToolBridgeResponse {
  if (!text) {
    return { visibleText: '', toolCalls: [] }
  }

  const toolCalls: TextToolBridgeCall[] = []
  const visibleText = text
    .replace(TOOL_CALL_BLOCK_REGEX, (_match, jsonBlock) => {
      try {
        const parsed = JSON.parse(String(jsonBlock)) as Record<string, unknown>
        const name = typeof parsed.tool === 'string' ? parsed.tool.trim() : ''
        const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? parsed.args as Record<string, unknown>
          : {}
        if (name) {
          toolCalls.push({ name, args })
        }
      } catch {
        // Ignore invalid JSON blocks.
      }
      return ''
    })
    .replace(/\n{2,}/g, '\n')
    .trim()

  return { visibleText, toolCalls }
}

export function buildTextToolResultMessage(
  results: Array<{ id: string; name: string; result: string }>,
): string {
  const blocks = results.map((item) => [
    '[tool_result]',
    `call_id: ${item.id}`,
    `tool: ${item.name}`,
    'result:',
    item.result,
    '[/tool_result]',
  ].join('\n'))

  return [
    ...blocks,
    '请基于以上工具结果继续下一步；如果任务已经完成，直接给出最终答复。',
  ].join('\n\n')
}

export function looksLikeMissingNativeToolsReply(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false

  const patterns = [
    /没有可用工具/i,
    /当前通道.*没有.*网页操作工具/i,
    /没有.*网页操作工具/i,
    /当前.*工具.*不可用/i,
    /无法使用.*工具/i,
    /no available tools?/i,
    /don['’]t have .*tools?/i,
    /do not have .*tools?/i,
    /tool .* not available/i,
    /tools? available in this session/i,
    /can['’]t access .*tools?/i,
    /cannot access .*tools?/i,
  ]

  return patterns.some((pattern) => pattern.test(normalized))
}
