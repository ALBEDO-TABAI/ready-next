/**
 * Stage T (PR-T2 / W7.1) — sandbox high-risk pattern audit for `skill_run_shell`.
 *
 * Source: deer-flow `agents/middlewares/sandbox_audit_middleware.py:25-51, 137-189`
 * `_HIGH_RISK_PATTERNS`. Ported to TypeScript regex form.
 *
 * The `auditBashCommand` helper is invoked at the top of `executeRunShell`,
 * **before** the `shouldUseShell` branch, so that both the `bash -c <command>`
 * compound path AND the `parseCommand` argv path share one audit gate. This
 * closes the bypass where `| sh / $(curl ...) / >/etc/...` snippets travelled
 * through `bash -c` without ever touching `parseCommand`.
 *
 * Hits return `allowed: false` plus the matched pattern + human-readable
 * description so the caller can throw a structured `ToolDomainError`
 * (`errorKind: 'command_high_risk_blocked'`) carrying the rejection detail.
 */

export interface BashRiskMatch {
  pattern: string
  description: string
}

export interface BashAuditResult {
  allowed: boolean
  matched?: BashRiskMatch
}

/**
 * 11 high-risk patterns. Each entry pairs a regex with a short description
 * that surfaces back to the model in the rejection detail. Keep the list
 * literal — the structural gate `check-sandbox-bash-high-risk-patterns.cjs`
 * counts entries and asserts each fixture command matches.
 */
export const HIGH_RISK_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+-rf\s+\/(?:\s|$)/i, description: 'rm -rf root' },
  { pattern: /\brm\s+-rf\s+\$HOME/i, description: 'rm -rf $HOME' },
  { pattern: /\bdd\s+if=/i, description: 'dd raw write' },
  { pattern: /\bmkfs\b/i, description: 'mkfs' },
  // R4 round-4 fix — drop `$/m` end-anchor so `| sh -s` / `| sh -c "..."` are
  // also caught, not only the bare-tail `| sh` form.
  { pattern: /\|\s*(?:bash|sh|zsh)\b/i, description: 'pipe to shell' },
  { pattern: /\$\(curl\s/i, description: 'curl in cmd substitution' },
  { pattern: /\bbase64\s+-d\s*\|/i, description: 'base64 decode pipe' },
  { pattern: />\s*\/etc\//i, description: 'overwrite /etc' },
  { pattern: />\s*\/usr\/bin\//i, description: 'overwrite /usr/bin' },
  { pattern: /\bwget\b[^|;]*\|\s*(?:python|node|sh|bash)\b/i, description: 'wget exec' },
  // Round-1 (Codex) fix — classic bash fork bomb `:(){ :|:& };:`.
  // Structure: `:` `(` `)` `{` `:` `|` `:` `&` `}` `;` `:` — the `&` runs
  // the `:|:` recursion in the background, the `;` separates from the
  // outermost call. Tolerate optional whitespace between every token.
  { pattern: /:\s*\(\s*\)\s*\{\s*:[\s|]+:\s*&\s*\}\s*;\s*:/, description: 'fork bomb' },
]

export function auditBashCommand(command: string): BashAuditResult {
  if (typeof command !== 'string' || command.length === 0) {
    return { allowed: true }
  }
  for (const { pattern, description } of HIGH_RISK_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, matched: { pattern: pattern.source, description } }
    }
  }
  return { allowed: true }
}
