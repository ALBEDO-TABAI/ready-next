import {
  BROWSER_CAPABILITY_TASK_KINDS,
  type BrowserCapabilityTaskHandle,
  type BrowserCapabilityTaskKind,
} from './capability-types'
import { enqueueBackgroundTaskTerminalReminderFromBridge } from '../agent-control/system-reminders/background-task-terminal-reminder'

export type TaskEventBridgeStatus =
  | 'completed'
  | 'failed'
  | 'paused'
  | 'needs_attention'
  | 'waiting_human'

export interface TaskEventBridgePayload {
  taskId: string
  status: TaskEventBridgeStatus
  extra?: unknown
}

export type TaskEventBridgeConsumer = (payload: TaskEventBridgePayload) => void

export interface WaitingHumanBrowserTaskResumePort {
  getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> | BrowserCapabilityTaskHandle | null
  resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> | BrowserCapabilityTaskHandle | null
}

export interface WaitingHumanBrowserTaskResumeRequest {
  taskId?: string | null
  confirmed: boolean
}

export interface WaitingHumanBrowserTaskResumeResult {
  success: boolean
  task?: BrowserCapabilityTaskHandle | null
  error?: string
}

let waitingHumanBrowserTaskResumePort: WaitingHumanBrowserTaskResumePort | null = null

export function isTaskEventBridgeStatus(status: string): status is TaskEventBridgeStatus {
  return status === 'completed'
    || status === 'failed'
    || status === 'paused'
    || status === 'needs_attention'
    || status === 'waiting_human'
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
    if (this.publishedKeys.has(key)) return
    this.publishedKeys.add(key)
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

export function registerWaitingHumanBrowserTaskResumePort(
  port: WaitingHumanBrowserTaskResumePort,
): () => void {
  waitingHumanBrowserTaskResumePort = port
  return () => {
    if (waitingHumanBrowserTaskResumePort === port) {
      waitingHumanBrowserTaskResumePort = null
    }
  }
}

export async function resumeWaitingHumanBrowserTaskFromBridge(
  request: WaitingHumanBrowserTaskResumeRequest,
): Promise<WaitingHumanBrowserTaskResumeResult> {
  const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : ''
  if (!request.confirmed) return { success: false, error: 'confirmation_required' }
  if (!taskId) return { success: false, error: 'missing_task_id' }
  if (!waitingHumanBrowserTaskResumePort) return { success: false, error: 'browser_task_resume_unavailable' }
  const current = await waitingHumanBrowserTaskResumePort.getTask(taskId)
  if (!current) return { success: false, error: 'browser_task_not_found' }
  if (current.status !== 'waiting_human') return { success: false, task: current, error: 'browser_task_not_waiting_human' }
  const resumed = await waitingHumanBrowserTaskResumePort.resumeTask(taskId)
  return { success: Boolean(resumed), task: resumed, error: resumed ? undefined : 'browser_task_resume_failed' }
}
