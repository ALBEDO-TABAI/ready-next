import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, statSync } from 'fs'
import { join, resolve, sep, dirname } from 'path'
import { randomUUID } from 'crypto'
import { logAgentMetric } from '../metrics'

/**
 * Belief card store (EP1-K1). File-is-truth knowledge cards under the agent
 * memory root. Enforces:
 *   - a two-glob WRITE whitelist (normal `**​/knowledge/*.md`, site
 *     `**​/knowledge/sites/*.md`); any other path (incl. other knowledge
 *     subdirs, traversal, out-of-root) is refused;
 *   - a five-state lifecycle (staged → active → rejected; staged→expired
 *     cleanup; invalid for unparseable cards);
 *   - read APIs that DEFAULT TO EXCLUDING staged so unconfirmed cards never
 *     leak into injection (the phase-1 provable "staged 不外泄" boundary);
 *   - atomic writes (tmp + rename) and an audit line per transition.
 *
 * The store is electron-free (root injected) so it unit-tests without the app.
 */

export type BeliefCardStatus = 'staged' | 'active' | 'rejected' | 'invalid'

export const BELIEF_CONFIDENCE = ['H', 'M', 'L'] as const
export const BELIEF_TAGS = ['knowledge', 'self', 'preference', 'aspire'] as const

/** EP3-C5 — emergence candidate lifecycle (03 §5), orthogonal to the
 *  staged/active write lifecycle. Optional; only aspire candidates use it. */
export const CANDIDATE_STAGES = ['hint', 'candidate', 'emerged', 'routed', 'retired'] as const
export type CandidateStage = (typeof CANDIDATE_STAGES)[number]

export interface BeliefCardFrontmatter {
  title: string
  description: string
  confidence: (typeof BELIEF_CONFIDENCE)[number]
  tag: (typeof BELIEF_TAGS)[number]
  created: string
  status: BeliefCardStatus
  source?: string
  /** Present only on site cards (`knowledge/sites/*.md`). */
  site?: string
  /** EP3-C5 candidate stage — present only on emergence candidate cards. */
  stage?: CandidateStage
  /** EP4-A5 — routing-card trigger keywords: literal, comma-separated in
   *  the file, ≤8 entries of 1-32 chars. No regex, no globs, no vectors. */
  triggers?: string[]
}

export const TRIGGERS_MAX_ENTRIES = 8
export const TRIGGERS_MAX_ENTRY_CHARS = 32

/** Parse + validate the triggers value — comma-separated string from a
 *  card FILE, or a string[] from a writeCard caller. null = absent;
 *  ok:false = bad card. */
export function parseTriggersValue(raw: string | string[] | undefined):
  | { ok: true; triggers: string[] | null }
  | { ok: false; reason: string } {
  if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, triggers: null }
  }
  const parts = Array.isArray(raw) ? raw.map(String) : raw.split(',')
  const entries = parts.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  if (entries.length === 0) return { ok: false, reason: 'triggers present but empty' }
  if (entries.length > TRIGGERS_MAX_ENTRIES) {
    return { ok: false, reason: `triggers exceed ${TRIGGERS_MAX_ENTRIES} entries` }
  }
  for (const entry of entries) {
    if (entry.length > TRIGGERS_MAX_ENTRY_CHARS) {
      return { ok: false, reason: `trigger keyword too long: ${entry.slice(0, 40)}` }
    }
  }
  return { ok: true, triggers: entries }
}

export interface BeliefCard {
  /** Path relative to the memory root, e.g. `knowledge/foo.md`. */
  relPath: string
  frontmatter: BeliefCardFrontmatter
  body: string
}

export type WriteResult =
  | { ok: true; relPath: string }
  | { ok: false; reason: string }

export type ReadOptions = { includeStaged?: boolean }

