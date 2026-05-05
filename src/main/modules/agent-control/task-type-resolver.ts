import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import type { IntentClassification } from './intent-classifier'
import type { RequestEnvelope } from './request-envelope'
import type { TaskTypeResolution } from './run-contracts'

export function resolveTaskType(params: {
  intent: IntentClassification
  envelope: RequestEnvelope
  capabilities: CapabilityRuntimeSnapshot
  currentTaskContext?: {
    continuationTaskId?: string | null
  } | null
}): TaskTypeResolution {
  if (params.currentTaskContext?.continuationTaskId) {
    return {
      taskType: 'continuation',
      executionChain: 'continuation',
      requiresPlanner: false,
      preferredExecutor: 'none',
    }
  }

  const userText = `${params.envelope.primaryInstruction}\n${params.envelope.pureUserText}`.trim()
  const normalized = userText.toLowerCase()
  const browserAvailable = params.capabilities.environment.browserHostAvailable
  const feishuConnected = params.capabilities.environment.feishuConnected
  const hasConcreteBrowserWork =
    params.intent.actionSignals.length > 0
    || params.envelope.environmentHints.hasAttachments
    || /https?:\/\/|www\./i.test(userText)
    || params.intent.objectSignals.some((signal) => /browser-live-info/i.test(signal))

  if (params.intent.primaryDomain === 'generic' && params.intent.confidence === 'low' && params.intent.actionSignals.length === 0) {
    return {
      taskType: 'direct_answer',
      executionChain: 'direct',
      requiresPlanner: false,
      preferredExecutor: 'none',
    }
  }

  if (params.intent.primaryDomain === 'browser') {
    if (!hasConcreteBrowserWork) {
      return {
        taskType: 'direct_answer',
        executionChain: 'direct',
        requiresPlanner: false,
        preferredExecutor: 'none',
      }
    }
    const looksLikeMediaTask = params.envelope.environmentHints.hasAttachments
      || /(上传|图片|图像|视频|提交)/.test(userText)
    if (!browserAvailable) {
      return {
        taskType: 'direct_answer',
        executionChain: 'direct',
        degradationReason: 'browser_host_unavailable',
        requiresPlanner: false,
        preferredExecutor: 'none',
      }
    }
    if (looksLikeMediaTask) {
      return {
        taskType: 'media_task',
        executionChain: 'domain_executor',
        requiresPlanner: false,
        preferredExecutor: 'browser',
      }
    }
    return {
      taskType: 'short_task',
      executionChain: 'tool_loop',
      requiresPlanner: false,
      preferredExecutor: 'browser',
    }
  }

  if (params.intent.primaryDomain === 'pet') {
    return {
      taskType: 'short_task',
      executionChain: 'tool_loop',
      requiresPlanner: false,
      preferredExecutor: 'none',
    }
  }

  if (params.intent.crossDomain) {
    return {
      taskType: 'multi_step_task',
      executionChain: 'planner',
      requiresPlanner: true,
      preferredExecutor: 'none',
    }
  }

  if (params.intent.primaryDomain === 'feishu' && !feishuConnected) {
    return {
      taskType: 'direct_answer',
      executionChain: 'direct',
      degradationReason: 'feishu_unavailable',
      requiresPlanner: false,
      preferredExecutor: 'none',
    }
  }

  if (params.intent.primaryDomain === 'document') {
    if (params.envelope.environmentHints.hasAttachments || /(widget|图表|卡片|生成)/i.test(normalized)) {
      return {
        taskType: 'media_task',
        executionChain: 'domain_executor',
        requiresPlanner: false,
        preferredExecutor: 'document',
      }
    }
    return {
      taskType: 'short_task',
      executionChain: 'tool_loop',
      requiresPlanner: false,
      preferredExecutor: 'document',
    }
  }

  if (params.intent.primaryDomain === 'skill') {
    return {
      taskType: 'multi_step_task',
      executionChain: 'domain_executor',
      requiresPlanner: false,
      preferredExecutor: 'skill',
    }
  }

  if (params.intent.primaryDomain === 'rss' || params.intent.primaryDomain === 'calendar' || params.intent.primaryDomain === 'feishu') {
    return {
      taskType: params.intent.confidence === 'high' ? 'short_task' : 'multi_step_task',
      executionChain: params.intent.confidence === 'high' ? 'tool_loop' : 'planner',
      requiresPlanner: params.intent.confidence !== 'high',
      preferredExecutor: params.intent.primaryDomain,
    }
  }

  return {
    taskType: 'direct_answer',
    executionChain: 'direct',
    requiresPlanner: false,
    preferredExecutor: 'none',
  }
}
