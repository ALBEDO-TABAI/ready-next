import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import type { SpecialistAgentBlueprint, SpecialistBlueprintKnowledgeSeed } from '../../../../shared/agent-specialist-blueprint'
import { isReservedAgentSlug } from '../../../../shared/agent-identity'
import {
  BeliefCardStore,
  isAllowedCardPath,
  isSafeAgentScopeId,
  parseTriggersValue,
  type BeliefCard,
  type BeliefCardFrontmatter,
} from '../knowledge/belief-card-store'
import { evaluateSpecialistBlueprintAdmission } from './specialist-blueprint-admission'
import {
  assertSpecialistBlueprintQualityPasses,
  renderSpecialistFoundationMarkdown,
} from './specialist-blueprint-quality'

export const DERIVED_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/
const EVIDENCE_DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/g

export interface AgentFactoryRegistry {
  get(id: string): AgentRegistryRecord | null
  list?(): AgentRegistryRecord[]
  create(input: {
    id: string
    name: string
    charter?: string | null
    personalityText?: string | null
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
  foundationRelPath?: string
  seedRelPaths: string[]
  routingCardRelPath: string
  migratedCards: Array<{ from: string; to: string }>
}

export interface DeriveSpecialistAgentFromBlueprintInput {
  blueprint: SpecialistAgentBlueprint
  confirmationTokenId: string
  parentAgentId?: string | null
  migrateCardRelPaths?: string[]
  now?: Date
}

export interface SpecialistAgentBlueprintDerivationPlan {
  specialistId: string
  name: string
  charter: string
  parentAgentId: string
  blueprintId: string
  confirmationTokenId: string
  rulesRelPath: string
  foundationRelPath: string
  routingCardRelPath: string
  seedRelPaths: string[]
  seedRulesText: string
  knowledgeSeeds: SpecialistBlueprintKnowledgeSeed[]
  routingTriggers: string[]
  routingBody: string
  cardMigrations: Array<{ from: string; to: string }>
  created: string
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
  if (isReservedAgentSlug(id)) {
    throw new Error('[agent-factory] specialist id is reserved')
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

function renderSpecialistPersonalityTextFromBlueprint(blueprint: SpecialistAgentBlueprint): string {
  return [
    `# ${blueprint.displayName}`,
    '',
    blueprint.rolePersona,
    '',
    `职责边界：${blueprint.charter}`,
    '',
    `与主 agent 分工：${blueprint.mainVsSpecialistSplit}`,
    '',
    '适合处理：',
    ...blueprint.recurringTasks.map((task) => `- ${task}`),
    '',
    '不负责：',
    ...blueprint.nonGoals.map((goal) => `- ${goal}`),
    '',
    '工作方式：保持引用和证据链清楚；遇到外发、写入长期资产、更新长期记忆或职责边界不清时，先等待用户确认。',
  ].join('\n')
}

function migrateCard(store: BeliefCardStore, agentId: string, relPath: string): { from: string; to: string } {
  const { from, to } = planCardMigration(store, agentId, relPath)
  const fromAbs = absInside(store.rootPath, from)
  const toAbs = absInside(store.rootPath, to)
  if (existsSync(toAbs)) throw new Error(`[agent-factory] target card already exists: ${to}`)
  mkdirSync(dirname(toAbs), { recursive: true })
  renameSync(fromAbs, toAbs)
  return { from, to }
}

function rollbackMigratedCards(store: BeliefCardStore, migratedCards: Array<{ from: string; to: string }>): void {
  for (const migration of migratedCards.reverse()) {
    const fromAbs = absInside(store.rootPath, migration.from)
    const toAbs = absInside(store.rootPath, migration.to)
    if (!existsSync(toAbs) || existsSync(fromAbs)) continue
    mkdirSync(dirname(fromAbs), { recursive: true })
    renameSync(toAbs, fromAbs)
  }
}

export function rollbackAgentKnowledgeCardMigrations(
  store: BeliefCardStore,
  migratedCards: Array<{ from: string; to: string }>,
): void {
  rollbackMigratedCards(store, [...migratedCards])
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
  const migratedCards: Array<{ from: string; to: string }> = []
  try {
    for (const migration of plan.cardMigrations) {
      const fromAbs = absInside(store.rootPath, migration.from)
      const toAbs = absInside(store.rootPath, migration.to)
      mkdirSync(dirname(toAbs), { recursive: true })
      renameSync(fromAbs, toAbs)
      migratedCards.push(migration)
    }
    return migratedCards
  } catch (error) {
    rollbackMigratedCards(store, migratedCards)
    throw error
  }
}

// P5e/C23 legacy dormant derivation path: retained for candidate-era tests only.
// Production specialist creation must use deriveSpecialistAgentFromBlueprint via agent:specialistBlueprint:confirmCreate.
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

// P5e/C23 legacy dormant derivation path: retained for candidate-era tests only.
// Production specialist creation must use deriveSpecialistAgentFromBlueprint via agent:specialistBlueprint:confirmCreate.
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

  return {
    agent,
    rulesRelPath: plan.rulesRelPath,
    seedRelPaths: [],
    routingCardRelPath: plan.routingCardRelPath,
    migratedCards,
  }
}

export function prepareSpecialistAgentFromBlueprint(
  registry: AgentFactoryRegistry,
  store: BeliefCardStore,
  input: DeriveSpecialistAgentFromBlueprintInput,
): SpecialistAgentBlueprintDerivationPlan {
  const blueprint = input.blueprint
  const confirmationTokenId = ensureNonEmpty(input.confirmationTokenId, 'confirmation token')
  if (blueprint.status !== 'confirmed') throw new Error('[agent-factory] blueprint must be confirmed')
  if (blueprint.confirmation.tokenId !== confirmationTokenId) throw new Error('[agent-factory] confirmation token mismatch')
  if (blueprint.admissionVerdict.kind !== 'admit') throw new Error('[agent-factory] blueprint admission must be admit')
  const admission = evaluateSpecialistBlueprintAdmission(registry, blueprint)
  if (admission.verdict.kind !== 'admit') throw new Error(`[agent-factory] blueprint admission rejected: ${admission.verdict.kind}`)
  assertSpecialistBlueprintQualityPasses(blueprint)

  const specialistId = ensureNonEmpty(blueprint.specialistId, 'specialist id')
  assertDerivedAgentId(specialistId)
  if (registry.get(specialistId)) throw new Error(`[agent-factory] agent already exists: ${specialistId}`)
  const name = ensureNonEmpty(blueprint.displayName, 'name')
  const charter = ensureNonEmpty(blueprint.charter || blueprint.foundationDocs.charter, 'charter')
  const seedRulesText = ensureNonEmpty(blueprint.foundationDocs.rulesText || blueprint.seedRulesText, 'seed rules')
  const triggers = parseTriggersValue(blueprint.routingTriggers)
  if (!triggers.ok) throw new Error(`[agent-factory] invalid routing triggers: ${triggers.reason}`)
  const rulesRelPath = `agents/${specialistId}/RULES.md`
  const foundationRelPath = `agents/${specialistId}/FOUNDATION.md`
  const routingCardRelPath = `knowledge/routing-${specialistId}.md`
  if (existsSync(absInside(store.rootPath, rulesRelPath))) {
    throw new Error(`[agent-factory] agent rules already exist: ${rulesRelPath}`)
  }
  if (existsSync(absInside(store.rootPath, foundationRelPath))) {
    throw new Error(`[agent-factory] agent foundation already exists: ${foundationRelPath}`)
  }
  if (existsSync(absInside(store.rootPath, `agents/${specialistId}/knowledge`))) {
    throw new Error(`[agent-factory] agent knowledge directory already exists: agents/${specialistId}/knowledge`)
  }
  if (existsSync(absInside(store.rootPath, routingCardRelPath))) {
    throw new Error(`[agent-factory] routing card already exists: ${routingCardRelPath}`)
  }
  const seedRelPaths = blueprint.foundationDocs.knowledgeSeeds.map((_, index) => (
    `agents/${specialistId}/knowledge/seed-${String(index + 1).padStart(2, '0')}.md`
  ))
  const allowedMigrations = new Set(blueprint.migrationCandidates.map((relPath) => relPath.replace(/\\/g, '/')))
  const selectedMigrations = [...new Set((input.migrateCardRelPaths ?? [])
    .map((relPath) => String(relPath || '').trim().replace(/\\/g, '/'))
    .filter(Boolean))]
  const illegalMigration = selectedMigrations.find((relPath) => !allowedMigrations.has(relPath))
  if (illegalMigration) {
    throw new Error(`[agent-factory] migration card was not offered for this blueprint: ${illegalMigration}`)
  }
  const cardMigrations = selectedMigrations.map((relPath) => planCardMigration(store, specialistId, relPath))
  const reservedSeedTargets = new Set(seedRelPaths)
  const reservedMigration = cardMigrations.find((migration) => reservedSeedTargets.has(migration.to))
  if (reservedMigration) {
    throw new Error(`[agent-factory] migration target conflicts with blueprint seed: ${reservedMigration.to}`)
  }
  const created = (input.now ?? new Date()).toISOString().slice(0, 10)
  return {
    specialistId,
    name,
    charter,
    parentAgentId: input.parentAgentId ?? MAIN_AGENT_ID,
    blueprintId: ensureNonEmpty(blueprint.blueprintId, 'blueprint id'),
    confirmationTokenId,
    rulesRelPath,
    foundationRelPath,
    routingCardRelPath,
    seedRelPaths,
    seedRulesText,
    knowledgeSeeds: blueprint.foundationDocs.knowledgeSeeds,
    routingTriggers: triggers.triggers ?? [],
    routingBody: `用户确认后将相关请求转给 ${name}。`,
    cardMigrations,
    created,
  }
}

export function deriveSpecialistAgentFromBlueprint(
  registry: AgentFactoryRegistry,
  store: BeliefCardStore,
  input: DeriveSpecialistAgentFromBlueprintInput,
): DeriveSpecialistAgentResult {
  const plan = prepareSpecialistAgentFromBlueprint(registry, store, input)
  const createdRelPaths: string[] = []
  const createdDirPaths: string[] = []
  const migratedCards: Array<{ from: string; to: string }> = []
  try {
    const agentDir = `agents/${plan.specialistId}`
    const agentKnowledgeDir = `agents/${plan.specialistId}/knowledge`
    const agentSitesDir = join(agentKnowledgeDir, 'sites')
    if (!existsSync(absInside(store.rootPath, agentDir))) createdDirPaths.push(agentDir)
    if (!existsSync(absInside(store.rootPath, agentKnowledgeDir))) createdDirPaths.push(agentKnowledgeDir)
    if (!existsSync(absInside(store.rootPath, agentSitesDir))) createdDirPaths.push(agentSitesDir)
    mkdirSync(absInside(store.rootPath, agentKnowledgeDir), { recursive: true })
    mkdirSync(absInside(store.rootPath, agentSitesDir), { recursive: true })

    const rulesAbs = absInside(store.rootPath, plan.rulesRelPath)
    writeFileSync(rulesAbs, `${plan.seedRulesText}\n`, 'utf-8')
    createdRelPaths.push(plan.rulesRelPath)

    const foundationAbs = absInside(store.rootPath, plan.foundationRelPath)
    writeFileSync(foundationAbs, `${renderSpecialistFoundationMarkdown(input.blueprint)}\n`, 'utf-8')
    createdRelPaths.push(plan.foundationRelPath)

    plan.knowledgeSeeds.forEach((seed, index) => {
      const relPath = plan.seedRelPaths[index]
      const written = store.writeCard({
        relPath,
        frontmatter: {
          title: seed.title,
          description: seed.evidenceRefs.join(', ') || '用户确认的专项 agent 初始知识',
          confidence: 'M',
          tag: 'knowledge',
          created: plan.created,
          status: 'staged',
          source: `blueprint:${plan.blueprintId}`,
        },
        body: seed.body,
      })
      if (!written.ok) throw new Error(`[agent-factory] blueprint knowledge seed rejected: ${written.reason}`)
      createdRelPaths.push(relPath)
    })

    for (const migration of plan.cardMigrations) {
      migratedCards.push(migrateCard(store, plan.specialistId, migration.from))
    }

    const routing = store.writeCard({
      relPath: plan.routingCardRelPath,
      frontmatter: {
        title: `路由：${plan.name}`,
        description: plan.charter,
        confidence: 'H',
        tag: 'self',
        created: plan.created,
        status: 'staged',
        source: `blueprint:${plan.blueprintId}`,
        triggers: plan.routingTriggers,
      },
      body: plan.routingBody,
    })
    if (!routing.ok) throw new Error(`[agent-factory] routing card rejected: ${routing.reason}`)
    createdRelPaths.push(plan.routingCardRelPath)

    const agent = registry.create({
      id: plan.specialistId,
      name: plan.name,
      charter: plan.charter,
      personalityText: renderSpecialistPersonalityTextFromBlueprint(input.blueprint),
      parentAgentId: plan.parentAgentId,
      derivationReason: `blueprint:${plan.blueprintId}`,
    })
    return {
      agent,
      rulesRelPath: plan.rulesRelPath,
      foundationRelPath: plan.foundationRelPath,
      seedRelPaths: plan.seedRelPaths,
      routingCardRelPath: plan.routingCardRelPath,
      migratedCards,
    }
  } catch (error) {
    rollbackMigratedCards(store, migratedCards)
    for (const relPath of createdRelPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { force: true })
    }
    for (const relPath of createdDirPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { recursive: true, force: true })
    }
    throw error
  }
}
