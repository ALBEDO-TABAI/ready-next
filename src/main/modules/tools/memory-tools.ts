import { appendFileSync } from 'fs'
import type { ToolContext } from './tool-executor'
import { getLogPath } from '../../utils/platform'
import { buildToolParamSchema, normalizeAnthropicToolSchema, normalizeOpenAIToolSchema, type ToolParamSchemaSpec } from './tool-schema'

const LOG = getLogPath('ready-memory-tools.log')

function log(msg: string) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* */
  }
}

type ToolParam = ToolParamSchemaSpec

interface MemoryToolDef {
  name: string
  description: string
  params: ToolParam[]
}

const MEMORY_TOOLS: MemoryToolDef[] = [
  {
    name: 'memory_create',
    description:
      '创建新的记忆。用于记录重要信息、用户偏好、学习内容等。摘要(summary)会在30天后过期，学习(learning)永久保存且全局可用。',
    params: [
      {
        name: 'category',
        type: 'string',
        description: '记忆类别：summary(会话摘要，30天后过期) 或 learning(全局学习，永久保存)',
        required: true,
        enum: ['summary', 'learning'],
      },
      { name: 'title', type: 'string', description: '记忆标题，简短描述', required: true },
      { name: 'content', type: 'string', description: '记忆内容，详细信息', required: true },
      {
        name: 'tags',
        type: 'array',
        description: '标签列表，用于分类和检索',
        required: false,
        items: { type: 'string' },
      },
      {
        name: 'priority',
        type: 'number',
        description: '优先级，0-10，数字越大优先级越高',
        required: false,
      },
    ],
  },
  {
    name: 'memory_search',
    description: '搜索记忆。可以按层级、类别、关键词搜索。用于查找之前记录的信息。',
    params: [
      {
        name: 'query',
        type: 'string',
        description: '搜索关键词，在标题和摘要中搜索',
        required: false,
      },
      {
        name: 'layer',
        type: 'string',
        description: '记忆层级：l0(常驻), l1(会话), l2(触发器)',
        required: false,
        enum: ['l0', 'l1', 'l2'],
      },
      {
        name: 'category',
        type: 'string',
        description: '记忆类别：summary, learning, trigger, rule',
        required: false,
        enum: ['summary', 'learning', 'trigger', 'rule'],
      },
      {
        name: 'limit',
        type: 'number',
        description: '返回结果数量限制，默认10',
        required: false,
      },
    ],
  },
  {
    name: 'memory_update',
    description: '更新已存在的记忆。可以修改标题、内容、标签、优先级等。',
    params: [
      { name: 'memory_id', type: 'string', description: '记忆ID', required: true },
      { name: 'title', type: 'string', description: '新标题', required: false },
      { name: 'summary', type: 'string', description: '新摘要', required: false },
      {
        name: 'tags',
        type: 'array',
        description: '新标签列表',
        required: false,
        items: { type: 'string' },
      },
      {
        name: 'priority',
        type: 'number',
        description: '新优先级',
        required: false,
      },
    ],
  },
  {
    name: 'memory_list_recent',
    description: '列出最近的记忆。用于快速查看最近记录的信息。',
    params: [
      {
        name: 'limit',
        type: 'number',
        description: '返回数量，默认5',
        required: false,
      },
    ],
  },
]

export function getMemoryAnthropicTools(): Array<Record<string, unknown>> {
  return MEMORY_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getMemoryOpenAITools(): Array<Record<string, unknown>> {
  return MEMORY_TOOLS.map((tool) => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}

export async function executeMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  log(`[executeMemoryTool] ${toolName} ${JSON.stringify(args)}`)

  const runtime = context.runtime
  if (!runtime) {
    return JSON.stringify({ success: false, error: 'Runtime not available' })
  }

  const memoryRepo = runtime.getMemoryRepository()
  const promptAssembly = runtime.getPromptAssembly()

  try {
    switch (toolName) {
      case 'memory_create': {
        const { category, title, content, tags, priority } = args as {
          category: 'summary' | 'learning'
          title: string
          content: string
          tags?: string[]
          priority?: number
        }

        if (!context.scope) {
          return JSON.stringify({ success: false, error: 'Scope not available' })
        }

        const memoryId = await promptAssembly.createMemoryFromConversation({
          scope: context.scope,
          category,
          title,
          content,
          tags,
          priority,
        })

        if (!memoryId) {
          return JSON.stringify({ success: false, error: 'Failed to create memory' })
        }

        log(`[memory_create] Created memory: ${memoryId}`)
        return JSON.stringify({
          success: true,
          memory_id: memoryId,
          message: `已创建${category === 'summary' ? '会话摘要' : '全局学习'}记忆: ${title}`,
        })
      }

      case 'memory_search': {
        const { query, layer, category, limit } = args as {
          query?: string
          layer?: 'l0' | 'l1' | 'l2'
          category?: 'summary' | 'learning' | 'trigger' | 'rule'
          limit?: number
        }

        let memories
        if (query) {
          memories = await memoryRepo.searchMemories(query, {
            layer,
            category,
            limit: limit || 10,
          })
        } else {
          memories = await memoryRepo.queryMemories({
            layer,
            category,
            limit: limit || 10,
          })
        }

        log(`[memory_search] Found ${memories.length} memories`)
        return JSON.stringify({
          success: true,
          count: memories.length,
          memories: memories.map((m) => ({
            id: m.id,
            layer: m.layer,
            category: m.category,
            title: m.title,
            summary: m.summary,
            tags: m.tags,
            priority: m.priority,
            access_count: m.accessCount,
            created_at: new Date(m.createdAt * 1000).toISOString(),
          })),
        })
      }

      case 'memory_update': {
        const { memory_id, title, summary, tags, priority } = args as {
          memory_id: string
          title?: string
          summary?: string
          tags?: string[]
          priority?: number
        }

        await memoryRepo.updateMemory(memory_id, {
          title,
          summary,
          tags,
          priority,
        })

        log(`[memory_update] Updated memory: ${memory_id}`)
        return JSON.stringify({
          success: true,
          message: `已更新记忆: ${memory_id}`,
        })
      }

      case 'memory_list_recent': {
        const { limit } = args as { limit?: number }

        const memories = await memoryRepo.queryMemories({
          limit: limit || 5,
        })

        log(`[memory_list_recent] Found ${memories.length} recent memories`)
        return JSON.stringify({
          success: true,
          count: memories.length,
          memories: memories.map((m) => ({
            id: m.id,
            layer: m.layer,
            category: m.category,
            title: m.title,
            summary: m.summary,
            created_at: new Date(m.createdAt * 1000).toISOString(),
          })),
        })
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` })
    }
  } catch (error) {
    log(`[executeMemoryTool] Error: ${error instanceof Error ? error.message : String(error)}`)
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
