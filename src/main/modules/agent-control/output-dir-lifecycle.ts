import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { atomicWriteJson } from './atomic-write'

export type OutputDirLifecycleState = 'active' | 'retained' | 'expired'

export interface OutputDirLifecycle {
  state: OutputDirLifecycleState
  childRunId: string
  skillId: string
  terminalAt?: string
  terminalReason?: string
  retainUntil?: string
}

const LIFECYCLE_FILENAME = '.lifecycle.json'

export function lifecyclePath(outputDir: string): string {
  return path.join(outputDir, LIFECYCLE_FILENAME)
}

export function readLifecycle(outputDir: string): OutputDirLifecycle | null {
  const file = lifecyclePath(outputDir)
  if (!existsSync(file)) return null
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  return parseLifecycle(parsed)
}

export function writeLifecycle(outputDir: string, lifecycle: OutputDirLifecycle): void {
  atomicWriteJson(lifecyclePath(outputDir), lifecycle)
}

export function shouldRetain(lifecycle: OutputDirLifecycle, now: Date): boolean {
  if (lifecycle.state === 'active') return true
  if (lifecycle.state === 'expired') return false
  if (!lifecycle.retainUntil) return true
  const retainUntilMs = Date.parse(lifecycle.retainUntil)
  if (!Number.isFinite(retainUntilMs)) return true
  return retainUntilMs > now.getTime()
}

function parseLifecycle(value: unknown): OutputDirLifecycle {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid outputDir lifecycle: expected object')
  }
  const raw = value as Record<string, unknown>
  if (raw.state !== 'active' && raw.state !== 'retained' && raw.state !== 'expired') {
    throw new Error('Invalid outputDir lifecycle: invalid state')
  }
  if (typeof raw.childRunId !== 'string' || raw.childRunId.trim().length === 0) {
    throw new Error('Invalid outputDir lifecycle: invalid childRunId')
  }
  if (typeof raw.skillId !== 'string' || raw.skillId.trim().length === 0) {
    throw new Error('Invalid outputDir lifecycle: invalid skillId')
  }
  const lifecycle: OutputDirLifecycle = {
    state: raw.state,
    childRunId: raw.childRunId,
    skillId: raw.skillId,
  }
  if (typeof raw.terminalAt === 'string') lifecycle.terminalAt = raw.terminalAt
  if (typeof raw.terminalReason === 'string') lifecycle.terminalReason = raw.terminalReason
  if (typeof raw.retainUntil === 'string') lifecycle.retainUntil = raw.retainUntil
  return lifecycle
}
