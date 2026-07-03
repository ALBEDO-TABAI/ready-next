#!/usr/bin/env node
/**
 * Stage 10 (P) — `authorization` undefined-passthrough gate.
 *
 * Plan §3.8.3. After Stage 10 the model-visible call surfaces all take
 * `authorization: SkillToolAuthorization` as a required, non-nullable
 * field. The W3a-era `?? null` / `?? undefined` filler patterns no longer
 * compile — but a contributor could still squeak by with `authorization
 * as any` (or `as unknown as SkillToolAuthorization`) or with a
 * `?? buildExplicitNoSkillAuthorization(...)` filler that hides a missing
 * decision. This gate forbids the former (any-cast / unknown-cast) and
 * the legacy `?? null|undefined` shapes; the legitimate helper-based
 * fallback (`?? buildExplicitNoSkillAuthorization(...)`) is allowed
 * because its RHS is a named function call producing a real
 * `SkillToolAuthorization`, not `null` or `undefined`.
 *
 * Stage 10 final-review extension: scope broadened to also cover the
 * runtime / orchestrator / executor admission surfaces (so an `as any`
 * bypass anywhere on the model→tool path is caught), and the gate now
 * scans both line-by-line and on a whitespace-collapsed view (so
 * multiline `filterToolsByAuthorization(\n  tools,\n  undefined,\n  …)`
 * is flagged just like the single-line form).
 *
 * Scope (extended in Stage 10 final review):
 *   - src/main/modules/agent-control/tools-runtime/tool-registry.ts
 *   - src/main/modules/agent-control/tools-runtime/tool-gateway.ts
 *   - src/main/modules/agent-control/tool-policy/execution-tool-config.ts
 *   - src/main/modules/agent-control/tool-policy/execution-tool-skill-filters.ts
 *   - src/main/modules/tools/index.ts
 *   - src/main/modules/agent-control/tools-runtime/tool-runtime.ts
 *   - src/main/modules/tools/tool-executor.ts
 *
 * Forbidden patterns (line comments / block comments / string literals
 * are stripped first):
 *   - `authorization ?? undefined` / `authorization ?? null`
 *   - `authorization || undefined` / `authorization || null`
 *   - `authorization as any`
 *   - `authorization as unknown as SkillToolAuthorization` (and any
 *     `as unknown as Skill*` cast applied to authorization)
 *   - `<expr>.authorization ?? undefined|null` / `|| undefined|null`
 *   - `filterToolsByAuthorization(<arg>, undefined|null|<as any>|<?? null/undefined>|<|| null/undefined>, …)`
 *     — including the multiline form (whitespace collapsed before match)
 *   - in execution-tool-skill-filters.ts only: optional/nullable helper
 *     authorization parameters or `if (!authorization)` passthrough
 *
 * Allowed (NOT flagged):
 *   - `context?.authorization ?? buildExplicitNoSkillAuthorization(...)`
 *     and similar named-helper fallbacks that produce a real
 *     `SkillToolAuthorization`.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const TARGET_REL_FILES = [
  'src/main/modules/agent-control/tools-runtime/tool-registry.ts',
  'src/main/modules/agent-control/tools-runtime/tool-gateway.ts',
  'src/main/modules/agent-control/tool-policy/execution-tool-config.ts',
  'src/main/modules/agent-control/tool-policy/execution-tool-skill-filters.ts',
  'src/main/modules/tools/index.ts',
  'src/main/modules/agent-control/tools-runtime/tool-runtime.ts',
  'src/main/modules/tools/tool-executor.ts',
]

// Per-line patterns: each is matched against a single (comments-stripped)
// line. The `as unknown as Skill*` pattern catches casts that bypass the
// runtime invariant in `createAttemptContext` / `executeToolCall`.
const LINE_FORBIDDEN_PATTERNS = [
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
    // `authorization as unknown as SkillToolAuthorization` (or any
    // `as unknown as Skill*` re-cast applied to authorization).
    name: 'authorization as unknown as Skill*',
    regex: /\bauthorization\s+as\s+unknown\s+as\s+Skill\w*/,
  },
  {
    name: '.authorization ?? null|undefined',
    regex: /\.authorization\s*\?\?\s*(?:undefined|null)\b/,
  },
  {
    name: '.authorization || null|undefined',
    regex: /\.authorization\s*\|\|\s*(?:undefined|null)\b/,
  },
]

