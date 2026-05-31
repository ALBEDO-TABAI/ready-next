// GitHub / tarball analog of model-pack-registry.ts: pure resolution helpers with
// an injectable fetch + latency probe so they stay unit-testable without real
// network. Responsibilities:
//   - resolveGithubRefToSha: pin a ref (branch/tag/absent) to an immutable commit
//     SHA for provenance.
//   - fetchGithubRepoMetadata: best-effort license + default-branch lookup.
//   - resolveSkillTarballUrl: build the concrete archive URL, switching between
//     the overseas codeload origin and a domestic mirror with the same
//     latency-probe auto-switch shape as probeFastestModelProvider.
//   - extractCandidateSourcesFromDoc / extractCandidateSkillNames: regex-extract
//     candidate sources + names from a fetched install doc — treated as DATA only,
//     never executed.

import type { ModelSource } from '../../../shared/model-pack-types'
import { parseSkillSourceInput, type SkillSource } from '../../../shared/skill-source-types'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export type LatencyProbe = (url: string) => Promise<number | null>

// GitHub archive endpoints. codeload is the canonical tarball origin; the github
// archive URL (which 302s to codeload) is what a ghproxy-style domestic mirror
// wraps.
export const OVERSEAS_GITHUB_CODELOAD = 'https://codeload.github.com'
// Default ghproxy-style prefix; the manager can override it from configuration.
export const DEFAULT_DOMESTIC_GITHUB_MIRROR_PREFIX = 'https://ghproxy.net/'

const GITHUB_API = 'https://api.github.com'
const GITHUB_REQUEST_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Ready-Skill-Installer',
  'X-GitHub-Api-Version': '2022-11-28',
}

export function buildGithubCodeloadUrl(owner: string, repo: string, ref: string): string {
  return `${OVERSEAS_GITHUB_CODELOAD}/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`
}

