import { appendFileSync } from 'fs'
import type { ToolContext } from './tool-executor'
import { getLogPath } from '../../utils/platform'
import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec
} from './tool-schema'

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
      '创建新的记忆。summary 只记录当前任务/当前 scope 的上下文摘要；learning 只记录以后仍会反复用到的稳定事实。历史聊天回看请改用 session_search，不要把 memory 当旧会话检索。',
    params: [
      {
        name: 'category',
        type: 'string',
        description:
          '记忆类别：summary(当前任务/当前 scope 摘要，30天后过期) 或 learning(常驻 agent 记忆，长期保留)',
        required: true,
        enum: ['summary', 'learning']
      },
      { name: 'title', type: 'string', description: '记忆标题，简短描述', required: true },
      { name: 'content', type: 'string', description: '记忆内容，详细信息', required: true },
      {
        name: 'tags',
        type: 'array',
        description: '标签列表，用于分类和检索',
        required: false,
        items: { type: 'string' }
      },
      {
        name: 'priority',
        type: 'number',
        description: '优先级，0-10，数字越大优先级越高',
        required: false
      }
    ]
  },
  {
    name: 'memory_search',
    description:
      '搜索持久记忆与触发规则。不要把它当历史聊天检索；涉及“上次那轮对话”之类的问题请使用 session_search。',
    params: [
      {
        name: 'query',
        type: 'string',
        description: '搜索关键词，在标题和摘要中搜索',
        required: false
      },
      {
        name: 'layer',
        type: 'string',
        description: '存储层级：l0(常驻), l1(当前 scope), l2(触发规则)',
        required: false,
        enum: ['l0', 'l1', 'l2']
      },
      {
        name: 'source_type',
        type: 'string',
        description: '来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
        required: false,
        enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule']
      },
      {
        name: 'category',
        type: 'string',
        description: '记忆类别：summary, learning, trigger, rule',
        required: false,
        enum: ['summary', 'learning', 'trigger', 'rule']
      },
      {
        name: 'limit',
        type: 'number',
        description: '返回结果数量限制，默认10',
        required: false
      }
    ]
  },
  {
    name: 'memory_update',
    description: '更新已存在的持久记忆。用于整理常驻记忆或当前摘要，不用于回看旧聊天。',
    params: [
      { name: 'memory_id', type: 'string', description: '记忆ID', required: true },
      { name: 'title', type: 'string', description: '新标题', required: false },
      { name: 'summary', type: 'string', description: '新摘要', required: false },
      {
        name: 'tags',
        type: 'array',
        description: '新标签列表',
        required: false,
        items: { type: 'string' }
      },
      {
        name: 'priority',
        type: 'number',
        description: '新优先级',
        required: false
      },
      {
        name: 'source_type',
        type: 'string',
        description: '新的来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
        required: false,
        enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule']
      }
    ]
  },
  {
    name: 'memory_list_recent',
    description:
      '列出最近的记忆。默认用于查看最近写入的 resident/scope/trigger 记录，不包含历史会话回看。',
    params: [
      {
        name: 'limit',
        type: 'number',
        description: '返回数量，默认5',
        required: false
      },
      {
        name: 'source_type',
        type: 'string',
        description: '来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
        required: false,
        enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule']
      }
    ]
  }
]

export function getMemoryAnthropicTools(): Array<Record<string, unknown>> {
  return MEMORY_TOOLS.map((tool) =>
    normalizeAnthropicToolSchema({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          tool.params.map((param) => [param.name, buildToolParamSchema(param)])
        ),
        required: tool.params.filter((param) => param.required).map((param) => param.name)
      }
    })
  )
}

export function getMemoryOpenAITools(): Array<Record<string, unknown>> {
  return MEMORY_TOOLS.map((tool) =>
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            tool.params.map((param) => [param.name, buildToolParamSchema(param)])
          ),
          required: tool.params.filter((param) => param.required).map((param) => param.name)
        }
      }
    })
  )
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
          priority
        })

        if (!memoryId) {
          return JSON.stringify({ success: false, error: 'Failed to create memory' })
        }

        log(`[memory_create] Created memory: ${memoryId}`)
        return JSON.stringify({
          success: true,
          memory_id: memoryId,
          message: `已创建${category === 'summary' ? '当前任务摘要' : '常驻记忆'}: ${title}`
        })
      }

      case 'memory_search': {
        const { query, layer, source_type, category, limit } = args as {
          query?: string
          layer?: 'l0' | 'l1' | 'l2'
          source_type?: 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule'
          category?: 'summary' | 'learning' | 'trigger' | 'rule'
          limit?: number
        }

        let memories
        if (query) {
          memories = await memoryRepo.searchMemories(query, {
            layer,
            sourceType: source_type,
            category,
            limit: limit || 10
          })
        } else {
          memories = await memoryRepo.queryMemories({
            layer,
            sourceType: source_type,
            category,
            limit: limit || 10
          })
        }

        log(`[memory_search] Found ${memories.length} memories`)
        return JSON.stringify({
          success: true,
          count: memories.length,
          memories: memories.map((m) => ({
            id: m.id,
            layer: m.layer,
            source_type: m.sourceType,
            category: m.category,
            title: m.title,
            summary: m.summary,
            tags: m.tags,
            priority: m.priority,
            access_count: m.accessCount,
            created_at: new Date(m.createdAt * 1000).toISOString()
          }))
        })
      }

      case 'memory_update': {
        const { memory_id, title, summary, tags, priority, source_type } = args as {
          memory_id: string
          title?: string
          summary?: string
          tags?: string[]
          priority?: number
          source_type?: 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule'
        }

        await memoryRepo.updateMemory(memory_id, {
          title,
          summary,
          tags,
          priority,
          sourceType: source_type
        })

        log(`[memory_update] Updated memory: ${memory_id}`)
        return JSON.stringify({
          success: true,
          message: `已更新记忆: ${memory_id}`
        })
      }

      case 'memory_list_recent': {
        const { limit, source_type } = args as {
          limit?: number
          source_type?: 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule'
        }

        const memories = await memoryRepo.queryMemories({
          sourceType: source_type,
          limit: limit || 5
        })

        log(`[memory_list_recent] Found ${memories.length} recent memories`)
        return JSON.stringify({
          success: true,
          count: memories.length,
          memories: memories.map((m) => ({
            id: m.id,
            layer: m.layer,
            source_type: m.sourceType,
            category: m.category,
            title: m.title,
            summary: m.summary,
            created_at: new Date(m.createdAt * 1000).toISOString()
          }))
        })
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` })
    }
  } catch (error) {
    log(`[executeMemoryTool] Error: ${error instanceof Error ? error.message : String(error)}`)
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
