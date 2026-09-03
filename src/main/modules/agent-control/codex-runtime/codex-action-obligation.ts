import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { IntentClassification } from '../intent-classifier'
import { allowedProductActionsForTool } from './codex-product-action-map'

export type ReadyActionObligationOutcome =
  | 'start'
  | 'effect'
  | 'renderer_applied'
  | 'job_terminal_artifact'

export type ReadyActionObligationRequirement = Readonly<{
  requirementId: string
  domain: 'mcp' | 'pet' | 'rss'
  outcome: ReadyActionObligationOutcome
  allowedToolNames: readonly string[]
  allowedProductActions: readonly string[]
  target: Readonly<{ kind: string; id: string }> | null
  evidence: readonly string[]
  source: 'explicit_action' | 'explicit_resource' | 'explicit_mcp_selection'
}>

export type ReadyActionObligationSetV1 = Readonly<{
  contract: 'ready_action_obligation_set_v1'
  requirements: readonly ReadyActionObligationRequirement[]
  digest: string
}>

const nonEmpty = z.string().min(1)
const requirementSchema = z.object({
  requirementId: nonEmpty,
  domain: z.enum(['mcp', 'pet', 'rss']),
  outcome: z.enum(['start', 'effect', 'renderer_applied', 'job_terminal_artifact']),
  allowedToolNames: z.array(nonEmpty).min(1),
  allowedProductActions: z.array(nonEmpty),
  target: z.object({ kind: nonEmpty, id: nonEmpty }).strict().nullable(),
  evidence: z.array(nonEmpty),
  source: z.enum(['explicit_action', 'explicit_resource', 'explicit_mcp_selection']),
}).strict()

