import { z } from 'zod'
import { BROWSER_SEQUENCE_STEP_TOOL_NAMES } from './browser-capability-registry'

/** The most steps one sequence may carry. */
export const BROWSER_SEQUENCE_MAX_STEPS = 6

export const BROWSER_SEQUENCE_DESCRIPTION = '把已确定的几步连续执行（如输入→回车→等待→快照）。任一步未成功即停，其后不执行。快照、查找、读取只能作最后一步。需用户确认的步骤须单独调用。'

export const BROWSER_SEQUENCE_SCHEMA = z.object({
  steps: z.array(z.object({
    tool: z.enum(BROWSER_SEQUENCE_STEP_TOOL_NAMES).describe('本轮已授权的白名单浏览器工具'),
    args: z.record(z.string(), z.unknown()).meta({ additionalProperties: true }).describe('该工具自己的参数，按该工具已登记的 schema 校验'),
  })).min(1).max(BROWSER_SEQUENCE_MAX_STEPS).describe('依次执行的步骤；任一步未成功即停'),
})

export type BrowserSequenceInput = z.infer<typeof BROWSER_SEQUENCE_SCHEMA>
export type BrowserSequenceStepToolName = (typeof BROWSER_SEQUENCE_STEP_TOOL_NAMES)[number]

/**
 * The steps whose result is a look at the page. One may only close a sequence: its result is handed back
 * whole, and a look taken mid-way would be thrown away while later snapshots are still written as changes
 * against it.
 */
export const BROWSER_SEQUENCE_PAGE_OBSERVATION_TOOL_NAMES: readonly BrowserSequenceStepToolName[] = [
  'browser_snapshot', 'browser_find', 'browser_read',
]

/** What one attempted step left behind. Page content is never kept here. */
export interface BrowserSequenceStepRecord {
  step: number
  tool: BrowserSequenceStepToolName
  ok: boolean
  /** Whether the input reached the page, for steps that act on it. */
  delivery?: 'delivered' | 'not_delivered' | 'unknown'
  /** Whether a change was seen right after the step, for steps that act on the page. */
  effect?: 'observed' | 'unknown'
  /** The address the step's page showed once the step was over. */
  url?: string
  /** The tab the step opened or was carried into. */
  newTabId?: string
  /** A native dialog was open once the step was over. */
  dialog?: 'open'
  /** What a tool without a structured result said, shortened. */
  note?: string
  errorKind?: string
  message?: string
}

export interface BrowserSequenceObservation {
  step: number
  tool: BrowserSequenceStepToolName
  /** The observation step's own result data, unchanged. */
  data: Record<string, unknown>
}

export interface BrowserSequenceResult {
  ok: boolean
  /** One record per attempted step, in order. */
  steps: BrowserSequenceStepRecord[]
  /** The result of the closing observation step, when the sequence reached it and it succeeded. */
  observation: BrowserSequenceObservation | null
  /** Steps that were never started. */
  notExecuted: Array<{ step: number; tool: BrowserSequenceStepToolName }>
  /** Set when the sequence did not run to its end. */
  errorKind?: string
  message?: string
  /** The step the sequence stopped at, counted from 1. */
  stoppedAt?: number
}

/** The sequence stopped before a step that changes the page because the step before it could not be confirmed. */
export const BROWSER_SEQUENCE_UNVERIFIED_ERROR_KIND = 'browser_sequence_previous_step_unverified'

function isStepTool(value: unknown): value is BrowserSequenceStepToolName {
  return typeof value === 'string' && (BROWSER_SEQUENCE_STEP_TOOL_NAMES as readonly string[]).includes(value)
}

/**
 * Reads a stored sequence result back. Anything that is not a sequence result reads as null, so a consumer
 * never has to guess at a shape it did not produce.
 */
export function readBrowserSequenceResult(data: unknown): BrowserSequenceResult | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.steps) || !Array.isArray(record.notExecuted)) return null
  const steps: BrowserSequenceStepRecord[] = []
  for (const entry of record.steps) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const step = entry as Record<string, unknown>
    if (!Number.isInteger(step.step) || !isStepTool(step.tool) || typeof step.ok !== 'boolean') return null
    steps.push(step as unknown as BrowserSequenceStepRecord)
  }
  let observation: BrowserSequenceObservation | null = null
  if (record.observation !== null && record.observation !== undefined) {
    if (typeof record.observation !== 'object' || Array.isArray(record.observation)) return null
    const value = record.observation as Record<string, unknown>
    if (!Number.isInteger(value.step) || !isStepTool(value.tool)
      || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return null
    observation = value as unknown as BrowserSequenceObservation
  }
  return { ...(record as unknown as BrowserSequenceResult), steps, observation }
}
