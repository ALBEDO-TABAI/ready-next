import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import {
  BeliefCardStore,
  isAllowedCardPath,
  isSafeAgentScopeId,
  parseTriggersValue,
  type BeliefCard,
  type BeliefCardFrontmatter,
} from '../knowledge/belief-card-store'

export const DERIVED_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/
const EVIDENCE_DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/g

export interface AgentFactoryRegistry {
  get(id: string): AgentRegistryRecord | null
  create(input: {
    id: string
    name: string
    charter?: string | null
    personaRef?: string | null
    parentAgentId?: string | null
    derivationReason?: string | null
  }): AgentRegistryRecord
}

export interface DeriveSpecialistAgentInput {
  specialistId: string
  name: string
  charter?: string | null
  parentAgentId?: string | null
  candidateRelPath: string
  seedRulesText: string
  routingTriggers: string[]
  routingBody?: string
  activateRouting?: boolean
  migrateCardRelPaths?: string[]
  now?: Date
}

export interface DeriveSpecialistAgentResult {
  agent: AgentRegistryRecord
  rulesRelPath: string
  routingCardRelPath: string
  migratedCards: Array<{ from: string; to: string }>
}

export interface AgentKnowledgeMigrationPlan {
  fromAgentId: string
  toAgentId: string
  cardMigrations: Array<{ from: string; to: string }>
}

export interface SpecialistAgentDerivationPlan {
  specialistId: string
  name: string
  charter: string | null
  parentAgentId: string
  candidateRelPath: string
  rulesRelPath: string
  routingCardRelPath: string
  seedRulesText: string
  routingTriggers: string[]
  routingBody: string
  activateRouting: boolean
  cardMigrations: Array<{ from: string; to: string }>
  created: string
}

function assertDerivedAgentId(id: string): void {
  if (!DERIVED_AGENT_ID.test(id)) {
    throw new Error('[agent-factory] specialist id must be a lowercase slug')
  }
}

function absInside(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  const normalizedRoot = resolve(root)
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    throw new Error('[agent-factory] path escapes memory root')
  }
  return abs
}

function ensureNonEmpty(value: string, label: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) throw new Error(`[agent-factory] ${label} is required`)
  return trimmed
}

function countUniqueEvidenceDates(body: string): number {
  const dates = new Set<string>()
  for (const match of body.matchAll(EVIDENCE_DATE_RE)) dates.add(match[0])
  return dates.size
}

function assertEligibleCandidate(card: BeliefCard, relPath: string): void {
  if (
    card.frontmatter.status !== 'staged'
    || card.frontmatter.tag !== 'aspire'
    || card.frontmatter.stage !== 'candidate'
  ) {
    throw new Error(`[agent-factory] candidate card is not an eligible staged candidate: ${relPath}`)
  }
  if (countUniqueEvidenceDates(card.body) < 3) {
    throw new Error(`[agent-factory] candidate card needs at least 3 evidence dates: ${relPath}`)
  }
}

function migrateCard(store: BeliefCardStore, agentId: string, relPath: string): { from: string; to: string } {
  const { from, to } = planCardMigration(store, agentId, relPath)
  const fromAbs = absInside(store.rootPath, from)
  const toAbs = absInside(store.rootPath, to)
  mkdirSync(dirname(toAbs), { recursive: true })
  renameSync(fromAbs, toAbs)
  return { from, to }
}

function planCardMigration(store: BeliefCardStore, agentId: string, relPath: string): { from: string; to: string } {
  const normalized = relPath.replace(/\\/g, '/')
  if (!isAllowedCardPath(normalized)) throw new Error(`[agent-factory] invalid source card path: ${relPath}`)
  const card = store.readCard(normalized, { includeStaged: true })
  if (!card) throw new Error(`[agent-factory] source card not found: ${relPath}`)
  const siteSegment = normalized.includes('/sites/') ? 'sites/' : ''
  const target = `agents/${agentId}/knowledge/${siteSegment}${basename(normalized)}`
  if (!isAllowedCardPath(target)) throw new Error(`[agent-factory] invalid target card path: ${target}`)
  const toAbs = absInside(store.rootPath, target)
  if (existsSync(toAbs)) throw new Error(`[agent-factory] target card already exists: ${target}`)
  return { from: normalized, to: target }
}