export const readyActionObligationSetSchema = z.object({
  contract: z.literal('ready_action_obligation_set_v1'),
  requirements: z.array(requirementSchema).max(8),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

function digestRequirements(requirements: readonly ReadyActionObligationRequirement[]): string {
  return createHash('sha256').update(JSON.stringify({
    contract: 'ready_action_obligation_set_v1',
    requirements,
  })).digest('hex')
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function requirement(input: Omit<ReadyActionObligationRequirement, 'requirementId' | 'allowedProductActions'>): ReadyActionObligationRequirement {
  const allowedToolNames = unique(input.allowedToolNames)
  const allowedProductActions = unique(allowedToolNames.flatMap((toolName) => (
    allowedProductActionsForTool(toolName)
  )))
  const identity = {
    domain: input.domain,
    outcome: input.outcome,
    allowedToolNames,
    allowedProductActions,
    target: input.target,
    evidence: unique(input.evidence),
    source: input.source,
  }
  return Object.freeze({
    requirementId: `ready-action-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)}`,
    ...identity,
    allowedToolNames: Object.freeze(allowedToolNames),
    allowedProductActions: Object.freeze(allowedProductActions),
    evidence: Object.freeze(identity.evidence),
    target: input.target ? Object.freeze({ ...input.target }) : null,
  })
}

export function createReadyActionObligationSet(
  requirements: readonly ReadyActionObligationRequirement[],
): ReadyActionObligationSetV1 {
  const canonical = requirements.slice(0, 8)
  return Object.freeze({
    contract: 'ready_action_obligation_set_v1',
    requirements: Object.freeze(canonical),
    digest: digestRequirements(canonical),
  })
}

export function emptyReadyActionObligationSet(): ReadyActionObligationSetV1 {
  return createReadyActionObligationSet([])
}

export function isReadyActionObligationSet(value: unknown): value is ReadyActionObligationSetV1 {
  const parsed = readyActionObligationSetSchema.safeParse(value)
  if (!parsed.success) return false
  const obligationSet = parsed.data
  if (obligationSet.digest !== digestRequirements(obligationSet.requirements)) return false
  const requirementIds = new Set<string>()
  for (const item of obligationSet.requirements) {
    if (requirementIds.has(item.requirementId)) return false
    requirementIds.add(item.requirementId)
    if (item.allowedToolNames.some((toolName) => !toolName.startsWith('mcp_')
      && allowedProductActionsForTool(toolName).length === 0)) return false
    const expectedActions = unique(item.allowedToolNames.flatMap((toolName) => (
      allowedProductActionsForTool(toolName)
    )))
    if (JSON.stringify(expectedActions) !== JSON.stringify(item.allowedProductActions)) return false
  }
  return true
}

type ResolverInput = {
  intent: Pick<IntentClassification, 'primaryDomain' | 'actionSignals'>
  allowedToolNames: readonly string[]
  productSurfaceTargets?: {
    rssItemId?: string | null
    rssSourceId?: string | null
  }
  primaryInstruction: string
}

function allowed(input: ResolverInput, names: readonly string[]): string[] {
  const allowSet = new Set(input.allowedToolNames)
  return names.filter((name) => allowSet.has(name))
}

function hasSignal(input: ResolverInput, signal: string): boolean {
  return input.intent.actionSignals.includes(signal)
}

export function resolveReadyActionObligationSet(input: ResolverInput): ReadyActionObligationSetV1 {
  const requirements: ReadyActionObligationRequirement[] = []

  if (input.intent.primaryDomain === 'pet') {
    const toolNames = hasSignal(input, 'pet-clear-action')
      ? allowed(input, ['pet_clear_sticky_notes'])
      : hasSignal(input, 'pet-dismiss-action')
        ? allowed(input, ['pet_dismiss_sticky_note'])
        : hasSignal(input, 'pet-show-action')
          ? allowed(input, ['pet_show_sticky_note'])
          : []
    if (toolNames.length > 0) {
      requirements.push(requirement({
        domain: 'pet',
        outcome: 'renderer_applied',
        allowedToolNames: toolNames,
        target: null,
        evidence: ['pet_snapshot_revision', 'pet_renderer_applied'],
        source: 'explicit_action',
      }))
    }
  }

  if (input.intent.primaryDomain === 'rss') {
    const rssItemId = input.productSurfaceTargets?.rssItemId || null
    const rssSourceId = input.productSurfaceTargets?.rssSourceId || null
    if (hasSignal(input, 'rss-analysis-start-action')) {
      const toolNames = allowed(input, ['rss_analyze_item'])
      if (toolNames.length > 0) requirements.push(requirement({
        domain: 'rss', outcome: 'start', allowedToolNames: toolNames,
        target: rssItemId ? { kind: 'rss_item', id: rssItemId } : null,
        evidence: ['rss_job_id', 'rss_job_started'],
        source: rssItemId ? 'explicit_resource' : 'explicit_action',
      }))
    } else if (hasSignal(input, 'rss-analysis-result-action')) {
      const toolNames = allowed(input, ['rss_analyze_item', 'rss_get_analysis_result'])
      if (toolNames.length > 0) requirements.push(requirement({
        domain: 'rss', outcome: 'job_terminal_artifact', allowedToolNames: toolNames,
        target: rssItemId ? { kind: 'rss_item', id: rssItemId } : null,
        evidence: ['rss_job_terminal', 'rss_report_digest'],
        source: rssItemId ? 'explicit_resource' : 'explicit_action',
      }))
    } else if (hasSignal(input, 'rss-select-action')) {
      const toolNames = allowed(input, ['rss_select_item'])
      if (toolNames.length > 0) requirements.push(requirement({
        domain: 'rss', outcome: 'renderer_applied', allowedToolNames: toolNames,
        target: rssItemId ? { kind: 'rss_item', id: rssItemId } : null,
        evidence: ['rss_item_id', 'rss_surface_generation'],
        source: rssItemId ? 'explicit_resource' : 'explicit_action',
      }))
    } else if (hasSignal(input, 'rss-add-source-action')) {
      const toolNames = allowed(input, ['rss_add_source'])
      if (toolNames.length > 0) requirements.push(requirement({
        domain: 'rss', outcome: 'effect', allowedToolNames: toolNames,
        target: rssSourceId ? { kind: 'rss_source', id: rssSourceId } : null,
        evidence: ['rss_source_readback'],
        source: rssSourceId ? 'explicit_resource' : 'explicit_action',
      }))
    } else if (hasSignal(input, 'rss-refresh-action')) {
      const toolNames = allowed(input, ['rss_fetch_updates'])
      if (toolNames.length > 0) requirements.push(requirement({
        domain: 'rss', outcome: 'effect', allowedToolNames: toolNames,
        target: null,
        evidence: ['rss_fetch_settled', 'rss_stats_readback'],
        source: 'explicit_action',
      }))
    }
  }

  const explicitMcpTools = input.allowedToolNames.filter((toolName) => (
    toolName.startsWith('mcp_') && input.primaryInstruction.includes(toolName)
  ))
  for (const toolName of explicitMcpTools) {
    requirements.push(requirement({
      domain: 'mcp', outcome: 'effect', allowedToolNames: [toolName],
      target: { kind: 'mcp_tool', id: toolName },
      evidence: ['mcp_tool_receipt'], source: 'explicit_mcp_selection',
    }))
  }

  return createReadyActionObligationSet(requirements)
}

export function actionObligationEvidenceMatches(
  obligation: ReadyActionObligationRequirement,
  toolName: string,
  result: unknown,
): boolean {
  if (!obligation.allowedToolNames.includes(toolName)
    || !result || typeof result !== 'object' || Array.isArray(result)) return false
  const value = result as Record<string, unknown>
  const envelope = value.envelope && typeof value.envelope === 'object' && !Array.isArray(value.envelope)
    ? value.envelope as Record<string, unknown>
    : null
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : envelope?.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown>
      : value
  if (value.success === false || data.ok === false || envelope?.ok === false) return false
  if (obligation.target) {
    if (obligation.target.kind === 'mcp_tool' && toolName !== obligation.target.id) return false
    const targetValues = [
      data.itemId, data.sourceId, data.noteId, data.ownerResourceId, data.toolName,
      data.selectedItemId,
    ].filter((candidate): candidate is string => typeof candidate === 'string')
    if (obligation.target.kind !== 'mcp_tool' && !targetValues.includes(obligation.target.id)) return false
  }
  if (obligation.outcome === 'renderer_applied') {
    return data.applied === true
      && Number.isInteger(data.appliedRevision ?? data.surfaceGeneration ?? data.snapshotRevision)
      && (obligation.domain !== 'pet'
        || (typeof data.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(data.contentDigest)))
  }
  if (obligation.outcome === 'start') {
    return typeof data.jobId === 'string'
      && ['queued', 'running_script', 'running_subagent', 'success'].includes(String(data.status))
  }
  if (obligation.outcome === 'job_terminal_artifact') {
    return data.status === 'success'
      && typeof data.jobId === 'string'
      && typeof data.reportPath === 'string'
      && /^[a-f0-9]{64}$/.test(String(data.reportDigest || ''))
  }
  if (obligation.domain === 'mcp') {
    return data.ok === true
      && data.toolName === toolName
      && typeof data.serverId === 'string'
      && Object.hasOwn(data, 'output')
  }
  if (toolName === 'rss_fetch_updates') {
    return ['completed', 'completed_with_warnings'].includes(String(data.status))
      && Number.isInteger(data.totalItems)
      && Number.isInteger(data.unreadItems)
  }
  if (toolName === 'rss_add_source') {
    return typeof data.sourceId === 'string'
      && ['added', 'already_exists'].includes(String(data.status))
  }
  return data.ok === true
}
