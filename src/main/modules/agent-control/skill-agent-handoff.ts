import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { atomicWriteJson } from './atomic-write'

export interface SkillHandoffWriteTarget {
  root: string
  relativePath: string
  receiptPath: string
  taskName: string
}

const PENDING_HANDOFF_STATUSES = new Set(['pending', 'in_progress', 'blocked'])
const HANDOFF_RECEIPT_LOCATIONS = [
  'audiovisual_handoff',
] as const

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isSafeRelativePath(value: string): boolean {
  if (isAbsolute(value)) return false
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..')
}

function targetPathForReceiptOutput(handoffDirName: string, output: string): string | null {
  const clean = output.replace(/\\/g, '/').trim()
  if (!isSafeRelativePath(clean)) return null
  if (clean === handoffDirName || clean.startsWith(`${handoffDirName}/`)) return clean
  return join(handoffDirName, clean)
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return null
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