// Whole-file patterns: matched against a whitespace-collapsed view of the
// file (stripped of comments and string literals first). Used to catch
// multiline forms like `filterToolsByAuthorization(\n  tools,\n  undefined,
// \n  getName)`.
const WHOLE_FILE_FORBIDDEN_PATTERNS = [
  {
    // filterToolsByAuthorization(<arg>, <bad>, …) where <bad> is null,
    // undefined, an `as any` / `as unknown as Skill*` cast, or a
    // `?? null|undefined` / `|| null|undefined` expression. Matched on
    // the whitespace-collapsed view so multiline calls are flagged too.
    name: 'filterToolsByAuthorization with undefined/null/any second arg (incl. multiline)',
    regex:
      /\bfilterToolsByAuthorization\s*\(\s*[^,)]+,\s*(?:undefined|null|[^,)]*\bas\s+any\b|[^,)]*\bas\s+unknown\s+as\s+Skill\w*|[^,)]*\?\?\s*(?:undefined|null)\b|[^,)]*\|\|\s*(?:undefined|null)\b)/,
  },
]

const SKILL_FILTERS_REL = 'src/main/modules/agent-control/tool-policy/execution-tool-skill-filters.ts'
const SKILL_FILTERS_FORBIDDEN_PATTERNS = [
  {
    name: 'skill filter helper optional authorization parameter',
    regex: /\bauthorization\s*\?:/,
  },
  {
    name: 'skill filter helper nullable authorization parameter',
    regex: /\bauthorization\s*:\s*SkillToolAuthorization\s*\|\s*(?:null|undefined)\b/,
  },
  {
    name: 'skill filter helper missing authorization passthrough',
    regex: /\bif\s*\(\s*!authorization\s*\)\s*return\s+true\b/,
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

    // Pass 1 — per-line patterns.
    for (let i = 0; i < lines.length; i++) {
      for (const { name, regex } of LINE_FORBIDDEN_PATTERNS) {
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

    // Pass 2 — whole-file (whitespace-collapsed) patterns. Build a
    // single line where every run of whitespace becomes a single space,
    // and produce a parallel offset map so we can recover the original
    // line number when a match lands.
    const collapsed = []
    const offsetMap = [] // offsetMap[i] = original line index for collapsed char i
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (let j = 0; j < line.length; j++) {
        collapsed.push(line[j])
        offsetMap.push(i)
      }
      // Newline becomes a single space in the collapsed view.
      collapsed.push(' ')
      offsetMap.push(i)
    }
    const collapsedSource = collapsed.join('').replace(/\s+/g, (m, idx) => {
      // Keep one space; trim subsequent offsetMap entries to align with
      // the collapsed character count.
      const keepIdx = idx
      // Mark the offsets to drop by setting them to -1; the final
      // alignment happens just below.
      void keepIdx
      return ' '
    })
    // Build a properly-aligned offsetMap for the collapsed source where
    // every character is a non-whitespace char or a single space.
    const alignedOffsetMap = []
    let prevWasSpace = false
    for (let i = 0; i < collapsed.length; i++) {
      const ch = collapsed[i]
      const isSpace = /\s/.test(ch)
      if (isSpace) {
        if (prevWasSpace) continue
        alignedOffsetMap.push(offsetMap[i])
        prevWasSpace = true
      } else {
        alignedOffsetMap.push(offsetMap[i])
        prevWasSpace = false
      }
    }

    for (const { name, regex } of WHOLE_FILE_FORBIDDEN_PATTERNS) {
      const globalRe = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
      let m
      while ((m = globalRe.exec(collapsedSource)) !== null) {
        const charIndex = m.index
        const lineIndex = alignedOffsetMap[charIndex] ?? 0
        violations.push({
          file,
          line: lineIndex + 1,
          pattern: name,
          code: rawLines[lineIndex]?.trim() || '<multiline>',
        })
        if (m.index === globalRe.lastIndex) globalRe.lastIndex += 1
      }
    }

    if (rel === SKILL_FILTERS_REL) {
      for (let i = 0; i < lines.length; i++) {
        for (const { name, regex } of SKILL_FILTERS_FORBIDDEN_PATTERNS) {
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