function planAgentKnowledgeCardMigration(
  store: BeliefCardStore,
  fromAgentId: string,
  toAgentId: string,
  relPath: string,
): { from: string; to: string } {
  if (!isSafeAgentScopeId(fromAgentId) || !isSafeAgentScopeId(toAgentId)) {
    throw new Error('[agent-factory] invalid agent id for migration')
  }
  const normalized = relPath.replace(/\\/g, '/')
  const prefix = `agents/${fromAgentId}/knowledge/`
  if (!normalized.startsWith(prefix)) {
    throw new Error(`[agent-factory] source card is not owned by merged agent: ${relPath}`)
  }
  if (!isAllowedCardPath(normalized)) throw new Error(`[agent-factory] invalid source card path: ${relPath}`)
  const card = store.readCard(normalized, { includeStaged: true })
  if (!card) throw new Error(`[agent-factory] source card not found: ${relPath}`)
  const suffix = normalized.slice(prefix.length)
  const target = `agents/${toAgentId}/knowledge/${suffix}`
  if (!isAllowedCardPath(target)) throw new Error(`[agent-factory] invalid target card path: ${target}`)
  const toAbs = absInside(store.rootPath, target)
  if (existsSync(toAbs)) throw new Error(`[agent-factory] target card already exists: ${target}`)
  return { from: normalized, to: target }
}

export function prepareAgentKnowledgeMigration(
  store: BeliefCardStore,
  fromAgentId: string,
  toAgentId: string,
  relPaths: readonly string[],
): AgentKnowledgeMigrationPlan {
  const from = ensureNonEmpty(fromAgentId, 'from agent id')
  const to = ensureNonEmpty(toAgentId, 'to agent id')
  if (from === to) throw new Error('[agent-factory] migration target must be another agent')
  return {
    fromAgentId: from,
    toAgentId: to,
    cardMigrations: relPaths.map((relPath) => planAgentKnowledgeCardMigration(store, from, to, relPath)),
  }
}

export function migrateAgentKnowledgeCards(
  store: BeliefCardStore,
  fromAgentId: string,
  toAgentId: string,
  relPaths: readonly string[],
): Array<{ from: string; to: string }> {
  const plan = prepareAgentKnowledgeMigration(store, fromAgentId, toAgentId, relPaths)
  return plan.cardMigrations.map((migration) => {
    const fromAbs = absInside(store.rootPath, migration.from)
    const toAbs = absInside(store.rootPath, migration.to)
    mkdirSync(dirname(toAbs), { recursive: true })
    renameSync(fromAbs, toAbs)
    return migration
  })
}

