// Skill-source contracts: the remote skill-install surface.
//
// Generalizes the local-folder skill import into installing from a remote source
// (a GitHub repo or a direct tarball URL). The design is one read-only resolver
// (parse + risk classify + ref→commit pin) feeding a single confirm choke-point,
// and one installer that REQUIRES a confirmed descriptor (`trustAck`) so neither
// front door (the SkillsCenterPanel URL input or the agent `install_skill` tool)
// can install without confirmation. Sources can be fetched from a domestic mirror
// or the overseas origin, mirroring the model-pack `ModelSource` auto-switch.
//
// Everything in this module is pure / serializable so main and renderer agree on
// the same shapes; the two exported functions (`parseSkillSourceInput`,
// `assessSkillSourceRisk`) do no I/O and are unit-tested directly.

import type { ModelSource } from './model-pack-types'

// Reuse the model-pack source selector verbatim: 'auto' probes the fastest
// reachable endpoint at fetch start; explicit values pin domestic / overseas.
export type { ModelSource } from './model-pack-types'

// A parsed, resolvable skill source. `registry` is recognized but deferred to
// Phase 2 (so freeform input does not silently misclassify); the installer
// rejects it for now.
export type SkillSource =
  | { kind: 'github'; owner: string; repo: string; ref?: string; subdir?: string }
  | { kind: 'tarball'; url: string; sha256?: string }
  | { kind: 'registry'; id: string }

export type SkillSourceParseResult =
  | { ok: true; source: SkillSource }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

// Concrete, enumerable risk reasons. Each maps to a specific, user-facing detail
// string at assessment time so the confirm card / ask_user_questions warning can
// name the actual host, the bundled skill it mimics, etc.
export type SkillRiskReason =
  | 'look-alike-domain'
  | 'typosquat-of-bundled-skill'
  | 'unknown-host'
  | 'no-commit-pin'
  | 'indirect-install-doc'
  | 'restrictive-license'

export type SkillSourceTrustTier = 'trusted' | 'community' | 'untrusted'

export interface SkillRiskReasonDetail {
  reason: SkillRiskReason
  detail: string
}

export interface SkillSourceRiskAssessment {
  tier: SkillSourceTrustTier
  reasons: SkillRiskReasonDetail[]
}

// Inputs the pure risk function reasons over. The resolver (main) builds this
// from whatever it parsed / fetched; the function itself does no I/O.
export interface SkillRiskContext {
  source?: SkillSource | null
  // Explicit host override (e.g. the host of an install-doc URL the source was
  // discovered through). When absent it is derived from `source`.
  host?: string | null
  // True when the source was reached via a fetched intermediate install doc.
  viaInstallDoc?: boolean
  // True when the source resolved to a pinned commit SHA / known tarball sha256;
  // false when it could not be pinned; undefined when not applicable.
  hasCommitPin?: boolean
  // License string, when known. `undefined` means "not yet determined" (no flag);
  // an explicit '' or 'unknown' flags as unknown-license.
  license?: string | null
  // Skill name(s) mentioned in the instruction, for typosquat detection.
  candidateSkillNames?: string[]
  // Bundled/embedded skill ids to compare against for typosquat.
  bundledSkillIds?: string[]
  // Additional hosts to treat as trusted (e.g. the configured domestic mirror).
  extraTrustedHosts?: string[]
}

// ---------------------------------------------------------------------------
// Resolution + install lifecycle
// ---------------------------------------------------------------------------

export interface SkillInstallProvenance {
  commitSha?: string | null
  sha256?: string | null
}

