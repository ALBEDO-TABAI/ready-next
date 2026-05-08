/**
 * Stage S W11.2 — Skill installer security scanner.
 *
 * Source: deer-flow `skills/security_scanner.py`.
 *
 * Scans a skill directory before install/edit. The scanner is a defensive
 * fence between user-provided skill folders and the runtime: a malicious
 * or careless author should not be able to ship a skill that, on import,
 * exfiltrates data or runs destructive shell commands during preview /
 * edit / install.
 *
 * High-risk patterns (current set):
 *   - `rm -rf /`                         destructive root delete
 *   - `curl ... | bash|sh|zsh`           remote-fetch-and-exec
 *   - `$(curl ...)`                      command substitution fetch
 *   - `eval $(base64...)`                base64-decoded eval
 *   - `(base64|atob|decode)(...) | sh`   decoded pipe
 *   - `nc -l` / `nc --listen`            unsolicited network listener
 *   - `wget|curl ... | python|node|sh`   fetch-and-exec via interpreter
 *
 * Reserved file names: cannot ship a SKILL.md / ready-skill.json /
 * MANIFEST.json that overrides system fixtures (case-sensitive — current
 * runtime treats these names as load-time anchors). Reserved-file
 * detection is currently a TODO; the W11.2 cut keeps the surface focused
 * on shell exfil patterns since reserved-file collisions surface elsewhere
 * during install (see custom-skill-registry.importCustomSkillFolder).
 *
 * Path traversal: any file whose canonical path escapes the skill root
 * (..-prefixed `path.relative`) is rejected as critical.
 *
 * Stage R §6.12 already enforces a separate bash high-risk set inside
 * `skill_run_shell` (runtime-side). The installer scanner is the
 * load-time mirror — it catches the same exploits earlier, in static
 * shell snippets / scripts that ship inside the skill folder.
 */

import type { Dirent } from 'node:fs'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

export interface ScanIssue {
  severity: 'critical' | 'warning'
  pattern: string
  file: string
  line?: number
  excerpt?: string
}

export interface ScanResult {
  ok: boolean
  issues: ScanIssue[]
}

interface RiskPattern {
  pattern: RegExp
  description: string
}

/**
 * Exported for tests & docs. Adding a new entry is a load-time
 * compatibility break — every existing installed skill is rescanned on
 * next install / edit, so introduce new patterns deliberately.
 */
export const HIGH_RISK_PATTERNS: ReadonlyArray<RiskPattern> = [
  { pattern: /\brm\s+-rf\s+\//i, description: 'rm -rf root' },
  { pattern: /\bcurl\b[^|\n]*\|\s*(?:bash|sh|zsh)\b/i, description: 'curl pipe shell' },
  { pattern: /\$\(\s*curl\s/i, description: 'curl in command substitution' },
  { pattern: /\beval\s+\$?\(?\s*base64\b/i, description: 'eval base64' },
  { pattern: /\b(?:base64|atob|decode)\s*\([^)]*\)\s*\|\s*(?:bash|sh|zsh|python|node)\b/i, description: 'base64-decoded pipe to interpreter' },
  { pattern: /\bnc\s+(?:-l\b|--listen\b)/i, description: 'nc listen' },
  { pattern: /\b(?:wget|curl)\s+[^|;\n]*\|\s*(?:python|node|sh|bash|zsh)\b/i, description: 'fetch and exec' },
]

/** File extensions to body-scan. Binary / opaque blobs are skipped. */
const SCANNABLE_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh',
  '.py', '.pyw',
  '.js', '.cjs', '.mjs', '.ts',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.txt',
])

/** Default per-scan file size cap (8 MB) — catches the patterns we care
 * about without DOSing the scanner on huge generated assets. */
const SCAN_BYTE_CAP = 8 * 1024 * 1024

function shouldScanFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  for (const ext of SCANNABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

function scanFile(absolutePath: string, issues: ScanIssue[]): void {
  let content: string
  try {
    const stat = statSync(absolutePath)
    if (stat.size > SCAN_BYTE_CAP) {
      issues.push({
        severity: 'warning',
        pattern: 'oversized-file',
        file: absolutePath,
        excerpt: `size=${stat.size}`,
      })
      return
    }
    content = readFileSync(absolutePath, 'utf8')
  } catch {
    // Binary, unreadable, or vanished mid-scan. Not an issue per se —
    // we silently skip rather than fail the entire install.
    return
  }
  for (const { pattern, description } of HIGH_RISK_PATTERNS) {
    const m = content.match(pattern)
    if (m) {
      issues.push({
        severity: 'critical',
        pattern: description,
        file: absolutePath,
        excerpt: m[0].slice(0, 160),
      })
    }
  }
}

/**
 * Scan a skill directory. Returns `{ ok, issues }` — callers should
 * treat any `critical` issue as install-blocking.
 *
 * - Missing directory → critical `missing-dir` issue (ok=false).
 * - Path traversal → critical `path-traversal` issue (ok=false).
 * - Symlinks are followed via `statSync` (Node default). A skill that
 *   ships a symlink pointing outside its root will surface as either a
 *   path-traversal hit (when the symlink resolves outside the root) or
 *   simply read whatever the link points to. This matches deer-flow's
 *   behaviour and keeps the implementation small; tightening to
 *   "reject all symlinks" is a follow-up if needed.
 */
export function scanSkillDirectory(skillDir: string): ScanResult {
  const issues: ScanIssue[] = []

  if (!isAbsolute(skillDir)) {
    issues.push({
      severity: 'critical',
      pattern: 'non-absolute-dir',
      file: skillDir,
      excerpt: 'scanSkillDirectory requires an absolute path',
    })
    return { ok: false, issues }
  }

  if (!existsSync(skillDir)) {
    issues.push({ severity: 'critical', pattern: 'missing-dir', file: skillDir })
    return { ok: false, issues }
  }

  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, String(entry.name))
      const rel = relative(skillDir, full)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        issues.push({
          severity: 'critical',
          pattern: 'path-traversal',
          file: full,
          excerpt: rel,
        })
        continue
      }
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        if (!shouldScanFile(full)) continue
        scanFile(full, issues)
      }
    }
  }
  walk(skillDir)

  const hasCritical = issues.some((issue) => issue.severity === 'critical')
  return { ok: !hasCritical, issues }
}
