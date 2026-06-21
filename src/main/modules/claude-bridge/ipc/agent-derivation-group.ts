import { basename } from 'node:path'
import type { IpcMain } from 'electron'
import type { AgentFactoryRegistry } from '../../agent-control/agents/agent-factory'
import { evaluateSpecialistBlueprintAdmission } from '../../agent-control/agents/specialist-blueprint-admission'
import type { SpecialistBlueprintStore } from '../../agent-control/agents/specialist-blueprint-store'
import type { BeliefCard, BeliefCardStore } from '../../agent-control/knowledge/belief-card-store'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintAdmissionVerdict,
  SpecialistBlueprintKnowledgeSeed,
  SpecialistBlueprintStatus,
} from '../../../../shared/agent-specialist-blueprint'
import { renderSpecialistFoundationMarkdown } from '../../agent-control/agents/specialist-blueprint-quality'
import {
  buildSpecialistBlueprintClarificationContract,
  type SpecialistBlueprintClarificationContract,
} from '../../../../shared/agent-specialist-blueprint-clarification'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
}

export interface AgentDerivationMigrationCandidate {
  relPath: string
  title: string
  description: string
}

export interface AgentDerivationCandidate {
  candidateRelPath: string
  title: string
  description: string
  bodyPreview: string
  evidenceDates: string[]
  defaultSpecialistId: string
  defaultName: string
  defaultCharter: string
  defaultSeedRulesText: string
  defaultRoutingTriggers: string[]
  migrationCandidates: AgentDerivationMigrationCandidate[]
}

export interface AgentDerivationConfirmPayload {
  candidateRelPath?: string
  specialistId?: string
  name?: string
  charter?: string | null
  seedRulesText?: string
  routingTriggers?: string[]
  activateRouting?: boolean
  migrateCardRelPaths?: string[]
}

export interface AgentDerivationConfirmResult {
  blueprint: SpecialistAgentBlueprint
  blueprintId: string
  specialistId: string
  status: SpecialistBlueprintStatus
  verdict: SpecialistBlueprintAdmissionVerdict
  missing: string[]
  clarification?: SpecialistBlueprintClarificationContract
  createdAgent: false
  routingActivated: false
  migratedCards: []
}

export interface AgentDerivationGroupDeps {
  getBeliefCardStore(): BeliefCardStore | null
  getAgentRegistry(): AgentFactoryRegistry
  getBlueprintStore(): SpecialistBlueprintStore
  now?: () => Date
}

const CHANNELS = [
  'agent:derivation:listCandidates',
  'agent:derivation:confirm',
  'agent:derivation:reject',
] as const

const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g
const DATE_LINE_RE = /\b20\d{2}-\d{2}-\d{2}\b/
const TRIGGER_FORBIDDEN_PATTERN = /[*?[\]{}()|\\^$+]/

function uniqueDates(body: string): string[] {
  const dates: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(DATE_RE)) {
    const date = match[1]
    if (seen.has(date)) continue
    seen.add(date)
    dates.push(date)
  }
  return dates
}

function extractDomain(card: BeliefCard): string {
  const title = card.frontmatter.title.replace(/^专项 agent 候选[:：]\s*/, '').trim()
  return title || card.frontmatter.title
}

function slugFromRelPath(relPath: string): string {
  const base = basename(relPath, '.md')
    .replace(/^agent-candidate-/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'specialist'
}

function normalizeTrigger(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 32 || TRIGGER_FORBIDDEN_PATTERN.test(trimmed)) return null
  return trimmed
}

function buildDefaultRules(name: string, domain: string, card: BeliefCard, dates: string[]): string {
  const evidence = card.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && DATE_LINE_RE.test(line))
    .slice(0, 5)
  return [
    `# ${name}`,
    '',
    `- 稳定承担与「${domain}」重复出现的相似请求。`,
    '- 只根据用户当前任务、已确认知识和候选卡证据行动。',
    '- 需要迁移长期知识、改变路由或调整站点风险时，先交给用户确认。',
    '',
    '证据来源：',
    ...evidence,
    ...(evidence.length === 0 ? dates.slice(0, 3).map((date) => `- ${date} ${card.frontmatter.title}`) : []),
  ].join('\n')
}

function defaultKnowledgeSeed(candidate: AgentDerivationCandidate, card: BeliefCard): SpecialistBlueprintKnowledgeSeed {
  return {
    title: `${candidate.title} 证据摘要`,
    body: card.body.slice(0, 2000),
    evidenceRefs: [candidate.candidateRelPath, ...candidate.evidenceDates.slice(0, 5)],
  }
}

