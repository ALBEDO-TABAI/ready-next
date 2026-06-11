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

const NORMAL_CARD = /(^|\/)knowledge\/[a-z0-9._-]+\.md$/
const SITE_CARD = /(^|\/)knowledge\/sites\/[a-z0-9._-]+\.md$/

/** True iff relPath is an allowed card write target (normal or site). */
export function isAllowedCardPath(relPath: string): boolean {
  if (!relPath || relPath.includes('\0')) return false
  const norm = relPath.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false // absolute
  if (norm.split('/').some((seg) => seg === '..')) return false // traversal
  return SITE_CARD.test(norm) || NORMAL_CARD.test(norm)
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
    },
  }
}

function serializeCard(fm: BeliefCardFrontmatter, body: string): string {
  const lines = ['---', `title: ${fm.title}`, `description: ${fm.description}`,
    `confidence: ${fm.confidence}`, `tag: ${fm.tag}`, `created: ${fm.created}`,
    `status: ${fm.status}`]
  if (fm.source) lines.push(`source: ${fm.source}`)
  if (fm.site) lines.push(`site: ${fm.site}`)
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
      return { ok: false, reason: 'path not allowed (must be knowledge/*.md or knowledge/sites/*.md)' }
    }
    const isSite = SITE_CARD.test(relPath)
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
    const isSite = SITE_CARD.test(norm)
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
  renderKnowledgeIndex(opts: { maxChars: number }): { text: string; renderedCount: number; omittedCount: number } {
    const rank: Record<BeliefCardFrontmatter['confidence'], number> = { H: 0, M: 1, L: 2 }
    const active = this.listCards()
      .filter((card) => card.frontmatter.status === 'active')
      .sort((a, b) =>
        rank[a.frontmatter.confidence] - rank[b.frontmatter.confidence]
        || a.relPath.localeCompare(b.relPath))
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
