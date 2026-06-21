import { createHash } from 'node:crypto'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type { CheckInRecord } from '../quality/task-adjudicator'
import type { BeliefCardStore } from '../knowledge/belief-card-store'
import {
  hashSpecialistStudioContent,
  type AgentRegistryReader,
  type SpecialistContentEditProposalStore,
} from './specialist-content-edit-proposals'
import type { AgentSystemStudioContentEditProposal } from '../../../../shared/agent-system-studio'

export interface SpecialistTaskEvolutionProposalDeps {
  registry: AgentRegistryReader
  store: BeliefCardStore
  proposalStore: SpecialistContentEditProposalStore
  now?: Date
}

export interface StageSpecialistTaskEvolutionProposalInput {
  projection: TaskProjectionRecord
  checkIn: CheckInRecord
  terminalStatus?: string | null
  terminalReason?: string | null
}

export type SpecialistTaskEvolutionProposalResult =
  | { status: 'staged'; proposal: AgentSystemStudioContentEditProposal }
  | { status: 'skipped'; reason: string; proposal?: AgentSystemStudioContentEditProposal }

function isActiveSpecialist(agent: AgentRegistryRecord | null): agent is AgentRegistryRecord {
  return Boolean(agent && agent.id !== MAIN_AGENT_ID && agent.status === 'active')
}

function isSuccessTerminalStatus(value: string | null | undefined): boolean {
  return value === 'done' || value === 'completed'
}

function stableSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
  if (slug) return slug
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function proposalIdFor(input: { agentId: string; taskId: string; runId: string; relPath: string }): string {
  const digest = createHash('sha256')
    .update(input.agentId)
    .update('\0')
    .update(input.taskId)
    .update('\0')
    .update(input.runId)
    .update('\0')
    .update(input.relPath)
    .digest('hex')
    .slice(0, 28)
  return `sce_task_${digest}`
}

function summarizeRef(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 220)
  if (!value || typeof value !== 'object') return String(value).slice(0, 220)
  const record = value as Record<string, unknown>
  const direct = ['summary', 'description', 'title', 'path', 'relPath', 'ref', 'id']
    .map((key) => record[key])
    .find((entry) => typeof entry === 'string' && entry.trim())
  if (typeof direct === 'string') return direct.trim().slice(0, 220)
  try {
    return JSON.stringify(record).slice(0, 220)
  } catch {
    return '[unserializable learning ref]'
  }
}

function renderTaskEvolutionBody(input: {
  projection: TaskProjectionRecord
  checkIn: CheckInRecord
  terminalReason?: string | null
}): string {
  const projection = input.projection
  const learningRefs = Array.isArray(projection.learningRefs) ? projection.learningRefs : []
  const proofRefs = Array.isArray(projection.proofRefs) ? projection.proofRefs : []
  const checkins = Array.isArray(projection.checkins) ? projection.checkins : []
  const title = projection.taskTitle?.trim() || projection.taskId
  const summary = projection.taskSummary?.trim() || '无任务摘要'
  const lines = [
    `# ${title}`,
    '',
    `- Task: ${projection.taskId}`,
    `- Run: ${projection.runId}`,
    `- Scope: ${projection.scopeId}`,
    `- Terminal: ${input.terminalReason || 'done'}`,
    `- Check-in: ${input.checkIn.verdict}`,
    `- Proof count: ${proofRefs.length}`,
    `- Prior check-ins: ${checkins.length}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Learning refs',
    '',
    ...learningRefs.map((ref) => `- ${summarizeRef(ref)}`),
    '',
    '## Use',
    '',
    'Keep this learning only if it is stable enough to help the specialist handle similar future work.',
  ]
  return lines.join('\n').trim() + '\n'
}

export function stageSpecialistTaskEvolutionProposal(
  deps: SpecialistTaskEvolutionProposalDeps,
  input: StageSpecialistTaskEvolutionProposalInput,
): SpecialistTaskEvolutionProposalResult {
  if (!isSuccessTerminalStatus(input.terminalStatus)) {
    return { status: 'skipped', reason: 'terminal_status_not_success' }
  }
  if (input.checkIn.verdict !== 'accept') {
    return { status: 'skipped', reason: 'checkin_not_accept' }
  }
  const projection = input.projection
  const ownerAgentId = String(projection.ownerAgentId || '').trim()
  if (!ownerAgentId) return { status: 'skipped', reason: 'missing_owner_agent' }
  const agent = deps.registry.get(ownerAgentId)
  if (!isActiveSpecialist(agent)) return { status: 'skipped', reason: 'owner_not_active_specialist' }
  const learningRefs = Array.isArray(projection.learningRefs) ? projection.learningRefs : []
  if (learningRefs.length === 0) return { status: 'skipped', reason: 'missing_learning_refs' }

  const relPath = `agents/${ownerAgentId}/knowledge/task-evolution-${stableSlug(projection.taskId)}.md`
  const proposalId = proposalIdFor({
    agentId: ownerAgentId,
    taskId: projection.taskId,
    runId: projection.runId,
    relPath,
  })
  const existing = deps.proposalStore.get(proposalId)
  if (existing) return { status: 'skipped', reason: 'already_exists', proposal: existing }

  const now = (deps.now ?? new Date()).toISOString()
  const proposedContent = renderTaskEvolutionBody({
    projection,
    checkIn: input.checkIn,
    terminalReason: input.terminalReason,
  })
  const proposal = deps.proposalStore.upsert({
    proposalId,
    agentId: ownerAgentId,
    targetKind: 'knowledge_card',
    targetRelPath: relPath,
    baseHash: hashSpecialistStudioContent(''),
    baseContent: '',
    proposedContent,
    status: 'staged',
    provenance: {
      source: 'task_evolution',
      sessionId: projection.scopeId,
      note: input.terminalReason ?? null,
      taskId: projection.taskId,
      runId: projection.runId,
      scopeId: projection.scopeId,
      taskTitle: projection.taskTitle ?? null,
      taskSummary: projection.taskSummary ?? null,
    },
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
  })
  return { status: 'staged', proposal }
}
