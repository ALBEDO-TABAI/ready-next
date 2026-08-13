import { isReservedCardSourceValue } from '../agent-control/knowledge/reserved-card-source'
import type { ToolContext } from './tool-executor'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec
} from './tool-schema'
import { MEMORY_SCHEMAS } from './schemas/memory-schemas'
import {
  syncBeliefCardFile,
  type FileSyncResult,
} from '../agent-control/knowledge/knowledge-truth-source'
import { isSafeAgentScopeId, type BeliefCard, type BeliefCardStore } from '../agent-control/knowledge/belief-card-store'
import type { MirrorDb } from '../agent-control/knowledge/belief-card-mirror'
import { logAgentMetric } from '../agent-control/metrics'
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
      '写入一张原子信念卡（知识/偏好/工作方式/开放问题）。出现值得长期记住的稳定事实时当轮写；新卡默认 staged(待确认)，不会进入注入，晋升后才生效。允许写到 knowledge/<slug>.md、knowledge/sites/<domain>.md，或某个专项 agent 专属的 agents/<agentId>/knowledge/<slug>.md、agents/<agentId>/knowledge/sites/<domain>.md。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_write_card) as ToolParam[],
  },
  {
    name: 'memory_read_card',
    description:
      '按相对路径读取一张信念卡全文（knowledge/<slug>.md、knowledge/sites/<domain>.md，或 agents/<agentId>/knowledge/[sites/]<slug>.md）。默认不返回待确认(staged)卡片；需要时传 include_staged=true。',
    params: zodObjectToParamList(MEMORY_SCHEMAS.memory_read_card) as ToolParam[],
  },
]

type CardWriteStatus = 'staged' | 'active'

type CardWriteAuthorization =
  | { ok: true; status: CardWriteStatus }
  | { ok: false; reason: string }

function agentOwnerFromCardPath(relPath: string): string | null {
  const match = relPath.replace(/\\/g, '/').match(/^agents\/([^/]+)\/knowledge(?:\/|$)/)
  return match?.[1] ?? null
}

export function resolveCardWriteAuthorization(input: {
  requestedStatus?: CardWriteStatus
  relPath: string
  invoker?: ToolContext['invoker']
  ownerAgentId: string | null
  existingCard: BeliefCard | null
}): CardWriteAuthorization {
  const ownerFromPath = agentOwnerFromCardPath(input.relPath)
  if (ownerFromPath !== null) {
    if (!isSafeAgentScopeId(ownerFromPath)) {
      return { ok: false, reason: 'agent-scoped card owner is invalid' }
    }
    if (!input.ownerAgentId || input.ownerAgentId !== ownerFromPath) {
      return { ok: false, reason: 'agent-scoped card owner mismatch' }
    }
  }

  const hostAuthorized = input.invoker === 'host'
  if (!hostAuthorized && input.existingCard?.frontmatter.status === 'active') {
    return { ok: false, reason: 'active card overwrite requires host confirmation' }
  }

  return {
    ok: true,
    status: hostAuthorized && input.requestedStatus === 'active' ? 'active' : 'staged',
  }
}

function getMirrorDb(runtime: ToolContext['runtime']): MirrorDb | null {
  const candidate = runtime as (ToolContext['runtime'] & {
    getBeliefCardMirrorDb?: () => MirrorDb | null
  }) | null | undefined
  return candidate?.getBeliefCardMirrorDb?.() ?? null
}

function mirrorFailurePayload(relPath: string, errorKind: string, error?: unknown): Record<string, unknown> {
  return {
    relPath,
    errorKind,
    ...(error instanceof Error ? { message: error.message } : error ? { message: String(error) } : {}),
  }
}

function syncMirrorAfterCardWrite(
  runtime: ToolContext['runtime'],
  store: BeliefCardStore,
  relPath: string,
): { mirrorSynced: true; mirrorSyncResult: FileSyncResult } | { mirrorSynced: false; mirrorSyncErrorKind: string } {
  const db = getMirrorDb(runtime)
  if (!db) {
    return { mirrorSynced: false, mirrorSyncErrorKind: 'mirror_db_unavailable' }
  }
  try {
    const result = syncBeliefCardFile(db, store, relPath)
    if (result === 'invalid') {
      const errorKind = 'mirror_invalid_after_write'
      logAgentMetric('belief_card_mirror_sync_failed', mirrorFailurePayload(relPath, errorKind))
      return { mirrorSynced: false, mirrorSyncErrorKind: errorKind }
    }
    return { mirrorSynced: true, mirrorSyncResult: result }
  } catch (error) {
    const errorKind = 'mirror_sync_failed'
    logAgentMetric('belief_card_mirror_sync_failed', mirrorFailurePayload(relPath, errorKind, error))
    return { mirrorSynced: false, mirrorSyncErrorKind: errorKind }
  }
}

function isReservedModelCardSource(source: string | undefined, invoker: ToolContext['invoker']): boolean {
  return invoker === 'model' && isReservedCardSourceValue(source)
}

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
        if (isReservedModelCardSource(source, context.invoker)) {
          return JSON.stringify({
            success: false,
            errorKind: 'reserved_source_prefix',
            error: 'reserved card source prefix requires host confirmation',
          })
        }
        const existingCard = store.readCard(rel_path, { includeStaged: true })
        const authorization = resolveCardWriteAuthorization({
          requestedStatus: status,
          relPath: rel_path,
          invoker: context.invoker,
          ownerAgentId: context.executionProfile?.knowledgeWriteOwnerAgentId ?? null,
          existingCard,
        })
        if (!authorization.ok) {
          return JSON.stringify({ success: false, error: authorization.reason })
        }
        const result = store.writeCard({
          relPath: rel_path,
          frontmatter: {
            title,
            description,
            confidence,
            tag,
            created: new Date().toISOString().slice(0, 10),
            status: authorization.status,
            ...(source ? { source } : {}),
            ...(site ? { site } : {}),
          },
          body,
        })
        if (!result.ok) {
          return JSON.stringify({ success: false, error: result.reason })
        }
        const mirrorReceipt = syncMirrorAfterCardWrite(runtime, store, result.relPath)
        log(`[memory_write_card] wrote ${result.relPath} (${authorization.status})`)
        return JSON.stringify({
          success: true,
          rel_path: result.relPath,
          status: authorization.status,
          mirrorSynced: mirrorReceipt.mirrorSynced,
          ...(!mirrorReceipt.mirrorSynced ? { mirrorSyncErrorKind: mirrorReceipt.mirrorSyncErrorKind } : {}),
          message: `已写入信念卡 ${result.relPath}（${authorization.status}）`,
        })
      }

      case 'memory_read_card': {
        const { rel_path, include_staged } = args as {
          rel_path: string
          include_staged?: boolean
        }
        const store = runtime.getBeliefCardStore()
        if (context.executionProfile && !context.executionProfile.allowedKnowledgeRefs.includes(rel_path)) {
          return JSON.stringify({ success: false, error: 'card is outside the frozen execution profile allowlist' })
        }
        const allowStaged = context.invoker === 'host' && include_staged === true
        const card = store.readCard(rel_path, { includeStaged: allowStaged })
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
