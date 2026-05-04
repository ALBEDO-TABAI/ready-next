import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-write'
import {
  HANDOFF_TIMEOUT_USER_MESSAGE,
  isSafeRelativePath,
  numberValue,
  objectValue,
  readJson,
  stringValue,
} from './skill-handoff-shared'
import type { ScopeRunSkillHandoff } from './types'

export interface SkillHandoffWriteTarget {
  root: string
  relativePath: string
  receiptPath: string
  taskName: string
}

export type SkillHandoffState = ScopeRunSkillHandoff

const PENDING_HANDOFF_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'pending_retry'])
const HANDOFF_RECEIPT_LOCATIONS = [
  'audiovisual_handoff',
] as const

function targetPathForReceiptOutput(handoffDirName: string, output: string): string | null {
  const clean = output.replace(/\\/g, '/').trim()
  if (!isSafeRelativePath(clean)) return null
  if (clean === handoffDirName || clean.startsWith(`${handoffDirName}/`)) return clean
  return join(handoffDirName, clean)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function handoffSubject(taskName: string): string {
  if (taskName === 'body') return '视听报告正文'
  if (taskName === 'diagram') return '视听报告图表'
  if (taskName === 'illustrate') return '视听报告插图说明'
  return '视听报告'
}

function userMessageForHandoffState(args: {
  taskName: string
  status: ScopeRunSkillHandoff['status']
  lastErrorKind: string | null
  lastErrorMessage: string | null
}): string {
  const subject = handoffSubject(args.taskName)
  if (
    args.lastErrorKind === 'handoff_timeout'
    || args.lastErrorMessage === HANDOFF_TIMEOUT_USER_MESSAGE
    || args.lastErrorMessage === 'This operation was aborted'
  ) {
    return `${subject}生成超时，可继续重试。`
  }
  if (args.status === 'in_progress') return `${subject}正在生成。`
  if (args.status === 'completed') return `${subject}已生成。`
  if (args.status === 'failed') return `${subject}连续生成失败，需要检查后重试。`
  if (args.status === 'pending_retry') return `${subject}生成失败，可继续重试。`
  return `${subject}还需要继续生成。`
}

function actionLabelForHandoffState(status: ScopeRunSkillHandoff['status']): string {
  if (status === 'completed') return '打开报告'
  if (status === 'in_progress') return '查看进度'
  return '继续生成报告'
}

function normalizeLastErrorMessage(kind: string | null, message: string | null): string | null {
  if (kind === 'handoff_timeout' || message === 'This operation was aborted') {
    return HANDOFF_TIMEOUT_USER_MESSAGE
  }
  return message
}

export function updateSkillHandoffTaskState(args: {
  receiptPath: string
  taskName: string
  status: string
  attemptCount?: number
  lastErrorKind?: string | null
  lastErrorMessage?: string | null
  now?: () => Date
}): boolean {
  const receipt = readJson(args.receiptPath)
  const tasks = objectValue(receipt?.tasks)
  const task = objectValue(tasks?.[args.taskName])
  if (!receipt || !tasks || !task) return false
  const updatedAt = (args.now ? args.now() : new Date()).toISOString()
  const nextTask: Record<string, unknown> = {
    ...task,
    status: args.status,
    updated_at: updatedAt,
  }
  if (typeof args.attemptCount === 'number') {
    nextTask.attempt_count = Math.max(0, Math.floor(args.attemptCount))
  }
  if ('lastErrorKind' in args) {
    nextTask.last_error_kind = args.lastErrorKind
  }
  if ('lastErrorMessage' in args) {
    nextTask.last_error_message = args.lastErrorMessage
  }
  tasks[args.taskName] = nextTask
  atomicWriteJson(args.receiptPath, {
    ...receipt,
    tasks,
    updated_at: updatedAt,
  })
  return true
}

export function markSkillHandoffOutputCompleted(args: {
  receiptPath: string
  taskName: string
  outputPath: string
  now?: () => Date
}): boolean {
  const receipt = readJson(args.receiptPath)
  const tasks = objectValue(receipt?.tasks)
  const task = objectValue(tasks?.[args.taskName])
  if (!receipt || !tasks || !task || !existsSync(args.outputPath)) return false
  const updatedAt = (args.now ? args.now() : new Date()).toISOString()
  tasks[args.taskName] = {
    ...task,
    status: 'completed',
    updated_at: updatedAt,
    last_error_kind: null,
    last_error_message: null,
    output_hash: sha256File(args.outputPath),
  }
  atomicWriteJson(args.receiptPath, {
    ...receipt,
    tasks,
    updated_at: updatedAt,
  })
  return true
}

export function resolvePendingSkillHandoffWriteTargets(activeRoots: string[] | null | undefined): SkillHandoffWriteTarget[] {
  if (!Array.isArray(activeRoots) || activeRoots.length === 0) return []
  const targets: SkillHandoffWriteTarget[] = []
  const seen = new Set<string>()
  for (const root of activeRoots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue
    const activeRoot = root.trim()
    for (const handoffDirName of HANDOFF_RECEIPT_LOCATIONS) {
      const receiptPath = join(activeRoot, handoffDirName, 'receipt.json')
      if (!existsSync(receiptPath)) continue
      const receipt = readJson(receiptPath)
      const tasks = objectValue(receipt?.tasks)
      if (!tasks) continue
      for (const [taskName, rawTask] of Object.entries(tasks)) {
        const task = objectValue(rawTask)
        const status = stringValue(task?.status)?.toLowerCase()
        const output = stringValue(task?.output)
        if (!status || !PENDING_HANDOFF_STATUSES.has(status) || !output) continue
        const relativePath = targetPathForReceiptOutput(handoffDirName, output)
        if (!relativePath) continue
        const key = `${activeRoot}\0${relativePath}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({
          root: activeRoot,
          relativePath,
          receiptPath,
          taskName,
        })
      }
    }
  }
  return targets
}

export function readSkillHandoffStates(_outputDir: string): SkillHandoffState[] {
  const outputDir = _outputDir.trim()
  if (!outputDir) return []
  const states: SkillHandoffState[] = []
  for (const handoffDirName of HANDOFF_RECEIPT_LOCATIONS) {
    const receiptPath = join(outputDir, handoffDirName, 'receipt.json')
    if (!existsSync(receiptPath)) continue
    const receipt = readJson(receiptPath)
    const tasks = objectValue(receipt?.tasks)
    if (!tasks) continue
    for (const [taskName, rawTask] of Object.entries(tasks)) {
      const task = objectValue(rawTask)
      if (!task) continue
      const rawStatus = stringValue(task.status)?.toLowerCase() || 'pending'
      const status: ScopeRunSkillHandoff['status'] =
        rawStatus === 'in_progress'
        || rawStatus === 'pending_retry'
        || rawStatus === 'blocked'
        || rawStatus === 'failed'
        || rawStatus === 'completed'
          ? rawStatus
          : 'pending'
      const taskRel = stringValue(task.task) || join(handoffDirName, taskName, 'task.md')
      const outputRel = stringValue(task.output)
      if (!isSafeRelativePath(taskRel) || !outputRel) continue
      const relativeOutputPath = targetPathForReceiptOutput(handoffDirName, outputRel)
      if (!relativeOutputPath) continue
      const lastErrorKind = stringValue(task.last_error_kind)
      const lastErrorMessage = normalizeLastErrorMessage(lastErrorKind, stringValue(task.last_error_message))
      const userMessage = userMessageForHandoffState({
        taskName,
        status,
        lastErrorKind,
        lastErrorMessage,
      })
      states.push({
        status,
        kind: 'audiovisual_report',
        taskName,
        userMessage,
        actionLabel: actionLabelForHandoffState(status),
        attemptCount: numberValue(task.attempt_count ?? task.attempts),
        lastErrorKind,
        lastErrorMessage,
        taskPath: join(outputDir, taskRel),
        outputPath: join(outputDir, relativeOutputPath),
        updatedAt: stringValue(task.updated_at),
      })
    }
  }
  return states
}