export function buildDomesticGithubTarballUrl(
  owner: string,
  repo: string,
  ref: string,
  mirrorPrefix: string,
): string {
  const archive = `https://github.com/${owner}/${repo}/archive/${encodeURIComponent(ref)}.tar.gz`
  return `${mirrorPrefix}${archive}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // silent-catch: a non-URL string has no parseable host; the raw input is the
    // best comparable token for the look-alike / host risk checks.
    return url
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    // silent-catch: a non-URL string has no parseable origin; the raw input is the
    // best comparable token for the endpoint-display / probe fallbacks.
    return url
  }
}

// Resolve a ref (branch/tag/SHA, or absent for the default branch) to an
// immutable commit SHA. Absent ref uses the latest commit on the default branch
// (per_page=1) rather than relying on a literal "HEAD" ref.
export async function resolveGithubRefToSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  fetchImpl: FetchLike,
): Promise<{ sha: string; usedRef: string }> {
  const trimmed = ref && ref.trim() ? ref.trim() : ''
  const url = trimmed
    ? `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(trimmed)}`
    : `${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=1`
  const res = await fetchImpl(url, { headers: GITHUB_REQUEST_HEADERS })
  if (!res.ok) {
    throw new Error(`无法解析 GitHub 提交（${owner}/${repo}${trimmed ? `@${trimmed}` : ''}）：HTTP ${res.status}`)
  }
  const data = (await res.json()) as unknown
  const sha = trimmed
    ? (data as { sha?: unknown }).sha
    : Array.isArray(data) && data.length > 0
      ? (data[0] as { sha?: unknown }).sha
      : undefined
  if (typeof sha !== 'string' || !sha) {
    throw new Error(`GitHub 未返回提交 SHA（${owner}/${repo}${trimmed ? `@${trimmed}` : ''}）`)
  }
  return { sha, usedRef: trimmed || 'default' }
}

export interface GithubRepoMetadata {
  defaultBranch: string | null
  licenseSpdx: string | null
}

// Best-effort repo metadata for the confirm card (license + default branch). Any
// failure resolves to nulls so resolution never hard-fails on metadata alone.
export async function fetchGithubRepoMetadata(
  owner: string,
  repo: string,
  fetchImpl: FetchLike,
): Promise<GithubRepoMetadata> {
  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: GITHUB_REQUEST_HEADERS })
    if (!res.ok) return { defaultBranch: null, licenseSpdx: null }
    const data = (await res.json()) as { default_branch?: unknown; license?: { spdx_id?: unknown } | null }
    const defaultBranch = typeof data.default_branch === 'string' ? data.default_branch : null
    const spdx = data.license && typeof data.license.spdx_id === 'string' ? data.license.spdx_id : null
    return { defaultBranch, licenseSpdx: spdx }
  } catch {
    // silent-catch: repo metadata is a best-effort confirm-card hint; any network
    // failure resolves to nulls so resolution never hard-fails on metadata alone.
    return { defaultBranch: null, licenseSpdx: null }
  }
}

export interface ResolvedTarball {
  url: string
  // The endpoint host URL used for latency probing / display.
  endpoint: string
  mirror: 'domestic' | 'overseas' | 'direct'
}

// Build the concrete tarball URL for a source, applying the 国内/国外 switch for
// GitHub sources. For github sources `source.ref` MUST already be the pinned
// commit SHA (caller pins via resolveGithubRefToSha first). Direct tarballs pass
// through unchanged (an arbitrary host cannot be mirrored). 'auto' probes both
// GitHub endpoints and picks the fastest reachable, falling back to overseas.
export async function resolveSkillTarballUrl(
  source: SkillSource,
  downloadSource: ModelSource,
  probeLatency: LatencyProbe,
  options: { mirrorPrefix?: string } = {},
): Promise<ResolvedTarball> {
  if (source.kind === 'tarball') {
    return { url: source.url, endpoint: originOf(source.url), mirror: 'direct' }
  }
  if (source.kind === 'registry') {
    throw new Error('registry 来源暂不支持（Phase 2）')
  }

  const ref = source.ref
  if (!ref) {
    throw new Error('GitHub 来源需要先锁定到具体提交（commit SHA）')
  }
  const mirrorPrefix = options.mirrorPrefix ?? DEFAULT_DOMESTIC_GITHUB_MIRROR_PREFIX
  const overseasUrl = buildGithubCodeloadUrl(source.owner, source.repo, ref)
  const domesticUrl = buildDomesticGithubTarballUrl(source.owner, source.repo, ref, mirrorPrefix)
  const overseas: ResolvedTarball = { url: overseasUrl, endpoint: OVERSEAS_GITHUB_CODELOAD, mirror: 'overseas' }
  const domestic: ResolvedTarball = { url: domesticUrl, endpoint: `https://${hostOf(mirrorPrefix)}`, mirror: 'domestic' }

  if (downloadSource === 'overseas') return overseas
  if (downloadSource === 'domestic') return domestic

  // auto: probe both endpoints, pick the fastest reachable; fall back to overseas.
  const [overseasLatency, domesticLatency] = await Promise.all([
    probeLatency(overseas.endpoint),
    probeLatency(domestic.endpoint),
  ])
  const measured = [
    { target: overseas, latency: overseasLatency },
    { target: domestic, latency: domesticLatency },
  ].filter((m): m is { target: ResolvedTarball; latency: number } => m.latency !== null)
  measured.sort((a, b) => a.latency - b.latency)
  return measured[0]?.target ?? overseas
}

// Extract candidate downloadable sources from a fetched install doc / store page.
// DATA only: the doc's prose is never fed back as instructions — we regex out
// explicit URLs and github.com/owner/repo mentions, parse each, and dedupe.
export function extractCandidateSourcesFromDoc(docText: string): SkillSource[] {
  if (!docText) return []
  const found: SkillSource[] = []
  const seen = new Set<string>()
  const pushUnique = (source: SkillSource): void => {
    const key = JSON.stringify(source)
    if (!seen.has(key)) {
      seen.add(key)
      found.push(source)
    }
  }

  const urlRegex = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi
  for (const raw of docText.match(urlRegex) ?? []) {
    const cleaned = raw.replace(/[.,;]+$/, '')
    const parsed = parseSkillSourceInput(cleaned)
    if (parsed.ok) pushUnique(parsed.source)
  }

  const ghRegex = /\bgithub\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+/gi
  for (const raw of docText.match(ghRegex) ?? []) {
    const parsed = parseSkillSourceInput(raw.replace(/[.,;]+$/, ''))
    if (parsed.ok) pushUnique(parsed.source)
  }

  return found
}

// Extract kebab-case tokens that look like skill ids (e.g. video-expert-analyzer
// or video-expert-analyzer-260324) from freeform text, for typosquat detection.
// Heuristic + deduped + capped; never authoritative on its own.
export function extractCandidateSkillNames(text: string): string[] {
  if (!text) return []
  const matches = text.toLowerCase().match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) ?? []
  const unique: string[] = []
  const seen = new Set<string>()
  for (const token of matches) {
    if (seen.has(token)) continue
    seen.add(token)
    unique.push(token)
    if (unique.length >= 20) break
  }
  return unique
}
