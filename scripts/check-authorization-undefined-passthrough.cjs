#!/usr/bin/env node
/**
 * Stage 10 (P) — `authorization` undefined-passthrough gate.
 *
 * Plan §3.8.3. After Stage 10 the model-visible call surfaces all take
 * `authorization: SkillToolAuthorization` as a required, non-nullable
 * field. The W3a-era `?? null` / `?? undefined` filler patterns no longer
 * compile — but a contributor could still squeak by with `authorization
 * as any` or with a `?? buildExplicitNoSkillAuthorization(...)` filler
 * that hides a missing decision. This gate forbids the former (any-cast)
 * and the legacy `?? null|undefined` shapes; the legitimate helper-based
 * fallback in `execution-tool-config.ts::resolvePolicyAuthorization` is
 * not flagged because its RHS is a named function call, not `null` or
 * `undefined`.
 *
 * Scope (4 files, per plan §3.8.3):
 *   - src/main/modules/agent-control/tool-registry.ts
 *   - src/main/modules/agent-control/tool-gateway.ts
 *   - src/main/modules/agent-control/execution-tool-config.ts
 *   - src/main/modules/tools/index.ts
 *
 * Forbidden patterns (line comments / block comments / string literals
 * are stripped first):
 *   - `authorization ?? undefined` / `authorization ?? null`
 *   - `authorization || undefined` / `authorization || null`
 *   - `authorization as any`
 *   - `<expr>.authorization ?? undefined|null` / `|| undefined|null`
 *   - `filterToolsByAuthorization(<arg>, undefined|null|… ?? …|… || …|… as any, …)`
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const TARGET_REL_FILES = [
  'src/main/modules/agent-control/tool-registry.ts',
  'src/main/modules/agent-control/tool-gateway.ts',
  'src/main/modules/agent-control/execution-tool-config.ts',
  'src/main/modules/tools/index.ts',
]

const FORBIDDEN_PATTERNS = [
  {
    name: 'authorization ?? null|undefined',
    regex: /\bauthorization\s*\?\?\s*(?:undefined|null)\b/,
  },
  {
    name: 'authorization || null|undefined',
    regex: /\bauthorization\s*\|\|\s*(?:undefined|null)\b/,
  },
  {
    name: 'authorization as any',
    regex: /\bauthorization\s+as\s+any\b/,
  },
  {
    name: '.authorization ?? null|undefined',
    regex: /\.authorization\s*\?\?\s*(?:undefined|null)\b/,
  },
  {
    name: '.authorization || null|undefined',
    regex: /\.authorization\s*\|\|\s*(?:undefined|null)\b/,
  },
  {
    // filterToolsByAuthorization(_, <bad>, ...) where <bad> is null,
    // undefined, an `as any` cast, or a `?? null|undefined` / `||
    // null|undefined` expression.
    name: 'filterToolsByAuthorization with undefined/null/any second arg',
    regex:
      /\bfilterToolsByAuthorization\s*\(\s*[^,)]+,\s*(?:undefined|null|[^,)]*\bas\s+any\b|[^,)]*\?\?\s*(?:undefined|null)\b|[^,)]*\|\|\s*(?:undefined|null)\b)/,
  },
]

function stripCommentsAndStrings(src) {
  // Remove block comments first.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  // Remove line comments.
  out = out.replace(/\/\/[^\n]*/g, '')
  // Remove string literals (single, double, backtick) — replace contents
  // with spaces, preserving line counts.
  out = out.replace(/'(?:\\.|[^'\\\n])*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
  out = out.replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
  out = out.replace(/`(?:\\.|[^`\\])*`/g, (m) => '`' + ' '.repeat(Math.max(0, m.length - 2)) + '`')
  return out
}

function checkAuthorizationUndefinedPassthrough({ root = REPO } = {}) {
  const violations = []
  for (const rel of TARGET_REL_FILES) {
    const file = path.join(root, rel)
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const stripped = stripCommentsAndStrings(raw)
    const lines = stripped.split('\n')
    const rawLines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(lines[i])) {
          violations.push({
            file,
            line: i + 1,
            pattern: name,
            code: rawLines[i].trim(),
          })
        }
      }
    }
  }
  return { violations }
}

function main() {
  const args = process.argv.slice(2)
  let root = REPO
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      root = path.resolve(args[i + 1])
      i++
    }
  }

  const { violations } = checkAuthorizationUndefinedPassthrough({ root })
  if (violations.length === 0) {
    console.log('[check-authorization-undefined-passthrough] OK')
    return 0
  }

  console.error('[check-authorization-undefined-passthrough] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  console.error('')
  console.error('Stage 10 (P): model-visible authorization is required and non-nullable.')
  console.error("`?? null` / `?? undefined` filler and `as any` casts are retired.")
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { checkAuthorizationUndefinedPassthrough }