// The write whitelist is a CLOSED union of exactly the shapes an injection
// read actually walks — anchored at the root, no arbitrary prefixes. A
// wider guard (e.g. accepting `evil/knowledge/foo.md` or
// `agents/a/b/knowledge/foo.md`) would let writes succeed into paths no
// reader ever visits: "看似记住了，其实永远没生效".
const NORMAL_CARD = /^knowledge\/[a-z0-9._-]+\.md$/
const SITE_CARD = /^knowledge\/sites\/[a-z0-9._-]+\.md$/
// per-agent shapes (EP3-A2 owner channel walks agents/<id>/knowledge
// recursively, so agent-scoped site cards ARE readable — phase-1 contract)
const AGENT_CARD = /^agents\/([^/]+)\/knowledge\/[a-z0-9._-]+\.md$/
const AGENT_SITE_CARD = /^agents\/([^/]+)\/knowledge\/sites\/[a-z0-9._-]+\.md$/

// EP3-A2 — per-agent knowledge scope. Agent ids are path segments, so the
// shape is closed (no dots-only segments, no separators) before any join.
const AGENT_SCOPE_ID = /^(?!\.+$)[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSafeAgentScopeId(agentId: string | null | undefined): agentId is string {
  return typeof agentId === 'string' && AGENT_SCOPE_ID.test(agentId)
}

/** `agents/<id>/knowledge` for a safe agent id; null otherwise (treated as
 *  "no agent scope" — never an error, never a path fragment). */
export function agentScopeKnowledgeDir(agentId: string | null | undefined): string | null {
  return isSafeAgentScopeId(agentId) ? `agents/${agentId}/knowledge` : null
}

/** Site-card detection across both the global and the per-agent scope. */
function isSiteCardPath(norm: string): boolean {
  return SITE_CARD.test(norm) || AGENT_SITE_CARD.test(norm)
}

/** True iff relPath is an allowed card write target — exactly
 *  `knowledge/<slug>.md`, `knowledge/sites/<domain>.md`, or their
 *  per-agent variants `agents/<agentId>/knowledge/[sites/]<slug>.md`
 *  (agentId shape-validated). */
export function isAllowedCardPath(relPath: string): boolean {
  if (!relPath || relPath.includes('\0')) return false
  const norm = relPath.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false // absolute
  if (norm.split('/').some((seg) => seg === '..')) return false // traversal
  if (SITE_CARD.test(norm) || NORMAL_CARD.test(norm)) return true
  const agentMatch = norm.match(AGENT_SITE_CARD) ?? norm.match(AGENT_CARD)
  return agentMatch !== null && isSafeAgentScopeId(agentMatch[1])
}

interface AuditEvent {
  action: 'write' | 'transition' | 'expire' | 'reject_path' | 'reject_frontmatter'
  relPath: string
  from?: BeliefCardStatus
  to?: BeliefCardStatus
  reason?: string
}

export interface BeliefCardStoreOptions {
  memoryRoot: string
  now?: () => Date
  audit?: (event: AuditEvent) => void
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } | null {
  const normalized = text.replace(/^﻿/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return null
  const meta: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!entry) continue
    meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: normalized.slice(match[0].length) }
}

function validateFrontmatter(
  meta: Record<string, string>,
  isSite: boolean,
): { ok: true; fm: BeliefCardFrontmatter } | { ok: false; reason: string } {
  for (const field of ['title', 'description', 'confidence', 'tag', 'created', 'status']) {
    if (!meta[field]) return { ok: false, reason: `missing frontmatter: ${field}` }
  }
  if (!(BELIEF_CONFIDENCE as readonly string[]).includes(meta.confidence)) {
    return { ok: false, reason: `bad confidence: ${meta.confidence}` }
  }
  if (!(BELIEF_TAGS as readonly string[]).includes(meta.tag)) {
    return { ok: false, reason: `bad tag: ${meta.tag}` }
  }
  if (!(['staged', 'active', 'rejected', 'invalid'] as string[]).includes(meta.status)) {
    return { ok: false, reason: `bad status: ${meta.status}` }
  }
  if (isSite && !meta.site) return { ok: false, reason: 'site card missing site field' }
  if (meta.stage && !(CANDIDATE_STAGES as readonly string[]).includes(meta.stage)) {
    return { ok: false, reason: `bad stage: ${meta.stage}` }
  }
  const triggersCheck = parseTriggersValue(meta.triggers)
  if (!triggersCheck.ok) return { ok: false, reason: triggersCheck.reason }
  return {
    ok: true,
    fm: {
      title: meta.title,
      description: meta.description,
      confidence: meta.confidence as BeliefCardFrontmatter['confidence'],
      tag: meta.tag as BeliefCardFrontmatter['tag'],
      created: meta.created,
      status: meta.status as BeliefCardStatus,
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.site ? { site: meta.site } : {}),
      ...(meta.stage ? { stage: meta.stage as CandidateStage } : {}),
      ...(triggersCheck.triggers ? { triggers: triggersCheck.triggers } : {}),
    },
  }
}

