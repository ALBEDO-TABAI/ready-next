import type { DatabaseConnection } from '../../database/connection'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'

import type {
  AgentSystemStudioContentEditProposal,
  AgentSystemStudioContentEditProposalStatus,
  AgentSystemStudioContentEditTargetKind,
  AgentSystemStudioStageContentEditInput,
} from '../../../../shared/agent-system-studio'
import {
  BeliefCardStore,
  isAllowedCardPath,
  isSafeAgentScopeId,
  type BeliefCard,
  type BeliefCardFrontmatter,
} from '../knowledge/belief-card-store'

interface SpecialistContentEditProposalStoreOptions {
  getRawDb?: () => DatabaseConnection | null
}

interface SpecialistContentEditProposalRow {
  proposal_id: string
  agent_id: string
  target_kind: AgentSystemStudioContentEditTargetKind
  target_rel_path: string
  base_hash: string
  base_content: string
  proposed_content: string
  status: AgentSystemStudioContentEditProposalStatus
  provenance_json: string
  created_at: string
  updated_at: string
  applied_at: string | null
}

export interface AgentRegistryReader {
  get(id: string): AgentRegistryRecord | null
}

export interface StageSpecialistContentEditDeps {
  registry: AgentRegistryReader
  store: BeliefCardStore
  proposalStore: SpecialistContentEditProposalStore
  now?: Date
}

export interface ResolveSpecialistContentEditDeps {
  registry: AgentRegistryReader
  store: BeliefCardStore
  proposalStore: SpecialistContentEditProposalStore
  now?: Date
}

interface ResolvedTarget {
  kind: AgentSystemStudioContentEditTargetKind
  relPath: string
  baseContent: string
  knowledgeCard: BeliefCard | null
  missingKnowledgeCard: boolean
}

function cloneProposal(proposal: AgentSystemStudioContentEditProposal): AgentSystemStudioContentEditProposal {
  return JSON.parse(JSON.stringify(proposal)) as AgentSystemStudioContentEditProposal
}

export function hashSpecialistStudioContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function absInside(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  const normalizedRoot = resolve(root)
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    throw new Error('[specialist-content-edit] path escapes memory root')
  }
  return abs
}

function readPlainTarget(store: BeliefCardStore, relPath: string): string {
  const abs = absInside(store.rootPath, relPath)
  if (!existsSync(abs)) return ''
  return readFileSync(abs, 'utf8')
}