export function prepareSpecialistAgentDerivation(
  registry: AgentFactoryRegistry,
  store: BeliefCardStore,
  input: DeriveSpecialistAgentInput,
): SpecialistAgentDerivationPlan {
  const specialistId = ensureNonEmpty(input.specialistId, 'specialist id')
  assertDerivedAgentId(specialistId)
  if (registry.get(specialistId)) throw new Error(`[agent-factory] agent already exists: ${specialistId}`)

  const name = ensureNonEmpty(input.name, 'name')
  const now = input.now ?? new Date()
  const created = now.toISOString().slice(0, 10)
  const candidateRelPath = ensureNonEmpty(input.candidateRelPath, 'candidate relPath').replace(/\\/g, '/')
  const candidate = store.readCard(candidateRelPath, { includeStaged: true })
  if (!candidate) {
    throw new Error(`[agent-factory] candidate card not found: ${candidateRelPath}`)
  }
  assertEligibleCandidate(candidate, candidateRelPath)
  const parentAgentId = input.parentAgentId ?? MAIN_AGENT_ID

  const seedRulesText = ensureNonEmpty(input.seedRulesText, 'seed rules')
  const rulesRelPath = `agents/${specialistId}/RULES.md`
  const routingCardRelPath = `knowledge/routing-${specialistId}.md`
  const triggers = parseTriggersValue(input.routingTriggers)
  if (!triggers.ok) throw new Error(`[agent-factory] invalid routing triggers: ${triggers.reason}`)
  if (existsSync(absInside(store.rootPath, rulesRelPath))) {
    throw new Error(`[agent-factory] agent rules already exist: ${rulesRelPath}`)
  }
  if (existsSync(absInside(store.rootPath, `agents/${specialistId}/knowledge`))) {
    throw new Error(`[agent-factory] agent knowledge directory already exists: agents/${specialistId}/knowledge`)
  }
  if (existsSync(absInside(store.rootPath, routingCardRelPath))) {
    throw new Error(`[agent-factory] routing card already exists: ${routingCardRelPath}`)
  }
  return {
    specialistId,
    name,
    charter: input.charter ?? null,
    parentAgentId,
    candidateRelPath,
    rulesRelPath,
    routingCardRelPath,
    seedRulesText,
    routingTriggers: triggers.triggers ?? [],
    routingBody: input.routingBody || `确认后将相关请求转给 ${name}。`,
    activateRouting: input.activateRouting === true,
    cardMigrations: (input.migrateCardRelPaths ?? []).map((relPath) => planCardMigration(store, specialistId, relPath)),
    created,
  }
}

export function deriveSpecialistAgent(
  registry: AgentFactoryRegistry,
  store: BeliefCardStore,
  input: DeriveSpecialistAgentInput,
): DeriveSpecialistAgentResult {
  const plan = prepareSpecialistAgentDerivation(registry, store, input)

  const agent = registry.create({
    id: plan.specialistId,
    name: plan.name,
    charter: plan.charter,
    parentAgentId: plan.parentAgentId,
    derivationReason: plan.candidateRelPath,
  })

  const agentKnowledgeDir = `agents/${plan.specialistId}/knowledge`
  mkdirSync(absInside(store.rootPath, join(agentKnowledgeDir, 'sites')), { recursive: true })

  const rulesAbs = absInside(store.rootPath, plan.rulesRelPath)
  writeFileSync(rulesAbs, `${plan.seedRulesText}\n`, 'utf-8')

  const migratedCards = plan.cardMigrations.map((migration) => migrateCard(store, plan.specialistId, migration.from))

  const routingFrontmatter: BeliefCardFrontmatter = {
    title: `路由：${plan.name}`,
    description: plan.charter || `${plan.name} 专项 agent 路由卡`,
    confidence: 'H',
    tag: 'self',
    created: plan.created,
    status: plan.activateRouting ? 'active' : 'staged',
    source: `derived-from:${plan.candidateRelPath}`,
    triggers: plan.routingTriggers,
  }
  const routing = store.writeCard({
    relPath: plan.routingCardRelPath,
    frontmatter: routingFrontmatter,
    body: plan.routingBody,
  })
  if (!routing.ok) throw new Error(`[agent-factory] routing card rejected: ${routing.reason}`)

  const candidate = store.readCard(plan.candidateRelPath, { includeStaged: true })
  if (candidate) {
    const next: BeliefCardFrontmatter = { ...candidate.frontmatter, stage: 'emerged' }
    const updated = store.writeCard({ relPath: plan.candidateRelPath, frontmatter: next, body: candidate.body })
    if (!updated.ok) throw new Error(`[agent-factory] candidate update rejected: ${updated.reason}`)
  }

  return { agent, rulesRelPath: plan.rulesRelPath, routingCardRelPath: plan.routingCardRelPath, migratedCards }
}
