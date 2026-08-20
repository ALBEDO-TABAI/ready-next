import {
  READY_MEMORY_SEARCH_TOOL_NAME,
  searchReadyMemorySnapshot,
} from '../agent-control/ready-memory/ready-memory-contract'
import type { ReadyMemorySnapshot } from '../agent-control/ready-memory/ready-memory-types'
import { createToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'

export const READY_MEMORY_TOOL_NAMES = [READY_MEMORY_SEARCH_TOOL_NAME] as const

const schema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '要在已冻结的 Ready 长期记忆中查找的关键词。',
      minLength: 1,
      maxLength: 200,
    },
    limit: {
      type: 'integer',
      description: '返回条数，默认 8，最多 20。',
      minimum: 1,
      maximum: 20,
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const description = '只读检索本轮开始前已冻结的 Ready 长期记忆。不会新增、修改或删除记忆。'

export function getReadyMemoryAnthropicTools(): Array<Record<string, unknown>> {
  return [{ name: READY_MEMORY_SEARCH_TOOL_NAME, description, input_schema: schema }]
}

export function getReadyMemoryOpenAITools(): Array<Record<string, unknown>> {
  return [{
    type: 'function',
    function: { name: READY_MEMORY_SEARCH_TOOL_NAME, description, parameters: schema },
  }]
}

export function executeReadyMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
  snapshot: ReadyMemorySnapshot | null,
) {
  if (toolName !== READY_MEMORY_SEARCH_TOOL_NAME || !snapshot) {
    return createToolExecutionOutput('本轮没有可读取的长期记忆快照。', {
      shape: 'json',
      data: { errorKind: 'ready_memory_snapshot_unavailable', readEntryIds: [] },
    })
  }
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const limit = Number.isSafeInteger(args.limit) ? Number(args.limit) : 8
  const entries = searchReadyMemorySnapshot({ snapshot, query, limit })
  const readEntryIds = entries.map((entry) => entry.entryId)
  return createToolExecutionOutput(
    entries.length > 0
      ? `找到 ${entries.length} 条与本轮快照一致的长期记忆。`
      : '本轮已冻结的长期记忆中没有匹配项。',
    {
      shape: 'json',
      data: {
        snapshotDigest: snapshot.snapshotDigest,
        query,
        readEntryIds,
        entries: entries.map((entry) => ({
          entryId: entry.entryId,
          category: entry.category,
          content: entry.content,
          pinned: entry.pinned,
          origin: entry.origin,
          sourceRefs: entry.sourceRefs,
        })),
      },
    },
  )
}