function writePlainTarget(store: BeliefCardStore, relPath: string, content: string): void {
  const abs = absInside(store.rootPath, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${randomUUID()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, abs)
}

function assertActiveSpecialist(registry: AgentRegistryReader, agentId: string): AgentRegistryRecord {
  const agent = registry.get(agentId)
  if (!agent) throw new Error('[specialist-content-edit] agent not found')
  if (agent.id === MAIN_AGENT_ID) throw new Error('[specialist-content-edit] main agent is read-only')
  if (agent.status !== 'active') throw new Error('[specialist-content-edit] only active specialist agents can be edited')
  return agent
}

function resolveTarget(store: BeliefCardStore, input: {
  agentId: string
  targetKind: AgentSystemStudioContentEditTargetKind
  targetRelPath?: string | null
}, options: { allowMissingKnowledgeCard?: boolean } = {}): ResolvedTarget {
  const agentId = String(input.agentId || '').trim()
  if (!isSafeAgentScopeId(agentId)) throw new Error('[specialist-content-edit] invalid agent id')
  if (input.targetKind === 'rules') {
    const relPath = `agents/${agentId}/RULES.md`
    return { kind: input.targetKind, relPath, baseContent: readPlainTarget(store, relPath), knowledgeCard: null, missingKnowledgeCard: false }
  }
  if (input.targetKind === 'foundation') {
    const relPath = `agents/${agentId}/FOUNDATION.md`
    return { kind: input.targetKind, relPath, baseContent: readPlainTarget(store, relPath), knowledgeCard: null, missingKnowledgeCard: false }
  }

  const relPath = String(input.targetRelPath || '').trim().replace(/\\/g, '/')
  const prefix = `agents/${agentId}/knowledge/`
  if (!relPath.startsWith(prefix) || !isAllowedCardPath(relPath)) {
    throw new Error('[specialist-content-edit] invalid knowledge card target')
  }
  const card = store.readCard(relPath, { includeStaged: true })
  if (!card) {
    if (options.allowMissingKnowledgeCard) {
      return { kind: input.targetKind, relPath, baseContent: '', knowledgeCard: null, missingKnowledgeCard: true }
    }
    throw new Error('[specialist-content-edit] knowledge card not found')
  }
  return { kind: input.targetKind, relPath, baseContent: card.body, knowledgeCard: card, missingKnowledgeCard: false }
}

function isTaskEvolutionProposal(proposal: AgentSystemStudioContentEditProposal): boolean {
  return proposal.provenance.source === 'task_evolution'
}

function clipContentLabel(value: string | null | undefined, fallback: string): string {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  return (text || fallback).slice(0, 120)
}

function taskEvolutionKnowledgeFrontmatter(
  proposal: AgentSystemStudioContentEditProposal,
  now: Date,
): BeliefCardFrontmatter {
  const taskId = proposal.provenance.taskId || proposal.proposalId
  const title = `任务学习：${clipContentLabel(proposal.provenance.taskTitle, taskId)}`
  const description = `来自任务 ${clipContentLabel(taskId, proposal.proposalId)} 的确认学习`
  return {
    title,
    description,
    confidence: 'M',
    tag: 'knowledge',
    created: now.toISOString().slice(0, 10),
    status: 'active',
    source: `task:${clipContentLabel(taskId, proposal.proposalId)}`,
  }
}

export class SpecialistContentEditProposalStore {
  private readonly proposals = new Map<string, AgentSystemStudioContentEditProposal>()
  private readonly getRawDb?: () => DatabaseConnection | null

  constructor(options: SpecialistContentEditProposalStoreOptions = {}) {
    this.getRawDb = options.getRawDb
  }

  list(statuses?: readonly AgentSystemStudioContentEditProposalStatus[]): AgentSystemStudioContentEditProposal[] {
    if (statuses && statuses.length === 0) return []
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) return []
      const rows = statuses?.length
        ? db.prepare(
          `SELECT proposal_id, agent_id, target_kind, target_rel_path, base_hash, base_content,
                  proposed_content, status, provenance_json, created_at, updated_at, applied_at
           FROM specialist_content_edit_proposals
           WHERE status IN (${statuses.map(() => '?').join(', ')})
           ORDER BY updated_at DESC, proposal_id ASC`,
        ).all<SpecialistContentEditProposalRow>(...statuses)
        : db.prepare(
          `SELECT proposal_id, agent_id, target_kind, target_rel_path, base_hash, base_content,
                  proposed_content, status, provenance_json, created_at, updated_at, applied_at
           FROM specialist_content_edit_proposals
           ORDER BY updated_at DESC, proposal_id ASC`,
        ).all<SpecialistContentEditProposalRow>()
      return rows.map((row) => this.parseRow(row))
    }

    const allowed = statuses ? new Set(statuses) : null
    return [...this.proposals.values()]
      .filter((proposal) => !allowed || allowed.has(proposal.status))
      .map(cloneProposal)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.proposalId.localeCompare(b.proposalId))
  }

  listForAgent(agentId: string): AgentSystemStudioContentEditProposal[] {
    const id = String(agentId || '').trim()
    return this.list().filter((proposal) => proposal.agentId === id)
  }

  get(proposalId: string): AgentSystemStudioContentEditProposal | null {
    const id = String(proposalId || '').trim()
    if (!id) return null
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) return null
      const row = db.prepare(
        `SELECT proposal_id, agent_id, target_kind, target_rel_path, base_hash, base_content,
                proposed_content, status, provenance_json, created_at, updated_at, applied_at
         FROM specialist_content_edit_proposals
         WHERE proposal_id = ?`,
      ).get<SpecialistContentEditProposalRow>(id)
      return row ? this.parseRow(row) : null
    }
    const proposal = this.proposals.get(id)
    return proposal ? cloneProposal(proposal) : null
  }

  upsert(proposal: AgentSystemStudioContentEditProposal): AgentSystemStudioContentEditProposal {
    const next = cloneProposal(proposal)
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) throw new Error('[specialist-content-edit-store] database not available')
      db.prepare(
        `INSERT INTO specialist_content_edit_proposals (
          proposal_id, agent_id, target_kind, target_rel_path, base_hash, base_content,
          proposed_content, status, provenance_json, created_at, updated_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposal_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          target_kind = excluded.target_kind,
          target_rel_path = excluded.target_rel_path,
          base_hash = excluded.base_hash,
          base_content = excluded.base_content,
          proposed_content = excluded.proposed_content,
          status = excluded.status,
          provenance_json = excluded.provenance_json,
          updated_at = excluded.updated_at,
          applied_at = excluded.applied_at`,
      ).run(
        next.proposalId,
        next.agentId,
        next.targetKind,
        next.targetRelPath,
        next.baseHash,
        next.baseContent,
        next.proposedContent,
        next.status,
        JSON.stringify(next.provenance),
        next.createdAt,
        next.updatedAt,
        next.appliedAt,
      )
      return cloneProposal(next)
    }
    this.proposals.set(next.proposalId, next)
    return cloneProposal(next)
  }

  patch(
    proposalId: string,
    patch: Partial<AgentSystemStudioContentEditProposal>,
  ): AgentSystemStudioContentEditProposal {
    const current = this.get(proposalId)
    if (!current) throw new Error('[specialist-content-edit-store] proposal not found')
    return this.upsert({ ...current, ...patch, proposalId: current.proposalId })
  }

  private resolveDb(): DatabaseConnection | null {
    return this.getRawDb ? this.getRawDb() : null
  }

  private parseRow(row: SpecialistContentEditProposalRow): AgentSystemStudioContentEditProposal {
    return {
      proposalId: row.proposal_id,
      agentId: row.agent_id,
      targetKind: row.target_kind,
      targetRelPath: row.target_rel_path,
      baseHash: row.base_hash,
      baseContent: row.base_content,
      proposedContent: row.proposed_content,
      status: row.status,
      provenance: JSON.parse(row.provenance_json) as AgentSystemStudioContentEditProposal['provenance'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at ?? null,
    }
  }
}

