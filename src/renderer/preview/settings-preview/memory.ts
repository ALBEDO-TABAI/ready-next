// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
import type { ReadyMemoryCategory, ReadyMemoryEntryView, ReadyMemoryView } from '../../../shared/ready-memory'

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

function entry(
  entryId: string,
  category: ReadyMemoryCategory,
  content: string,
  overrides: Partial<ReadyMemoryEntryView> = {},
): ReadyMemoryEntryView {
  return {
    entryId,
    category,
    content,
    origin: 'manual',
    confidence: 1,
    pinned: false,
    status: 'active',
    expiresAt: null,
    sourceRefs: [],
    lastUsedAt: null,
    createdAt: hoursAgo(240),
    updatedAt: hoursAgo(72),
    ...overrides,
  }
}

let view: ReadyMemoryView = {
  useMemories: true,
  generateMemories: false,
  automaticGenerationAvailable: true,
  conversationId: null,
  contributeToMemories: null,
  pendingGenerationJobs: 0,
  unresolvedGenerationJobs: 0,
  entries: [
    entry('memory-1', 'preference', '回答用简洁、直接的中文，先给结论再给理由。', { pinned: true, lastUsedAt: hoursAgo(2) }),
    entry('memory-2', 'workflow', '写周报时按「本周完成 / 风险 / 下周计划」三段组织，每段不超过五条。', {
      origin: 'consolidated',
      confidence: 0.82,
      sourceRefs: ['conversation-a', 'conversation-b'],
      lastUsedAt: hoursAgo(26),
    }),
    entry('memory-3', 'project', 'Ready 0.8 的设置页正在做液态玻璃视觉统一，橘红只做点缀色。', { updatedAt: hoursAgo(5) }),
    entry('memory-4', 'fact', '常用的 RSS 阅读时间是早上 8 点到 9 点。', {
      origin: 'consolidated',
      confidence: 0.74,
      sourceRefs: ['conversation-c'],
    }),
    entry('memory-5', 'preference', '代码示例默认使用 TypeScript，缩进两个空格。', { lastUsedAt: hoursAgo(50) }),
    entry('memory-6', 'other', '旧的出差安排：九月上旬在上海。', {
      status: 'expired',
      expiresAt: hoursAgo(300),
      updatedAt: hoursAgo(600),
    }),
  ],
}

const ok = () => Promise.resolve({ success: true as const, data: view })

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  agent: {
    readReadyMemory: async () => ok(),
    setReadyMemoryGlobalPolicy: async (payload: { useMemories?: boolean; generateMemories?: boolean }) => {
      view = {
        ...view,
        ...(payload.useMemories !== undefined ? { useMemories: payload.useMemories } : {}),
        ...(payload.generateMemories !== undefined ? { generateMemories: payload.generateMemories } : {}),
      }
      return ok()
    },
    setReadyMemoryConversationPolicy: async (payload: { contributeToMemories: boolean }) => {
      view = { ...view, contributeToMemories: payload.contributeToMemories }
      return ok()
    },
    addReadyMemory: async (payload: { category: ReadyMemoryCategory; content: string; pinned?: boolean }) => {
      view = {
        ...view,
        entries: [
          entry(`memory-${Date.now()}`, payload.category, payload.content, { pinned: Boolean(payload.pinned), updatedAt: new Date().toISOString() }),
          ...view.entries,
        ],
      }
      return ok()
    },
    updateReadyMemory: async (payload: { entryId: string; category: ReadyMemoryCategory; content: string }) => {
      view = {
        ...view,
        entries: view.entries.map((item) => item.entryId === payload.entryId
          ? { ...item, category: payload.category, content: payload.content, updatedAt: new Date().toISOString() }
          : item),
      }
      return ok()
    },
    pinReadyMemory: async (payload: { entryId: string; pinned: boolean }) => {
      view = {
        ...view,
        entries: view.entries.map((item) => item.entryId === payload.entryId ? { ...item, pinned: payload.pinned } : item),
      }
      return ok()
    },
    deleteReadyMemory: async (payload: { entryId: string }) => {
      view = { ...view, entries: view.entries.filter((item) => item.entryId !== payload.entryId) }
      return ok()
    },
    resetReadyMemory: async () => {
      view = { ...view, entries: [] }
      return ok()
    },
  },
}
