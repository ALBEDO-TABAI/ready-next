import { createHash } from 'node:crypto'

export function serializeWorkflowJson(value: unknown, field: string): string {
  const raw = JSON.stringify(value)
  if (typeof raw !== 'string') throw new Error(`${field}_not_json_serializable`)
  try {
    JSON.parse(raw)
  } catch {
    throw new Error(`${field}_not_json_serializable`)
  }
  return raw
}

export function digestSerializedJson(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Digest of the exact JSON semantics persisted by the workflow repository. */
export function workflowDigest(value: unknown): string {
  return digestSerializedJson(serializeWorkflowJson(value, 'workflow_value'))
}

export function parseJsonStrict(raw: string | null | undefined, field: string): unknown {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error(`${field}_missing`)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${field}_corrupt`)
  }
}

export function parseArrayStrict<T>(raw: string | null | undefined, field: string): T[] {
  const parsed = parseJsonStrict(raw, field)
  if (!Array.isArray(parsed)) throw new Error(`${field}_wrong_shape`)
  return parsed as T[]
}

export function parseObjectStrict<T extends object>(
  raw: string | null | undefined,
  field: string,
): T {
  const parsed = parseJsonStrict(raw, field)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field}_wrong_shape`)
  }
  return parsed as T
}