function migrationCandidatesFor(store: BeliefCardStore, card: BeliefCard, domain: string): AgentDerivationMigrationCandidate[] {
  const needle = domain.toLowerCase()
  if (!needle) return []
  return store
    .listCards()
    .filter((entry) =>
      entry.relPath !== card.relPath
      && entry.frontmatter.status === 'active'
      && !/(^|\/)knowledge\/sites\//.test(entry.relPath)
      && !/(^|\/)knowledge\/routing-[a-z0-9._-]+\.md$/.test(entry.relPath)
      && `${entry.frontmatter.title}\n${entry.frontmatter.description}\n${entry.body}`.toLowerCase().includes(needle))
    .slice(0, 12)
    .map((entry) => ({
      relPath: entry.relPath,
      title: entry.frontmatter.title,
      description: entry.frontmatter.description,
    }))
}

export function listDerivationCandidates(store: BeliefCardStore): AgentDerivationCandidate[] {
  return store
    .listCards({ includeStaged: true })
    .filter((card) =>
      card.frontmatter.status === 'staged'
      && card.frontmatter.tag === 'aspire'
      && card.frontmatter.stage === 'candidate')
    .map((card) => {
      const evidenceDates = uniqueDates(card.body)
      return { card, evidenceDates }
    })
    .filter(({ evidenceDates }) => evidenceDates.length >= 3)
    .map(({ card, evidenceDates }) => {
      const domain = extractDomain(card)
      const defaultName = `${domain}专项 Agent`
      const trigger = normalizeTrigger(domain)
      return {
        candidateRelPath: card.relPath,
        title: card.frontmatter.title,
        description: card.frontmatter.description,
        bodyPreview: card.body.slice(0, 700),
        evidenceDates,
        defaultSpecialistId: slugFromRelPath(card.relPath),
        defaultName,
        defaultCharter: card.frontmatter.description,
        defaultSeedRulesText: buildDefaultRules(defaultName, domain, card, evidenceDates),
        defaultRoutingTriggers: trigger ? [trigger] : [],
        migrationCandidates: migrationCandidatesFor(store, card, domain),
      }
    })
    .sort((a, b) => a.candidateRelPath.localeCompare(b.candidateRelPath))
}

function cleanString(value: unknown): string {
  return String(value || '').trim()
}

function statusForVerdict(verdict: SpecialistBlueprintAdmissionVerdict): SpecialistBlueprintStatus {
  if (verdict.kind === 'admit') return 'staged'
  if (verdict.kind === 'clarify') return 'needs_clarification'
  return 'rejected'
}

function buildBlueprintFromCandidate(
  candidate: AgentDerivationCandidate,
  card: BeliefCard,
  payload: AgentDerivationConfirmPayload,
  migrateCardRelPaths: readonly string[],
  createdAt: string,
): SpecialistAgentBlueprint {
  const specialistId = cleanString(payload?.specialistId) || candidate.defaultSpecialistId
  const name = cleanString(payload?.name) || candidate.defaultName
  const charter = cleanString(payload?.charter) || candidate.defaultCharter
  const seedRulesText = cleanString(payload?.seedRulesText) || candidate.defaultSeedRulesText
  const routingTriggers = (payload?.routingTriggers ?? candidate.defaultRoutingTriggers).map(cleanString).filter(Boolean)
  const provenanceText = `从涌现候选卡生成：${card.frontmatter.title}`
  const blueprint: SpecialistAgentBlueprint = {
    blueprintId: `bp-${specialistId}`,
    status: 'draft',
    inferredScope: {
      slug: specialistId,
      displayName: name,
      domain: extractDomain(card),
      routingTriggers,
    },
    foundationDocs: {
      status: 'staged',
      charter,
      rulesText: seedRulesText,
      knowledgeSeeds: [defaultKnowledgeSeed(candidate, card)],
      toolSafetyNotes: '自动派生候选只生成蓝图；创建、路由激活和知识迁移都必须等用户确认。',
      foundationText: '',
    },
    provenance: {
      userRequestVerbatim: provenanceText,
      sourceSessionId: null,
      sourceRunId: null,
      sourceMessageId: null,
      sourceMessageUnavailableReason: 'message_id_unavailable',
      createdAt,
    },
    confirmation: {
      tokenId: null,
      confirmedAt: null,
      usedAt: null,
    },
    rolePersona: `${name} 只作为候选专项 agent 草案存在，等用户补齐稳定职责、判断口径和边界后才能创建。`,
    taskExamples: {
      suitable: [],
      unsuitable: [],
    },
    mainVsSpecialistSplit: '',
    toolBoundaries: {
      browser: { mode: 'confirm', notes: '候选草案阶段不允许自动浏览或接管用户浏览器。' },
      write: { mode: 'confirm', notes: '候选草案阶段不写入长期资产，创建前必须用户确认。' },
      externalSend: { mode: 'deny', notes: '候选草案不得外发消息、文件或网络请求。' },
      longMemory: { mode: 'confirm', notes: '候选草案只能保留 staged 证据，长期记忆写入必须用户确认。' },
    },
    memoryProfilePolicy: '',
    lifecycleNotes: '',
    specialistId,
    displayName: name,
    charter,
    intendedDomain: extractDomain(card),
    nonGoals: [],
    recurringTasks: [],
    requiredInputs: [],
    expectedOutputs: [],
    routingTriggers,
    routingActivateOnCreate: false,
    seedRulesText,
    knowledgeSeeds: [defaultKnowledgeSeed(candidate, card)],
    migrationCandidates: [...migrateCardRelPaths],
    toolSafetyNotes: '自动派生候选只生成蓝图；创建、路由激活和知识迁移都必须等用户确认。',
    source: 'emergence-candidate',
    userRequestVerbatim: provenanceText,
    clarificationAnswers: [],
    admissionVerdict: { kind: 'clarify', missing: ['admission_not_run'] },
    qualityChecks: [],
  }
  blueprint.foundationDocs.foundationText = renderSpecialistFoundationMarkdown(blueprint)
  return blueprint
}

