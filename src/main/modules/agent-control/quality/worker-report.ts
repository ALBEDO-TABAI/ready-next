export interface WorkerReport {
  version: 1
  packageId: string
  attempt: 0 | 1
  summaryLines: string[]
  deliverable: { inline?: string; resourceRefId?: string }
  criterionObservations: Array<{ criterionId: string; observation: string }>
  evidenceHandles: string[]
  unverifiedClaims: string[]
  openQuestions: string[]
  confidence: 'low' | 'medium' | 'high'
}

const REPORT_KEYS = new Set([
  'version',
  'packageId',
  'attempt',
  'summaryLines',
  'deliverable',
  'criterionObservations',
  'evidenceHandles',
  'unverifiedClaims',
  'openQuestions',
  'confidence',
])
const DELIVERABLE_KEYS = new Set(['inline', 'resourceRefId'])
const OBSERVATION_KEYS = new Set(['criterionId', 'observation'])

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[worker-report] ${label} must be an object`)
  }
}

function assertExactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`[worker-report] ${label} contains forbidden field(s): ${unknown.join(', ')}`)
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`[worker-report] ${label} must contain non-empty strings`)
  }
}

export function assertWorkerReport(value: unknown): asserts value is WorkerReport {
  assertRecord(value, 'report')
  assertExactKeys(value, REPORT_KEYS, 'report')
  if (value.version !== 1) throw new Error(`[worker-report] unsupported version: ${String(value.version)}`)
  if (typeof value.packageId !== 'string' || !value.packageId.trim()) throw new Error('[worker-report] packageId is required')
  if (value.attempt !== 0 && value.attempt !== 1) throw new Error('[worker-report] attempt must be 0 or 1')
  assertStringArray(value.summaryLines, 'summaryLines')
  if (value.summaryLines.length < 1 || value.summaryLines.length > 5) {
    throw new Error('[worker-report] summaryLines must contain 1..5 lines')
  }

  assertRecord(value.deliverable, 'deliverable')
  assertExactKeys(value.deliverable, DELIVERABLE_KEYS, 'deliverable')
  const inline = typeof value.deliverable.inline === 'string' ? value.deliverable.inline.trim() : ''
  const resourceRefId = typeof value.deliverable.resourceRefId === 'string' ? value.deliverable.resourceRefId.trim() : ''
  if (!inline && !resourceRefId) throw new Error('[worker-report] deliverable requires inline or resourceRefId')

  if (!Array.isArray(value.criterionObservations)) throw new Error('[worker-report] criterionObservations must be an array')
  for (const observation of value.criterionObservations) {
    assertRecord(observation, 'criterion observation')
    assertExactKeys(observation, OBSERVATION_KEYS, 'criterion observation')
    if (typeof observation.criterionId !== 'string' || !observation.criterionId.trim()) {
      throw new Error('[worker-report] criterionId is required')
    }
    if (typeof observation.observation !== 'string' || !observation.observation.trim()) {
      throw new Error('[worker-report] observation is required')
    }
  }
  assertStringArray(value.evidenceHandles, 'evidenceHandles')
  assertStringArray(value.unverifiedClaims, 'unverifiedClaims')
  assertStringArray(value.openQuestions, 'openQuestions')
  if (!['low', 'medium', 'high'].includes(String(value.confidence))) {
    throw new Error('[worker-report] confidence must be low, medium or high')
  }
}

export function parseWorkerReportJson(raw: string): WorkerReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''))
  } catch {
    throw new Error('[worker-report] invalid JSON')
  }
  assertWorkerReport(parsed)
  return parsed
}