// What `resolveSkillSource` returns: everything the confirm step (UI dialog or
// ask_user_questions) needs to let the user decide, WITHOUT having installed.
export interface SkillSourceResolution {
  requestId: string
  input: string
  source: SkillSource | null
  provenance: SkillInstallProvenance | null
  risk: SkillSourceRiskAssessment
  // null = not yet determined (authoritatively detected at install time).
  requiresPython: boolean | null
  license: string | null
  // True when resolution produced an installable descriptor.
  installable: boolean
  // Human-facing reason when not installable.
  reason: string | null
  // True when the source was discovered through an intermediate install doc.
  viaInstallDoc: boolean
  // Alternative candidates (e.g. multiple repos found inside an install.md).
  candidates: SkillSource[]
}

// The confirmed install descriptor. `trustAck === true` is the single invariant
// the installer enforces — neither front door can install without it.
export interface SkillInstallRequest {
  requestId: string
  source: SkillSource
  downloadSource?: ModelSource
  trustAck: boolean
  provenance?: SkillInstallProvenance | null
}

export type SkillInstallPhase =
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'scanning'
  | 'deploying-deps'
  | 'installing'
  | 'done'
  | 'error'
  | 'cancelled'

// Superset of ModelPackDownloadStatus, keyed by requestId and phase-modeled so
// the renderer can render a precise per-install progress row.
export interface SkillInstallStatus {
  requestId: string
  phase: SkillInstallPhase
  source: SkillSource | null
  downloadSource: ModelSource | null
  provenance: SkillInstallProvenance | null
  progressPercent: number | null
  downloadedBytes: number
  totalBytes: number | null
  startedAt: string | null
  updatedAt: string | null
  completedAt: string | null
  lastMessage: string | null
  error: string | null
  skillId: string | null
  license: string | null
  requiresPython: boolean | null
}

export function createDefaultSkillInstallStatus(requestId: string): SkillInstallStatus {
  return {
    requestId,
    phase: 'resolving',
    source: null,
    downloadSource: null,
    provenance: null,
    progressPercent: null,
    downloadedBytes: 0,
    totalBytes: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    lastMessage: null,
    error: null,
    skillId: null,
    license: null,
    requiresPython: null,
  }
}

// ---------------------------------------------------------------------------
// Source self-test (mirror of ModelPackSelfTestReport): proves the fetch surface
// is reachable + the provenance/staging paths work WITHOUT a full download.
// ---------------------------------------------------------------------------

export interface SkillSourceProbe {
  source: Exclude<ModelSource, 'auto'>
  endpoint: string
  reachable: boolean
  latencyMs: number | null
}

export interface SkillSourceSelfTestReport {
  startedAt: string
  finishedAt: string
  probes: SkillSourceProbe[]
  anyReachable: boolean
  // A known ref→SHA resolved (provenance path proven; no payload pulled).
  refResolveOk: boolean
  refResolveDetail: string
  // Staging atomic create + cleanup on a scratch dir succeeded.
  stagingOk: boolean
  stagingDetail: string
}

// ===========================================================================
// Pure functions
// ===========================================================================

// GitHub usernames are alphanumeric with single hyphens (no dots, no leading /
// trailing hyphen); repo names additionally allow dots and underscores. Keeping
// owners dot-free is what stops `host.tld/path` shorthand from being misread as
// `owner/repo`.
function isValidGithubOwner(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)
}

function isValidGithubRepo(name: string): boolean {
  if (name === '.' || name === '..') return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

function matchTarballUrl(input: string): string | null {
  if (!/^https?:\/\//i.test(input)) return null
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return input
  return null
}

function parseGithubUrl(input: string): SkillSource | null {
  const normalized = input.replace(/^git\+/i, '')
  let host = ''
  let pathname = ''
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized)
      host = url.hostname.toLowerCase()
      pathname = url.pathname
    } catch {
      return null
    }
  } else if (/^(?:www\.)?github\.com\//i.test(normalized)) {
    const slash = normalized.indexOf('/')
    host = normalized.slice(0, slash).toLowerCase()
    pathname = normalized.slice(slash)
  } else {
    return null
  }
  if (host !== 'github.com' && host !== 'www.github.com') return null

  const segments = pathname.split('/').map((s) => s.trim()).filter(Boolean)
  if (segments.length < 2) return null
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/i, '')
  if (!isValidGithubOwner(owner) || !isValidGithubRepo(repo)) return null

  let ref: string | undefined
  let subdir: string | undefined
  // /tree/<ref>/<subdir...> — GitHub's browse URL shape for a monorepo subdir.
  if (segments[2] === 'tree' && segments[3]) {
    ref = decodeURIComponent(segments[3])
    if (segments.length > 4) {
      subdir = segments.slice(4).map((s) => decodeURIComponent(s)).join('/')
    }
  }
  return {
    kind: 'github',
    owner,
    repo,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
  }
}