function confirmDerivation(deps: AgentDerivationGroupDeps, payload: AgentDerivationConfirmPayload): AgentDerivationConfirmResult {
  const store = deps.getBeliefCardStore()
  if (!store) throw new Error('Belief card store not available')
  const candidateRelPath = cleanString(payload?.candidateRelPath)
  const candidate = listDerivationCandidates(store).find((item) => item.candidateRelPath === candidateRelPath)
  if (!candidate) throw new Error('Derivation candidate not found or no longer eligible')
  const card = store.readCard(candidateRelPath, { includeStaged: true })
  if (!card) throw new Error('Derivation candidate card not found')
  const allowedMigrations = new Set(candidate.migrationCandidates.map((item) => item.relPath))
  const migrateCardRelPaths = (payload?.migrateCardRelPaths ?? []).map(cleanString).filter(Boolean)
  const illegalMigration = migrateCardRelPaths.find((relPath) => !allowedMigrations.has(relPath))
  if (illegalMigration) throw new Error(`Migration card was not offered for this candidate: ${illegalMigration}`)
  const draft = buildBlueprintFromCandidate(
    candidate,
    card,
    payload,
    migrateCardRelPaths,
    (deps.now ? deps.now() : new Date()).toISOString(),
  )
  const current = deps.getBlueprintStore().get(draft.blueprintId)
  if (current?.status === 'confirmed') throw new Error('confirmed blueprint cannot be overwritten')
  const admission = evaluateSpecialistBlueprintAdmission(deps.getAgentRegistry(), draft)
  const status = statusForVerdict(admission.verdict)
  const blueprint = deps.getBlueprintStore().upsert({
    ...draft,
    status,
    admissionVerdict: admission.verdict,
    qualityChecks: admission.qualityChecks,
    foundationDocs: {
      ...draft.foundationDocs,
      foundationText: renderSpecialistFoundationMarkdown({
        ...draft,
        status,
        admissionVerdict: admission.verdict,
        qualityChecks: admission.qualityChecks,
      }),
    },
  })
  const clarification = status === 'needs_clarification' && admission.verdict.kind === 'clarify'
    ? buildSpecialistBlueprintClarificationContract(blueprint, admission.verdict.missing)
    : null
  return {
    blueprint,
    blueprintId: blueprint.blueprintId,
    specialistId: blueprint.specialistId,
    status,
    verdict: admission.verdict,
    missing: admission.missing,
    ...(clarification ? { clarification } : {}),
    createdAgent: false,
    routingActivated: false,
    migratedCards: [],
  }
}

function rejectDerivation(deps: AgentDerivationGroupDeps, payload: { candidateRelPath?: string }): AgentDerivationCandidate[] {
  const store = deps.getBeliefCardStore()
  if (!store) throw new Error('Belief card store not available')
  const relPath = cleanString(payload?.candidateRelPath)
  const candidate = listDerivationCandidates(store).find((item) => item.candidateRelPath === relPath)
  if (!candidate) throw new Error('Derivation candidate not found or no longer eligible')
  if (!store.transition(relPath, 'rejected')) throw new Error('Derivation candidate rejection failed')
  return listDerivationCandidates(store)
}

export const agentDerivationGroup: IpcChannelGroup<AgentDerivationGroupDeps> = {
  namespace: 'agent:derivation',

  register(ipcMain: IpcMain, deps: AgentDerivationGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('agent:derivation:listCandidates', (): IPCResponse<AgentDerivationCandidate[]> => {
      try {
        const store = deps.getBeliefCardStore()
        if (!store) return { success: false, error: 'Belief card store not available' }
        return { success: true, data: listDerivationCandidates(store) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:derivation:confirm', (_, payload: AgentDerivationConfirmPayload): IPCResponse<AgentDerivationConfirmResult> => {
      try {
        return { success: true, data: confirmDerivation(deps, payload) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorKind: 'input_validation',
        }
      }
    })

    ipcMain.handle('agent:derivation:reject', (_, payload: { candidateRelPath?: string }): IPCResponse<AgentDerivationCandidate[]> => {
      try {
        return { success: true, data: rejectDerivation(deps, payload) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorKind: 'input_validation',
        }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
        }
      },
    }
  },
}

export const _agentDerivationGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
