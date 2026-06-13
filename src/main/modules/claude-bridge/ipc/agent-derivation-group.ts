import { basename } from 'node:path'
import type { IpcMain } from 'electron'
import {
  deriveSpecialistAgent,
  type AgentFactoryRegistry,
  type DeriveSpecialistAgentInput,
} from '../../agent-control/agents/agent-factory'
import type { BeliefCard, BeliefCardStore } from '../../agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
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
  agent: AgentRegistryRecord
  rulesRelPath: string
  routingCardRelPath: string
  migratedCards: Array<{ from: string; to: string }>
}

export interface AgentDerivationGroupDeps {
  getBeliefCardStore(): BeliefCardStore | null
  getAgentRegistry(): AgentFactoryRegistry
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

function confirmDerivation(deps: AgentDerivationGroupDeps, payload: AgentDerivationConfirmPayload): AgentDerivationConfirmResult {
  const store = deps.getBeliefCardStore()
  if (!store) throw new Error('Belief card store not available')
  const candidateRelPath = cleanString(payload?.candidateRelPath)
  const candidate = listDerivationCandidates(store).find((item) => item.candidateRelPath === candidateRelPath)
  if (!candidate) throw new Error('Derivation candidate not found or no longer eligible')
  const allowedMigrations = new Set(candidate.migrationCandidates.map((item) => item.relPath))
  const migrateCardRelPaths = (payload?.migrateCardRelPaths ?? []).map(cleanString).filter(Boolean)
  const illegalMigration = migrateCardRelPaths.find((relPath) => !allowedMigrations.has(relPath))
  if (illegalMigration) throw new Error(`Migration card was not offered for this candidate: ${illegalMigration}`)
  const input: DeriveSpecialistAgentInput = {
    candidateRelPath,
    specialistId: cleanString(payload?.specialistId),
    name: cleanString(payload?.name),
    charter: cleanString(payload?.charter),
    seedRulesText: cleanString(payload?.seedRulesText),
    routingTriggers: (payload?.routingTriggers ?? []).map(cleanString).filter(Boolean),
    activateRouting: payload?.activateRouting === true,
    migrateCardRelPaths,
  }
  return deriveSpecialistAgent(deps.getAgentRegistry(), store, input)
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
