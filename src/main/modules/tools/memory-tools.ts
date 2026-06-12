import type { ToolContext } from './tool-executor'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec
} from './tool-schema'
import { MEMORY_SCHEMAS } from './schemas/memory-schemas'
import { isKnowledgeSystemEnabled } from '../agent-control/knowledge/knowledge-truth-source'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { zodObjectToParamList } from './zod-param-derivation'

const logger = createRotatingLogger('ready-memory-tools.log')

function log(msg: string) {
  try {
    logger.append(`[${new Date().toISOString()}] ${msg}\n`)
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
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_create) as ToolParam[],
  },
  {
    name: 'memory_search',
    description:
      '搜索持久记忆与触发规则。不要把它当历史聊天检索；涉及“上次那轮对话”之类的问题请使用 session_search。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_search) as ToolParam[],
  },
  {
    name: 'memory_update',
    description: '更新已存在的持久记忆。用于整理常驻记忆或当前摘要，不用于回看旧聊天。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_update) as ToolParam[],
  },
  {
    name: 'memory_list_recent',
    description:
      '列出最近的记忆。默认用于查看最近写入的 resident/scope/trigger 记录，不包含历史会话回看。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_list_recent) as ToolParam[],
  },
  {
    name: 'memory_write_card',
    description:
      '写入一张原子信念卡（知识/偏好/工作方式/开放问题）。出现值得长期记住的稳定事实时当轮写；新卡默认 staged(待确认)，不会进入注入，晋升后才生效。允许写到 knowledge/<slug>.md、knowledge/sites/<domain>.md，或某个专项 agent 专属的 agents/<agentId>/knowledge/<slug>.md。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_write_card) as ToolParam[],
  },
  {
    name: 'memory_read_card',
    description:
      '按相对路径读取一张信念卡全文（knowledge/<slug>.md、knowledge/sites/<domain>.md 或 agents/<agentId>/knowledge/<slug>.md）。默认不返回待确认(staged)卡片；需要时传 include_staged=true。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_read_card) as ToolParam[],
  },
]

const CARD_TOOL_NAMES = new Set(['memory_write_card', 'memory_read_card'])

/** EP2-K6 — rollback switch: card tools disappear from exposure when the
 *  knowledge system is off (files untouched, injection already gated). */
function filterCardTools(defs: typeof MEMORY_TOOLS): typeof MEMORY_TOOLS {
  let enabled = true
  try {
    enabled = isKnowledgeSystemEnabled(new AppSettingsRepository())
  } catch { enabled = true }
  return enabled ? defs : defs.filter((def) => !CARD_TOOL_NAMES.has(def.name))
}

export function getMemoryAnthropicTools(): Array<Record<string, unknown>> {
  return filterCardTools(MEMORY_TOOLS).map((tool) =>
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
  return filterCardTools(MEMORY_TOOLS).map((tool) =>
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

      case 'memory_write_card': {
        const { rel_path, title, description, confidence, tag, body, status, source, site } =
          args as {
            rel_path: string
            title: string
            description: string
            confidence: 'H' | 'M' | 'L'
            tag: 'knowledge' | 'self' | 'preference' | 'aspire'
            body: string
            status?: 'staged' | 'active'
            source?: string
            site?: string
          }
        const store = runtime.getBeliefCardStore()
        const result = store.writeCard({
          relPath: rel_path,
          frontmatter: {
            title,
            description,
            confidence,
            tag,
            created: new Date().toISOString().slice(0, 10),
            status: status ?? 'staged',
            ...(source ? { source } : {}),
            ...(site ? { site } : {}),
          },
          body,
        })
        if (!result.ok) {
          return JSON.stringify({ success: false, error: result.reason })
        }
        log(`[memory_write_card] wrote ${result.relPath} (${status ?? 'staged'})`)
        return JSON.stringify({
          success: true,
          rel_path: result.relPath,
          status: status ?? 'staged',
          message: `已写入信念卡 ${result.relPath}（${status ?? 'staged'}）`,
        })
      }

      case 'memory_read_card': {
        const { rel_path, include_staged } = args as {
          rel_path: string
          include_staged?: boolean
        }
        const store = runtime.getBeliefCardStore()
        const card = store.readCard(rel_path, { includeStaged: include_staged === true })
        if (!card) {
          return JSON.stringify({ success: false, error: 'card not found or excluded (staged)' })
        }
        return JSON.stringify({
          success: true,
          rel_path: card.relPath,
          frontmatter: card.frontmatter,
          body: card.body,
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
