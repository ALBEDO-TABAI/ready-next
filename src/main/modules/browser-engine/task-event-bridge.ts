import {
  BROWSER_CAPABILITY_TASK_KINDS,
  type BrowserCapabilityTaskKind,
  type BrowserCapabilityTaskStatus,
} from './capability-types'
import { enqueueBackgroundTaskTerminalReminderFromBridge } from '../agent-control/system-reminders/background-task-terminal-reminder'

export type TaskEventBridgeStatus =
  | 'completed'
  | 'failed'
  | 'paused'
  | 'needs_attention'
  | 'waiting_human'

const BROWSER_TASK_BRIDGE_PUBLISH: Record<BrowserCapabilityTaskStatus, TaskEventBridgeStatus | null> = {
  queued: null,
  running: null,
  waiting_human: 'waiting_human',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: null,
}

export interface TaskEventBridgePayload {
  taskId: string
  status: TaskEventBridgeStatus
  extra?: unknown
}

export type TaskEventBridgeConsumer = (payload: TaskEventBridgePayload) => void

export function isTaskEventBridgeStatus(status: string): status is TaskEventBridgeStatus {
  return status === 'completed'
    || status === 'failed'
    || status === 'paused'
    || status === 'needs_attention'
    || status === 'waiting_human'
}

export function toBridgeStatus(status: BrowserCapabilityTaskStatus): TaskEventBridgeStatus | null {
  return BROWSER_TASK_BRIDGE_PUBLISH[status]
}

class TaskEventBridge {
  private readonly projectionSinks = new Set<TaskEventBridgeConsumer>()
  private readonly agentNotifiers = new Set<TaskEventBridgeConsumer>()
  private readonly publishedKeys = new Set<string>()
  private readonly registeredRoutes = new Set<string>(BROWSER_CAPABILITY_TASK_KINDS)

  registerProjectionSink(fn: TaskEventBridgeConsumer): () => void {
    this.projectionSinks.add(fn)
    return () => {
      this.projectionSinks.delete(fn)
    }
  }

  registerAgentNotifier(fn: TaskEventBridgeConsumer): () => void {
    this.agentNotifiers.add(fn)
    return () => {
      this.agentNotifiers.delete(fn)
    }
  }

  registerTaskRoute(routeKey: string): () => void {
    this.registeredRoutes.add(routeKey)
    return () => {
      this.registeredRoutes.delete(routeKey)
    }
  }

  publish(payload: TaskEventBridgePayload): void {
    const key = `${payload.taskId}|${payload.status}`
    if (payload.status === 'completed' || payload.status === 'failed') {
      if (this.publishedKeys.has(key)) return
      this.publishedKeys.add(key)
    }
    for (const sink of this.projectionSinks) sink(payload)
    for (const notifier of this.agentNotifiers) notifier(payload)
  }

  scheduleTask(taskId: string, routeKey: string): void {
    if (this.registeredRoutes.has(routeKey)) return
    throw new Error(`Cannot schedule task ${taskId}: unregistered task route ${routeKey}`)
  }
}

export const taskEventBridge = new TaskEventBridge()

taskEventBridge.registerAgentNotifier(enqueueBackgroundTaskTerminalReminderFromBridge)