function parseOwnerRepoShorthand(input: string): SkillSource | null {
  const match = input.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
  if (!match) return null
  const owner = match[1]
  const repo = match[2]
  if (!isValidGithubOwner(owner) || !isValidGithubRepo(repo)) return null
  return { kind: 'github', owner, repo }
}

// Parse a single freeform input string into a candidate SkillSource. Pure, no
// I/O. Recognizes (in order): a direct .tar.gz/.tgz URL; a github.com URL with
// or without scheme and optional /tree/<ref>/<subdir>; bare `owner/repo`.
export function parseSkillSourceInput(rawInput: string): SkillSourceParseResult {
  const input = (rawInput ?? '').trim()
  if (!input) {
    return { ok: false, reason: '请输入 GitHub 仓库地址或技能压缩包链接' }
  }

  const tarballUrl = matchTarballUrl(input)
  if (tarballUrl) return { ok: true, source: { kind: 'tarball', url: tarballUrl } }

  const githubFromUrl = parseGithubUrl(input)
  if (githubFromUrl) return { ok: true, source: githubFromUrl }

  const shorthand = parseOwnerRepoShorthand(input)
  if (shorthand) return { ok: true, source: shorthand }

  return {
    ok: false,
    reason: '无法识别来源：支持 GitHub 仓库（github.com/owner/repo 或 owner/repo）或 .tar.gz/.tgz 链接',
  }
}

// Hosts we treat as first-party-trustworthy for skill fetches.
const KNOWN_GOOD_HOSTS = new Set<string>([
  'github.com',
  'www.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
])

// Brand → canonical TLD. A host whose registrable second-level label matches a
// brand here but carries a different TLD is flagged as a look-alike (the classic
// `xiaohongshu.net` ≠ `xiaohongshu.com` store-impersonation shape).
const KNOWN_BRAND_CANONICAL_TLD: Record<string, string> = {
  github: 'com',
  githubusercontent: 'com',
  xiaohongshu: 'com',
  modelscope: 'cn',
  huggingface: 'co',
  pypi: 'org',
}

function effectiveHost(ctx: SkillRiskContext): string | null {
  if (ctx.host && ctx.host.trim()) return ctx.host.trim().toLowerCase()
  const source = ctx.source
  if (!source) return null
  if (source.kind === 'github') return 'github.com'
  if (source.kind === 'tarball') {
    try {
      return new URL(source.url).hostname.toLowerCase()
    } catch {
      return null
    }
  }
  return null
}

function isTrustedHost(host: string, extraTrusted: Set<string>): boolean {
  if (KNOWN_GOOD_HOSTS.has(host) || extraTrusted.has(host)) return true
  return host === 'github.com'
    || host.endsWith('.github.com')
    || host.endsWith('.githubusercontent.com')
}

function detectLookAlikeBrand(
  host: string,
): { brand: string; canonicalTld: string; actualTld: string } | null {
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return null
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  const canonical = KNOWN_BRAND_CANONICAL_TLD[sld]
  if (canonical && canonical !== tld) {
    return { brand: sld, canonicalTld: canonical, actualTld: tld }
  }
  return null
}

