import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const HANDOFF_TIMEOUT_USER_MESSAGE = '报告生成超时，可继续重试'

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return 0
}

export function isSafeRelativePath(value: string): boolean {
  if (isAbsolute(value)) return false
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..')
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return null
  }
}
