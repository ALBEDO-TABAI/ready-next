import type {
  ScopeRunTraceItem,
} from '../contracts/types'
import type {
  TaskProjectionRecord,
} from '../contracts/run-contracts'
import type { CodexDynamicToolCallItem } from './codex-native-runtime'
import type { CodexTurnActivityEvent } from './codex-turn-collector'

type CodexTaskActivityStore = {
  get(taskId: string): TaskProjectionRecord | null
}

export type CodexTaskActivityPatch = {
  phase: 'planning' | 'tool_running'
  taskTitle?: string
  taskSummary?: string
  toolEvent?: ScopeRunTraceItem
  timestamp: string
}

type ToolActivityCopy = {
  runningTitle: string
  runningSummary: string
  completedTitle: string
  completedSummary: string
  failedTitle: string
  failedSummary: string
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed'])

function safeCommentary(text: string, larkCliRead: boolean): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (
    /```|<tool_call>|(?:^|\s)(?:lark-cli|npm|node|python\d*|bash|zsh|curl|git)\s|--[a-z0-9][a-z0-9-]*/i.test(normalized)
    || /[{[]\s*["'][a-z0-9_-]+["']\s*:/i.test(normalized)
  ) {
    return larkCliRead ? '正在通过飞书查询并整理信息' : '正在调用工具并整理信息'
  }
  return Array.from(normalized).slice(0, 160).join('')
}

function toolActivityCopy(toolName: string, larkCliRead: boolean): ToolActivityCopy {
  if (larkCliRead && toolName === 'skill_read_artifact') {
    return {
      runningTitle: '正在准备飞书查询',
      runningSummary: '正在确认飞书查询方式',
      completedTitle: '正在准备飞书查询',
      completedSummary: '查询方式已确认，准备读取信息',
      failedTitle: '正在调整查询方式',
      failedSummary: '飞书查询准备未完成，正在调整',
    }
  }
  if (larkCliRead && toolName === 'skill_run_shell') {
    return {
      runningTitle: '正在通过飞书查询',
      runningSummary: '正在读取并整理飞书信息',
      completedTitle: '正在整理查询结果',
      completedSummary: '飞书查询已完成，正在整理结果',
      failedTitle: '正在调整查询方式',
      failedSummary: '本次飞书查询未完成，正在调整',
    }
  }
  if (toolName.startsWith('browser_')) {
    return {
      runningTitle: '正在浏览网页',
      runningSummary: '正在读取并核对网页信息',
      completedTitle: '正在整理网页信息',
      completedSummary: '网页操作已完成，正在整理结果',
      failedTitle: '正在调整网页操作',
      failedSummary: '本次网页操作未完成，正在调整',
    }
  }
  if (toolName.startsWith('research_') || toolName.includes('search')) {
    return {
      runningTitle: '正在查询信息',
      runningSummary: '正在查找并核对相关信息',
      completedTitle: '正在整理查询结果',
      completedSummary: '信息查询已完成，正在整理结果',
      failedTitle: '正在调整查询方式',
      failedSummary: '本次信息查询未完成，正在调整',
    }
  }
  if (toolName.startsWith('document_')) {
    return {
      runningTitle: '正在处理文档',
      runningSummary: '正在读取并处理文档内容',
      completedTitle: '正在整理文档结果',
      completedSummary: '文档步骤已完成，正在整理结果',
      failedTitle: '正在调整文档处理',
      failedSummary: '本次文档步骤未完成，正在调整',
    }
  }
  if (toolName.startsWith('skill_')) {
    return {
      runningTitle: '正在执行技能',
      runningSummary: '正在使用所需能力处理任务',
      completedTitle: '正在整理处理结果',
      completedSummary: '技能步骤已完成，正在整理结果',
      failedTitle: '正在调整处理方式',
      failedSummary: '本次技能步骤未完成，正在调整',
    }
  }
  return {
    runningTitle: '正在调用工具',
    runningSummary: '正在使用所需工具处理任务',
    completedTitle: '正在整理处理结果',
    completedSummary: '工具步骤已完成，正在整理结果',
    failedTitle: '正在调整处理方式',
    failedSummary: '本次工具步骤未完成，正在调整',
  }
}

function toolFailed(item: CodexDynamicToolCallItem): boolean {
  return item.status === 'failed' || item.success === false
}

export function createCodexTaskActivityProjector(input: {
  store: CodexTaskActivityStore
  publish(patch: CodexTaskActivityPatch): void
  taskId: string
  runId: string
  messageVisibilityEpoch: number
  larkCliRead: boolean
  now?: () => string
}): { observe(event: CodexTurnActivityEvent): void } {
  const now = input.now || (() => new Date().toISOString())
  const publishedToolStages = new Set<string>()

  return {
    observe(event) {
      const current = input.store.get(input.taskId)
      if (
        !current
        || current.runId !== input.runId
        || current.messageVisibilityEpoch !== input.messageVisibilityEpoch
        || TERMINAL_TASK_STATUSES.has(current.status)
      ) return

      if (event.item.type === 'agentMessage') {
        if (event.stage !== 'completed' || event.item.phase !== 'commentary') return
        const taskSummary = safeCommentary(event.item.text, input.larkCliRead)
        if (!taskSummary) return
        input.publish({
          phase: 'planning',
          taskSummary,
          timestamp: now(),
        })
        return
      }

      if (event.item.type !== 'dynamicToolCall') return
      const stageKey = `${event.item.id}:${event.stage}`
      if (publishedToolStages.has(stageKey)) return
      publishedToolStages.add(stageKey)
      const copy = toolActivityCopy(event.item.tool, input.larkCliRead)
      const failed = event.stage === 'completed' && toolFailed(event.item)
      const done = event.stage === 'completed' && !failed
      const updatedAt = now()
      const stepId = `codex-tool:${event.item.id}`
      input.publish({
        phase: 'tool_running',
        taskTitle: failed ? copy.failedTitle : done ? copy.completedTitle : copy.runningTitle,
        taskSummary: failed ? copy.failedSummary : done ? copy.completedSummary : copy.runningSummary,
        toolEvent: {
          id: `${stepId}:${event.stage}`,
          kind: event.stage === 'started' ? 'call' : 'result',
          text: failed ? copy.failedSummary : done ? copy.completedSummary : copy.runningSummary,
          timestamp: updatedAt,
          toolName: event.item.tool,
        },
        timestamp: updatedAt,
      })
    },
  }
}
