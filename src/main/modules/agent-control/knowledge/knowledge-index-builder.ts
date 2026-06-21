/**
 * EP2-C1 — knowledge graph maintenance, deterministic v1 (03 §3/§6).
 *
 * Pure functions only: input is the card listing (what
 * `BeliefCardStore.listAllCardFiles()` returns), output is a PLAN — bodies
 * with rebuilt backlinks blocks, the regenerated index.md, and detection
 * lists (invalid / orphan links / possible duplicates / expired staged).
 * Applying the plan (file writes, deletions, frontmatter patches) belongs to
 * the scheduler (EP2-C2); nothing here touches the filesystem or DB, which is
 * what makes rebuild idempotence and the injected clock testable.
 */

import type { BeliefCard, BeliefCardFrontmatter } from './belief-card-store'
import { isPossibleDuplicateOfSource } from './reserved-card-source'

export interface KnowledgeGraphPlan {
  /** Bodies whose backlinks block changed — apply via the card store's atomic write. */
  cardBodies: Array<{ relPath: string; body: string }>
  /** Regenerated index.md content (tag groups, confidence descending, Updated stamp). */
  indexMarkdown: string
  /** Unparseable card files (mirror rows go invalid — never deleted). */
  invalidCards: string[]
  /** [[slug]] references that resolve to no card. */
  orphanLinks: Array<{ from: string; slug: string }>
  /** Newer cards whose normalized title collides with an older card. Marked, never deleted. */
  possibleDuplicates: Array<{ relPath: string; duplicateOf: string }>
  /** Staged cards past expiry with no promotion signal — deletion candidates (03 §2). */
  expiredStaged: string[]
}

const BACKLINKS_OPEN = '<!-- backlinks:auto -->'
const BACKLINKS_CLOSE = '<!-- /backlinks:auto -->'
const STAGED_EXPIRY_DAYS = 14
const TAG_ORDER: ReadonlyArray<BeliefCardFrontmatter['tag']> = ['knowledge', 'self', 'preference', 'aspire']
const CONFIDENCE_RANK: Record<BeliefCardFrontmatter['confidence'], number> = { H: 0, M: 1, L: 2 }