function detectTyposquat(rawName: string, bundledLower: string[]): string | null {
  const name = rawName.trim().toLowerCase()
  if (!name) return null
  // An exact match is the real skill, not a squat.
  if (bundledLower.includes(name)) return null
  // The classic store squat appends a version/date-ish suffix (…-260324).
  const stripped = name.replace(/[-_](?:v?\d[\w.]*)$/, '')
  for (const id of bundledLower) {
    if (stripped === id) return id
    if (name.startsWith(`${id}-`) || name.startsWith(`${id}_`)) return id
  }
  return null
}

function isRestrictiveOrUnknownLicense(license: string): boolean {
  if (!license) return false
  const upper = license.toUpperCase()
  if (upper === 'UNKNOWN' || upper === 'NOASSERTION') return true
  return upper.includes('AGPL') || upper.includes('GPL') || upper.includes('SSPL')
}

function deriveTier(reasons: SkillRiskReasonDetail[]): SkillSourceTrustTier {
  const set = new Set(reasons.map((r) => r.reason))
  if (
    set.has('look-alike-domain')
    || set.has('typosquat-of-bundled-skill')
    || set.has('unknown-host')
  ) {
    return 'untrusted'
  }
  if (
    set.has('indirect-install-doc')
    || set.has('no-commit-pin')
    || set.has('restrictive-license')
  ) {
    return 'community'
  }
  return 'trusted'
}

// Classify a resolved source into a trust tier + concrete risk reasons. Pure: no
// network, no filesystem. The resolver supplies the context (host, candidate
// names, license, pin state); this only maps that to reasons + a tier.
export function assessSkillSourceRisk(ctx: SkillRiskContext): SkillSourceRiskAssessment {
  const reasons: SkillRiskReasonDetail[] = []
  const extraTrusted = new Set<string>((ctx.extraTrustedHosts ?? []).map((h) => h.toLowerCase()))
  const host = effectiveHost(ctx)

  if (host) {
    const lookAlike = detectLookAlikeBrand(host)
    if (lookAlike) {
      reasons.push({
        reason: 'look-alike-domain',
        detail: `域名 ${host} 形似 ${lookAlike.brand}.${lookAlike.canonicalTld}，实际后缀为 .${lookAlike.actualTld}，可能是仿冒站点`,
      })
    } else if (!isTrustedHost(host, extraTrusted)) {
      reasons.push({
        reason: 'unknown-host',
        detail: `来源主机 ${host} 不在已知可信列表中（如 github.com）`,
      })
    }
  }

  const bundled = (ctx.bundledSkillIds ?? []).map((s) => s.toLowerCase())
  const seenSquats = new Set<string>()
  for (const rawName of ctx.candidateSkillNames ?? []) {
    const squat = detectTyposquat(rawName, bundled)
    if (squat && !seenSquats.has(`${rawName}=>${squat}`)) {
      seenSquats.add(`${rawName}=>${squat}`)
      reasons.push({
        reason: 'typosquat-of-bundled-skill',
        detail: `名称「${rawName.trim()}」与内置技能「${squat}」高度相似，可能是仿冒`,
      })
    }
  }

  if (ctx.viaInstallDoc) {
    reasons.push({
      reason: 'indirect-install-doc',
      detail: '该来源通过远程安装说明文档间接给出，已仅作为数据解析其真实下载地址，请确认指向无误',
    })
  }

  if (ctx.hasCommitPin === false) {
    reasons.push({
      reason: 'no-commit-pin',
      detail: '未能锁定到具体提交（commit 或 sha256），无法保证后续下载内容不变',
    })
  }

  const license = (ctx.license ?? '').trim()
  if (isRestrictiveOrUnknownLicense(license)) {
    reasons.push({
      reason: 'restrictive-license',
      detail: license
        ? `许可证为 ${license}，使用前请确认合规`
        : '未能识别许可证，使用前请确认合规',
    })
  }

  return { tier: deriveTier(reasons), reasons }
}