function serializeCard(fm: BeliefCardFrontmatter, body: string): string {
  const lines = ['---', `title: ${fm.title}`, `description: ${fm.description}`,
    `confidence: ${fm.confidence}`, `tag: ${fm.tag}`, `created: ${fm.created}`,
    `status: ${fm.status}`]
  if (fm.source) lines.push(`source: ${fm.source}`)
  if (fm.site) lines.push(`site: ${fm.site}`)
  if (fm.stage) lines.push(`stage: ${fm.stage}`)
  if (fm.triggers && fm.triggers.length > 0) lines.push(`triggers: ${fm.triggers.join(', ')}`)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

export class BeliefCardStore {
  private readonly root: string
  private readonly now: () => Date
  private readonly auditFn: (event: AuditEvent) => void

  constructor(options: BeliefCardStoreOptions) {
    this.root = resolve(options.memoryRoot)
    this.now = options.now ?? (() => new Date())
    this.auditFn = options.audit ?? ((event) => logAgentMetric('belief_card_audit', { ...event }))
  }

  /** Resolve a relPath to an absolute path that is provably inside the root. */
  private absInRoot(relPath: string): string | null {
    const abs = resolve(this.root, relPath)
    if (abs !== this.root && !abs.startsWith(this.root + sep)) return null
    return abs
  }

  /** Write (or overwrite) a card. Validates path whitelist + frontmatter. */
  writeCard(input: { relPath: string; frontmatter: BeliefCardFrontmatter; body: string }): WriteResult {
    const relPath = input.relPath.replace(/\\/g, '/')
    if (!isAllowedCardPath(relPath)) {
      this.auditFn({ action: 'reject_path', relPath, reason: 'not in write whitelist' })
      return { ok: false, reason: 'path not allowed (must be knowledge/*.md, knowledge/sites/*.md, or agents/<agentId>/knowledge/[sites/]*.md)' }
    }
    const isSite = isSiteCardPath(relPath)
    const fmCheck = validateFrontmatter(input.frontmatter as unknown as Record<string, string>, isSite)
    if (!fmCheck.ok) {
      this.auditFn({ action: 'reject_frontmatter', relPath, reason: fmCheck.reason })
      return { ok: false, reason: fmCheck.reason }
    }
    const abs = this.absInRoot(relPath)
    if (!abs) {
      this.auditFn({ action: 'reject_path', relPath, reason: 'resolves outside root' })
      return { ok: false, reason: 'path resolves outside memory root' }
    }
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${randomUUID()}`
    writeFileSync(tmp, serializeCard(fmCheck.fm, input.body), 'utf-8')
    renameSync(tmp, abs)
    this.auditFn({ action: 'write', relPath, to: fmCheck.fm.status })
    return { ok: true, relPath }
  }

  /** Read one card. Returns null when missing, unparseable, or staged-excluded. */
  readCard(relPath: string, opts: ReadOptions = {}): BeliefCard | null {
    const norm = relPath.replace(/\\/g, '/')
    const abs = this.absInRoot(norm)
    if (!abs || !existsSync(abs)) return null
    const parsed = parseFrontmatter(readFileSync(abs, 'utf-8'))
    if (!parsed) return null
    const isSite = isSiteCardPath(norm)
    const fmCheck = validateFrontmatter(parsed.meta, isSite)
    if (!fmCheck.ok) return null
    if (fmCheck.fm.status === 'staged' && !opts.includeStaged) return null
    return { relPath: norm, frontmatter: fmCheck.fm, body: parsed.body.trim() }
  }

  /** List cards under a knowledge dir. Default excludes staged. */
  listCards(opts: ReadOptions & { dir?: string } = {}): BeliefCard[] {
    const dir = opts.dir ?? 'knowledge'
    const absDir = this.absInRoot(dir)
    if (!absDir || !existsSync(absDir)) return []
    const out: BeliefCard[] = []
    const walk = (currentRel: string): void => {
      const absCur = this.absInRoot(currentRel)
      if (!absCur || !existsSync(absCur)) return
      for (const name of readdirSync(absCur)) {
        const childRel = `${currentRel}/${name}`
        const absChild = join(absCur, name)
        let isDir = false
        try { isDir = statSync(absChild).isDirectory() } catch { /* */ }
        if (isDir) {
          walk(childRel)
        } else if (name.endsWith('.md')) {
          const card = this.readCard(childRel, opts)
          if (card) out.push(card)
        }
      }
    }
    walk(dir)
    return out
  }

  /** Resolve the absolute memory root (for callers that hash file contents). */
  get rootPath(): string {
    return this.root
  }

  /**
   * EP2-K3 — render the L1.5 knowledge index. ONLY `status: active` cards
   * are eligible: staged (quarantine), rejected, and invalid (unparseable)
   * cards never reach any injection surface — this method is the single
   * rendering source, which makes the phase-1 staged-injection ban provable
   * at the injection面 instead of just at the read API.
   *
   * Budget: lines render in confidence order (H → M → L); once `maxChars`
   * would be exceeded the remainder is dropped and reported via
   * `omittedCount` so the caller can append the "另有 N 条" footer.
   */
  renderKnowledgeIndex(opts: { maxChars: number; ownerAgentId?: string | null }): { text: string; renderedCount: number; omittedCount: number } {
    const rank: Record<BeliefCardFrontmatter['confidence'], number> = { H: 0, M: 1, L: 2 }
    const byConfidence = (a: BeliefCard, b: BeliefCard): number =>
      rank[a.frontmatter.confidence] - rank[b.frontmatter.confidence]
      || a.relPath.localeCompare(b.relPath)
    const isActive = (card: BeliefCard): boolean => card.frontmatter.status === 'active'
    // EP3-A2 — owner agent's scope dir renders FIRST (作用域优先), then the
    // global dir; ONLY the owner's dir is read — sibling agents' lineages
    // never reach this surface (零泄漏 is structural, not filtered).
    const ownerDir = agentScopeKnowledgeDir(opts.ownerAgentId)
    const ownerActive = ownerDir ? this.listCards({ dir: ownerDir }).filter(isActive).sort(byConfidence) : []
    const active = [...ownerActive, ...this.listCards().filter(isActive).sort(byConfidence)]
    const lines: string[] = []
    let used = 0
    let rendered = 0
    for (const card of active) {
      const line = `- ${card.frontmatter.title}（${card.frontmatter.confidence}）: ${card.frontmatter.description} → ${card.relPath}`
      if (used + line.length + 1 > opts.maxChars) break
      lines.push(line)
      used += line.length + 1
      rendered += 1
    }
    return {
      text: lines.join('\n'),
      renderedCount: rendered,
      omittedCount: active.length - rendered,
    }
  }

  /**
   * EP3-A3 — ACTIVE routing-fix cards (`knowledge/routing-*.md`) for the
   * main-session routing index. Staged routing cards never inject (the
   * phase-1 staged ban holds at this surface too).
   */
  listRoutingCards(): Array<{ relPath: string; title: string; description: string; targetAgentId: string; triggers: string[] | null }> {
    return this.listCards()
      .filter((card) =>
        card.frontmatter.status === 'active'
        && /(^|\/)knowledge\/routing-[a-z0-9._-]+\.md$/.test(card.relPath))
      .map((card) => ({
        relPath: card.relPath,
        title: card.frontmatter.title,
        description: card.frontmatter.description,
        // EP4-A5 — the routing target is BOUND to the filename.
        targetAgentId: card.relPath.replace(/^.*routing-/, '').replace(/\.md$/, ''),
        triggers: card.frontmatter.triggers ?? null,
      }))
  }

  /**
   * Enumerate every `.md` under knowledge dirs, including unparseable ones
   * (card === null). Used by the DB mirror sync to record invalid cards as
   * `status: invalid` rows without dropping the row.
   */
  listAllCardFiles(dir = 'knowledge'): Array<{ relPath: string; card: BeliefCard | null }> {
    const out: Array<{ relPath: string; card: BeliefCard | null }> = []
    const absDir = this.absInRoot(dir)
    if (!absDir || !existsSync(absDir)) return out
    const walk = (currentRel: string): void => {
      const absCur = this.absInRoot(currentRel)
      if (!absCur || !existsSync(absCur)) return
      for (const name of readdirSync(absCur)) {
        const childRel = `${currentRel}/${name}`
        const absChild = join(absCur, name)
        let isDir = false
        try { isDir = statSync(absChild).isDirectory() } catch { /* */ }
        if (isDir) {
          walk(childRel)
        } else if (name.endsWith('.md')) {
          out.push({ relPath: childRel, card: this.readCard(childRel, { includeStaged: true }) })
        }
      }
    }
    walk(dir)
    return out
  }

  /**
   * EP4-K-mirror — enumerate card files across ALL scopes: the global
   * `knowledge/` dir (scopeId 'global') plus every `agents/<id>/knowledge/`
   * dir (scopeId 'agent:<id>'). Agent dir names are shape-filtered via
   * isSafeAgentScopeId; anything else is skipped, never a path fragment.
   * No agents/ dir → identical to listAllCardFiles (存量零感知).
   */
  listAllCardFilesAllScopes(): Array<{ relPath: string; card: BeliefCard | null; scopeId: string }> {
    const out = this.listAllCardFiles().map((file) => ({ ...file, scopeId: 'global' }))
    const agentsAbs = this.absInRoot('agents')
    if (!agentsAbs || !existsSync(agentsAbs)) return out
    for (const name of readdirSync(agentsAbs)) {
      if (!isSafeAgentScopeId(name)) continue
      let isDir = false
      try { isDir = statSync(join(agentsAbs, name)).isDirectory() } catch { /* race-deleted */ }
      if (!isDir) continue
      const dir = `agents/${name}/knowledge`
      const absDir = this.absInRoot(dir)
      if (!absDir || !existsSync(absDir)) continue
      out.push(...this.listAllCardFiles(dir).map((file) => ({ ...file, scopeId: `agent:${name}` })))
    }
    return out
  }

  /** Transition a card to a new status. Returns false if card unreadable. */
  transition(relPath: string, to: BeliefCardStatus): boolean {
    const current = this.readCard(relPath, { includeStaged: true })
    if (!current) return false
    const from = current.frontmatter.status
    const next: BeliefCardFrontmatter = { ...current.frontmatter, status: to }
    const result = this.writeCard({ relPath, frontmatter: next, body: current.body })
    if (!result.ok) return false
    this.auditFn({ action: 'transition', relPath, from, to })
    return true
  }

  /**
   * Delete staged cards older than `maxAgeDays` (default 14). Staged cards
   * never entered formal memory, so they are deleted outright (not demoted).
   * Returns the relPaths removed.
   */
  cleanupExpiredStaged(maxAgeDays = 14): string[] {
    const cutoff = this.now().getTime() - maxAgeDays * 86400_000
    const removed: string[] = []
    for (const card of this.listCards({ includeStaged: true })) {
      if (card.frontmatter.status !== 'staged') continue
      const created = Date.parse(card.frontmatter.created)
      if (Number.isNaN(created) || created >= cutoff) continue
      const abs = this.absInRoot(card.relPath)
      if (!abs || !existsSync(abs)) continue
      unlinkSync(abs)
      this.auditFn({ action: 'expire', relPath: card.relPath, from: 'staged' })
      removed.push(card.relPath)
    }
    return removed
  }
}