export function stageSpecialistContentEdit(
  deps: StageSpecialistContentEditDeps,
  input: AgentSystemStudioStageContentEditInput,
): AgentSystemStudioContentEditProposal {
  const agentId = String(input.agentId || '').trim()
  assertActiveSpecialist(deps.registry, agentId)
  const proposedContent = String(input.proposedContent ?? '')
  if (!proposedContent.trim()) throw new Error('[specialist-content-edit] proposed content is required')
  const target = resolveTarget(deps.store, {
    agentId,
    targetKind: input.targetKind,
    targetRelPath: input.targetRelPath,
  })
  const now = (deps.now ?? new Date()).toISOString()
  return deps.proposalStore.upsert({
    proposalId: `sce_${randomUUID()}`,
    agentId,
    targetKind: target.kind,
    targetRelPath: target.relPath,
    baseHash: hashSpecialistStudioContent(target.baseContent),
    baseContent: target.baseContent,
    proposedContent,
    status: 'staged',
    provenance: {
      source: 'studio',
      sessionId: input.sessionId ? String(input.sessionId) : null,
      note: input.note ? String(input.note) : null,
    },
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
  })
}

export function confirmSpecialistContentEdit(
  deps: ResolveSpecialistContentEditDeps,
  proposalId: string,
): AgentSystemStudioContentEditProposal {
  const proposal = deps.proposalStore.get(proposalId)
  if (!proposal) throw new Error('[specialist-content-edit] proposal not found')
  if (proposal.status !== 'staged') throw new Error('[specialist-content-edit] only staged proposals can be confirmed')
  assertActiveSpecialist(deps.registry, proposal.agentId)

  const target = resolveTarget(deps.store, {
    agentId: proposal.agentId,
    targetKind: proposal.targetKind,
    targetRelPath: proposal.targetRelPath,
  }, { allowMissingKnowledgeCard: proposal.targetKind === 'knowledge_card' && isTaskEvolutionProposal(proposal) })
  const now = (deps.now ?? new Date()).toISOString()
  if (hashSpecialistStudioContent(target.baseContent) !== proposal.baseHash) {
    return deps.proposalStore.patch(proposal.proposalId, {
      status: 'conflict',
      updatedAt: now,
    })
  }

  if (proposal.targetKind === 'knowledge_card') {
    const card = target.knowledgeCard ?? deps.store.readCard(proposal.targetRelPath, { includeStaged: true })
    if (!card && !target.missingKnowledgeCard) throw new Error('[specialist-content-edit] knowledge card not found')
    const frontmatter = card?.frontmatter ?? taskEvolutionKnowledgeFrontmatter(proposal, deps.now ?? new Date(now))
    const written = deps.store.writeCard({
      relPath: proposal.targetRelPath,
      frontmatter,
      body: proposal.proposedContent,
    })
    if (!written.ok) throw new Error(`[specialist-content-edit] knowledge card write rejected: ${written.reason}`)
  } else {
    writePlainTarget(deps.store, proposal.targetRelPath, proposal.proposedContent)
  }

  return deps.proposalStore.patch(proposal.proposalId, {
    status: 'applied',
    updatedAt: now,
    appliedAt: now,
  })
}

export function rejectSpecialistContentEdit(
  deps: ResolveSpecialistContentEditDeps,
  proposalId: string,
): AgentSystemStudioContentEditProposal {
  const proposal = deps.proposalStore.get(proposalId)
  if (!proposal) throw new Error('[specialist-content-edit] proposal not found')
  if (proposal.status !== 'staged') throw new Error('[specialist-content-edit] only staged proposals can be rejected')
  assertActiveSpecialist(deps.registry, proposal.agentId)
  const now = (deps.now ?? new Date()).toISOString()
  return deps.proposalStore.patch(proposal.proposalId, {
    status: 'rejected',
    updatedAt: now,
  })
}