/** Remove the auto-generated backlinks block (idempotent on bodies without one). */
export function stripBacklinksBlock(body: string): string {
  const open = body.indexOf(BACKLINKS_OPEN)
  if (open < 0) return body
  const close = body.indexOf(BACKLINKS_CLOSE, open)
  const end = close < 0 ? body.length : close + BACKLINKS_CLOSE.length
  return `${body.slice(0, open)}${body.slice(end)}`.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * Forward [[slug]] edges from a card body. The auto block is stripped FIRST so
 * stale generated backlinks never count as authored edges (strip 防重复计数).
 */
export function extractForwardLinks(body: string): string[] {
  const stripped = stripBacklinksBlock(body)
  const out: string[] = []
  for (const match of stripped.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
    const slug = match[1].trim()
    if (slug && !out.includes(slug)) out.push(slug)
  }
  return out
}

function slugOf(relPath: string): string {
  return relPath.replace(/^.*\//, '').replace(/\.md$/, '')
}

function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

function renderBacklinksBlock(slugs: string[]): string {
  return `${BACKLINKS_OPEN}\nBacklinks: ${slugs.map((slug) => `[[${slug}]]`).join(', ')}\n${BACKLINKS_CLOSE}`
}

function dayDiff(now: Date, created: string): number {
  const createdMs = Date.parse(`${created}T00:00:00.000Z`)
  if (!Number.isFinite(createdMs)) return 0
  return (now.getTime() - createdMs) / 86_400_000
}

function renderIndexMarkdown(cards: BeliefCard[], now: Date): string {
  const active = cards.filter((card) => card.frontmatter.status === 'active')
  const lines: string[] = ['# 知识索引', `Updated: ${now.toISOString().slice(0, 10)}`]
  for (const tag of TAG_ORDER) {
    const group = active
      .filter((card) => card.frontmatter.tag === tag)
      .sort((a, b) =>
        CONFIDENCE_RANK[a.frontmatter.confidence] - CONFIDENCE_RANK[b.frontmatter.confidence]
        || a.relPath.localeCompare(b.relPath))
    if (group.length === 0) continue
    lines.push('', `## ${tag}`)
    for (const card of group) {
      lines.push(`- ${card.frontmatter.title}（${card.frontmatter.confidence}）: ${card.frontmatter.description} → ${card.relPath}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Build the full maintenance plan. `now` is injected — expiry decisions are
 * reproducible and testable against a fixed clock.
 *
 * EP4-K-mirror — scope-aware: input files may carry a `scopeId` ('global' |
 * 'agent:<id>'; absent = 'global', so legacy callers keep exact behavior).
 * Backlinks, orphan detection, and duplicate marking resolve PER SCOPE
 * BUCKET — the same slug owned by two agents never cross-links. The root
 * index.md renders from the GLOBAL bucket ONLY (agent cards never leak into
 * it; per-agent index files have no reader and are deliberately not
 * produced). Body rewrites and staged expiry apply across all buckets with
 * identical rules.
 */
export function buildKnowledgeGraphPlan(
  files: ReadonlyArray<{ relPath: string; card: BeliefCard | null; scopeId?: string }>,
  opts: { now: Date; stagedExpiryDays?: number },
): KnowledgeGraphPlan {
  const expiryDays = opts.stagedExpiryDays ?? STAGED_EXPIRY_DAYS
  const invalidCards = files.filter((file) => !file.card).map((file) => file.relPath)

  const buckets = new Map<string, BeliefCard[]>()
  for (const file of files) {
    if (!file.card) continue
    const scopeId = file.scopeId ?? 'global'
    const list = buckets.get(scopeId) ?? []
    list.push(file.card)
    buckets.set(scopeId, list)
  }

  const orphanLinks: KnowledgeGraphPlan['orphanLinks'] = []
  const cardBodies: KnowledgeGraphPlan['cardBodies'] = []
  const expiredStaged: string[] = []
  const possibleDuplicates: KnowledgeGraphPlan['possibleDuplicates'] = []

  for (const cards of buckets.values()) {
    const bySlug = new Map(cards.map((card) => [slugOf(card.relPath), card]))

    // forward edges + orphan detection — edges only form INSIDE the bucket
    const backlinks = new Map<string, string[]>()
    for (const card of cards) {
      const fromSlug = slugOf(card.relPath)
      for (const slug of extractForwardLinks(card.body)) {
        if (!bySlug.has(slug)) {
          orphanLinks.push({ from: card.relPath, slug })
          continue
        }
        const list = backlinks.get(slug) ?? []
        if (!list.includes(fromSlug)) list.push(fromSlug)
        backlinks.set(slug, list)
      }
    }

    // rewrite bodies whose backlinks block content changed
    for (const card of cards) {
      const incoming = (backlinks.get(slugOf(card.relPath)) ?? []).sort()
      const stripped = stripBacklinksBlock(card.body)
      const next = incoming.length > 0
        ? `${stripped}\n\n${renderBacklinksBlock(incoming)}`
        : stripped
      if (next !== card.body) cardBodies.push({ relPath: card.relPath, body: next })
    }

    // staged expiry against the injected clock
    expiredStaged.push(...cards
      .filter((card) => card.frontmatter.status === 'staged' && dayDiff(opts.now, card.frontmatter.created) >= expiryDays)
      .map((card) => card.relPath))

    // near-duplicate marking: newer normalized-title collision points at the
    // oldest card; already-marked cards stay untouched (idempotence, 不直删).
    // Per-bucket: the same title in two agents' scopes is NOT a duplicate.
    const byTitle = new Map<string, BeliefCard[]>()
    for (const card of cards) {
      const key = normalizeTitle(card.frontmatter.title)
      if (!key) continue
      const list = byTitle.get(key) ?? []
      list.push(card)
      byTitle.set(key, list)
    }
    for (const group of byTitle.values()) {
      if (group.length < 2) continue
      const ordered = [...group].sort((a, b) =>
        a.frontmatter.created.localeCompare(b.frontmatter.created)
        || a.relPath.localeCompare(b.relPath))
      const oldest = ordered[0]
      for (const newer of ordered.slice(1)) {
        if (isPossibleDuplicateOfSource(newer.frontmatter.source)) continue
        possibleDuplicates.push({ relPath: newer.relPath, duplicateOf: slugOf(oldest.relPath) })
      }
    }
  }

  return {
    cardBodies,
    // root index.md is GLOBAL-ONLY — agent cards never leak into it.
    indexMarkdown: renderIndexMarkdown(buckets.get('global') ?? [], opts.now),
    invalidCards,
    orphanLinks,
    possibleDuplicates,
    expiredStaged,
  }
}
