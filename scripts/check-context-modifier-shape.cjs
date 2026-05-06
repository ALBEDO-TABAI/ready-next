#!/usr/bin/env node
/**
 * Stage M (M8) — `framePatch.activeArtifactRoots` ↔ `contextModifier.
 * activeFrame.activeArtifactRoots` symmetry gate.
 *
 * Plan §3.4: any source location that emits `framePatch.activeArtifactRoots`
 * MUST also emit a matching `contextModifier`. There is one trusted helper
 * (`attachContractFramePatch` in skills-tools.ts) which auto-emits the
 * matching modifier; callers of that helper inherit symmetry. Every other
 * site must explicitly emit both fields in the same `createToolExecutionOutput`
 * call (or an equivalent return literal).
 *
 * Detection (regex + window-based — the AST-aware variant per plan v8 §3.0
 * is deferred):
 *   1. Find every `createToolExecutionOutput(...)` call whose options
 *      object literal contains `framePatch:` AND the bound framePatch
 *      identifier carries `activeArtifactRoots` (we look for both
 *      `activeArtifactRoots:` literal forms inside the same call AND
 *      `framePatch.activeArtifactRoots` reads near the call site).
 *   2. The same options object MUST also contain `contextModifier:` AND
 *      that contextModifier's `activeFrame.activeArtifactRoots:` must be
 *      visible nearby.
 *   3. Helper-trusted sites (calls to `attachContractFramePatch(...)`) are
 *      exempt — the helper guarantees symmetry post-M5a-helper.
 *   4. Allowlist entries (scripts/check-context-modifier-shape.allowlist.json)
 *      bypass the check at named line ranges with an explicit reason.
 *
 * False-positive controls:
 *   - Entire src/__tests__/** is skipped (test fixtures may exercise
 *     asymmetric returns to verify the gate logic).
 *   - The check is restricted to src/main/modules/tools/**.
 *
 * v8-acknowledged limitation: this regex-based detection cannot trace
 * helpers other than `attachContractFramePatch`. Other framePatch
 * builders (`buildContractFramePatch`, `buildInspectFramePatch`) — when
 * called inside an explicit `createToolExecutionOutput` site — are checked
 * via the call-site rule. Indirect helper chains may slip through; that
 * trades soundness for shipping the gate without authoring full TS-AST
 * machinery in this stage.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOT = path.join(REPO, 'src/main/modules/tools')
const SKILLS_TOOLS_FILE = path.join(SCAN_ROOT, 'skills-tools.ts')
const ALLOWLIST_FILE = path.join(__dirname, 'check-context-modifier-shape.allowlist.json')

const TRUSTED_HELPER_NAMES = new Set([
  'attachContractFramePatch',
])

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_FILE)) {
    return { entries: [] }
  }
  let raw
  try {
    raw = fs.readFileSync(ALLOWLIST_FILE, 'utf8')
  } catch (err) {
    console.error(`[check-context-modifier-shape] failed to read allowlist: ${err.message}`)
    process.exit(2)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`[check-context-modifier-shape] allowlist is not valid JSON: ${err.message}`)
    process.exit(2)
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  // Validate schema.
  const errors = []
  for (const [i, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`#${i}: not an object`)
      continue
    }
    for (const key of ['file', 'lineStart', 'lineEnd', 'reason', 'addedBy', 'addedAt']) {
      if (!(key in entry)) errors.push(`#${i}: missing field "${key}"`)
    }
    if (typeof entry.reason === 'string' && entry.reason.trim().length < 20) {
      errors.push(`#${i}: reason must be ≥ 20 non-whitespace chars`)
    }
    if (typeof entry.lineStart !== 'number' || typeof entry.lineEnd !== 'number') {
      errors.push(`#${i}: lineStart and lineEnd must be numbers`)
    }
  }
  if (errors.length > 0) {
    console.error('[check-context-modifier-shape] allowlist schema errors:')
    for (const err of errors) console.error('  ', err)
    process.exit(2)
  }
  return { entries }
}

function isAllowlisted(file, line, allowlist) {
  const rel = path.relative(REPO, file).replace(/\\/g, '/')
  for (const entry of allowlist.entries) {
    const entryFile = entry.file.replace(/\\/g, '/')
    if (entryFile !== rel) continue
    if (typeof entry.lineStart === 'number' && typeof entry.lineEnd === 'number'
        && line >= entry.lineStart && line <= entry.lineEnd) {
      return true
    }
  }
  return false
}

function listFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        stack.push(full)
      } else if (full.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  return out
}

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * Find every `createToolExecutionOutput(...)` call whose options object
 * literal contains a `framePatch:` field. Returns array of objects
 * { startLine, endLine, snippet, file }.
 */
function findCreateOutputCalls(file, src) {
  const out = []
  const re = /createToolExecutionOutput\s*\(/g
  let match
  while ((match = re.exec(src)) !== null) {
    const startIdx = match.index
    // Find the matching close-paren (simple paren-counter, since string
    // literals & comments have already been pre-stripped where relevant).
    let depth = 1
    let i = re.lastIndex // index of '(' + 1
    let inSingle = false
    let inDouble = false
    let inBacktick = false
    while (i < src.length && depth > 0) {
      const ch = src[i]
      const prev = src[i - 1]
      if (!inDouble && !inBacktick && ch === "'" && prev !== '\\') inSingle = !inSingle
      else if (!inSingle && !inBacktick && ch === '"' && prev !== '\\') inDouble = !inDouble
      else if (!inSingle && !inDouble && ch === '`' && prev !== '\\') inBacktick = !inBacktick
      else if (!inSingle && !inDouble && !inBacktick) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
      }
      i++
    }
    if (depth === 0) {
      const snippet = src.slice(startIdx, i)
      // Compute line numbers.
      const startLine = src.slice(0, startIdx).split('\n').length
      const endLine = src.slice(0, i).split('\n').length
      out.push({ file, startLine, endLine, snippet })
    }
  }
  return out
}

function snippetCarriesFramePatchActiveRoots(snippet) {
  // Path A — literal in-snippet co-occurrence: a `framePatch:` field whose
  // value contains `activeArtifactRoots`.
  const hasFramePatch = /\bframePatch\s*:/.test(snippet)
  const hasActiveRoots = /\bactiveArtifactRoots\b/.test(snippet)
  if (hasFramePatch && hasActiveRoots) return true
  return false
}

/**
 * Stage M post-review fix — collect every framePatch IDENTIFIER binding in
 * the file whose RHS carries `activeArtifactRoots`. The current real-world
 * patterns are:
 *
 *   pattern A (literal):
 *     const framePatch = buildContractFramePatch({ ..., activeArtifactRoots: [...] })
 *
 *   pattern B (destructured from a builder):
 *     const { framePatch, contract } = buildInspectFramePatch({ ... })
 *     // ^ buildInspectFramePatch's BODY contains activeArtifactRoots, but its
 *     //   RHS at the binding doesn't.
 *
 * The shorthand `framePatch` in the call snippet doesn't itself contain the
 * `activeArtifactRoots` token; we need to look BACK to the binding to know
 * whether the local carries roots. Codex final review #1 (round 2) flagged
 * pattern A; round 3 flagged pattern B.
 *
 * Lite implementation: brace-balanced RHS extraction PLUS recognition of a
 * curated set of "root-producing helpers" whose return values are always
 * roots-carrying.
 */
const ROOT_PRODUCING_HELPERS = new Set([
  'buildContractFramePatch',
  'buildInspectFramePatch',
])

function collectRootsCarryingFramePatchBindings(src) {
  const names = new Set()
  // Match `const framePatch = ` or `const { framePatch, ... } = ` or
  // `let framePatch = `.
  const re = /\b(?:const|let|var)\s+(?:\{[^}]*\bframePatch\b[^}]*\}|framePatch)\s*=\s*/g
  while (re.exec(src) !== null) {
    const startIdx = re.lastIndex
    // RHS extraction with brace + paren balance, ignoring string literals.
    let depth = 0
    let inSingle = false
    let inDouble = false
    let inBacktick = false
    let i = startIdx
    while (i < src.length) {
      const ch = src[i]
      const prev = src[i - 1]
      if (!inDouble && !inBacktick && ch === "'" && prev !== '\\') inSingle = !inSingle
      else if (!inSingle && !inBacktick && ch === '"' && prev !== '\\') inDouble = !inDouble
      else if (!inSingle && !inDouble && ch === '`' && prev !== '\\') inBacktick = !inBacktick
      else if (!inSingle && !inDouble && !inBacktick) {
        if (ch === '{' || ch === '(' || ch === '[') depth++
        else if (ch === '}' || ch === ')' || ch === ']') {
          depth--
          if (depth < 0) break
        } else if (depth === 0 && ch === ';') break
        else if (depth === 0 && ch === '\n' && /[\n\r]/.test(src[i + 1] || '')) break
      }
      i++
    }
    const rhs = src.slice(startIdx, i)
    // Pattern A — RHS literal contains activeArtifactRoots.
    if (/\bactiveArtifactRoots\b/.test(rhs)) {
      names.add('framePatch')
      continue
    }
    // Pattern B — RHS calls a known root-producing helper. The helper's body
    // is what carries activeArtifactRoots; the binding inherits via return.
    for (const helper of ROOT_PRODUCING_HELPERS) {
      const helperRe = new RegExp(`\\b${helper}\\s*\\(`)
      if (helperRe.test(rhs)) {
        names.add('framePatch')
        break
      }
    }
  }
  return names
}

/**
 * Snippet uses an identifier that we know carries roots. Tested via shorthand
 * `framePatch` (with no other `: ...` after it) or a `framePatch: someName`
 * where someName is in the carriers set.
 */
function snippetUsesRootsCarryingIdentifier(snippet, carriers) {
  if (carriers.size === 0) return false
  // Shorthand `framePatch,` or `framePatch }` (no colon after) inside the
  // options object literal.
  if (/\bframePatch\s*[,}]/.test(snippet)) return true
  // Explicit `framePatch: <ident>` where ident is a carrier.
  for (const name of carriers) {
    const re = new RegExp(`\\b\\w+\\s*:\\s*${name}\\b`)
    if (re.test(snippet)) return true
  }
  return false
}

function snippetCarriesContextModifierRoots(snippet) {
  const hasContextModifier = /\bcontextModifier\s*:/.test(snippet)
  if (!hasContextModifier) return false
  // Need either a literal {activeFrame:{activeArtifactRoots:...}} OR an
  // identifier that flows into contextModifier.
  return /\bactiveFrame\b/.test(snippet) && /\bactiveArtifactRoots\b/.test(snippet)
}

/**
 * Stage M (M8) — call-site-specific helper exemption.
 *
 * Earlier versions of this gate skipped the entire file if any
 * `return attachContractFramePatch(...)` appeared anywhere in the file.
 * Codex's final review pointed out this could mask a separate non-helper
 * violation in the same file. Fix: only exempt the SPECIFIC
 * `createToolExecutionOutput` call site if its captured snippet itself
 * delegates to the trusted helper (e.g. via the helper appearing inside
 * the snippet's own enclosing function body and the snippet's framePatch
 * is bound to the helper's return).
 *
 * Lite check: a call site is exempt only when the snippet itself contains
 * a `return ${helper}(...)` invocation. Whole-file exemption is gone.
 */
function snippetUsesTrustedHelper(snippet) {
  for (const helper of TRUSTED_HELPER_NAMES) {
    const re = new RegExp(`\\b${helper}\\s*\\(`)
    if (re.test(snippet)) return true
  }
  return false
}

function checkNoTypedActionNameAllowlist(violations) {
  let src
  try {
    src = fs.readFileSync(SKILLS_TOOLS_FILE, 'utf8')
  } catch {
    return
  }
  const forbidden = 'VEA_CONTEXT_MUTATING_TOOL_NAMES'
  const index = src.indexOf(forbidden)
  if (index === -1) return
  violations.push({
    file: SKILLS_TOOLS_FILE,
    startLine: src.slice(0, index).split('\n').length,
    endLine: src.slice(0, index).split('\n').length,
    message: `${forbidden} re-introduces a skill-name allowlist for typed-action contextModifier emission.`,
  })
}

function main() {
  const allowlist = loadAllowlist()
  const violations = []
  checkNoTypedActionNameAllowlist(violations)
  for (const file of listFiles(SCAN_ROOT)) {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { continue }
    const src = stripBlockComments(raw)
    // Stage M post-review fix #1 — collect bindings of `framePatch` whose
    // RHS carries `activeArtifactRoots`. The real call sites pass framePatch
    // as a shorthand identifier; without binding-tracing, the gate would
    // miss them. See codex final review (round 2) #1.
    const carriersInFile = collectRootsCarryingFramePatchBindings(src)
    const calls = findCreateOutputCalls(file, src)
    for (const call of calls) {
      const literalCarriesRoots = snippetCarriesFramePatchActiveRoots(call.snippet)
      const identifierCarriesRoots = snippetUsesRootsCarryingIdentifier(call.snippet, carriersInFile)
      if (!literalCarriesRoots && !identifierCarriesRoots) continue

      if (literalCarriesRoots) {
        // Strict mode: when the snippet itself contains the literal
        // `framePatch: { ..., activeArtifactRoots: [...] }`, the contextModifier
        // must ALSO be literal with matching `activeFrame.activeArtifactRoots`.
        // This is the original v8 contract for direct emitters.
        if (snippetCarriesContextModifierRoots(call.snippet)) continue
      } else if (identifierCarriesRoots) {
        // Reference mode: framePatch flows in as a local identifier (built
        // earlier in the function via buildContractFramePatch / buildInspect-
        // FramePatch). At the call site we can verify that the call also
        // passes a `contextModifier` field with a non-null/non-undefined
        // value. Either:
        //   - shorthand `{ framePatch, contextModifier }` (value is the
        //     local of the same name — must itself be non-null at runtime,
        //     but that's the upstream emitter's responsibility), OR
        //   - explicit `contextModifier: <value>` where <value> is NOT the
        //     literals `null` / `undefined` / `void 0`.
        //
        // Codex final review (round 3) #2: previously this accepted
        // `contextModifier: null`, defeating the gate. We now reject.
        const shorthandRe = /\bcontextModifier\s*[,}]/
        const explicitRe = /\bcontextModifier\s*:\s*([^,}\n]+)/
        const shorthandMatch = shorthandRe.exec(call.snippet)
        const explicitMatch = explicitRe.exec(call.snippet)
        if (shorthandMatch) continue
        if (explicitMatch) {
          const valueText = explicitMatch[1].trim()
          // Strip trailing comma/newline residue if any.
          const cleaned = valueText.replace(/[,;\s]+$/, '')
          if (cleaned !== 'null' && cleaned !== 'undefined' && cleaned !== 'void 0') {
            continue
          }
          // explicitly null / undefined → fall through to violation.
        }
      }

      if (isAllowlisted(file, call.startLine, allowlist)) continue
      // Call-site-specific helper exemption (Stage M post-review fix #3):
      // only skip THIS call if the captured snippet itself delegates to the
      // trusted helper. Whole-file exemption was removed.
      if (snippetUsesTrustedHelper(call.snippet)) continue
      violations.push(call)
    }
  }
  if (violations.length === 0) {
    console.log('[check-context-modifier-shape] OK')
    return
  }
  console.error('[check-context-modifier-shape] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(process.cwd(), v.file)}:${v.startLine}-${v.endLine}`)
    if (v.message) {
      console.error(`    ${v.message}`)
    } else {
      console.error(`    framePatch.activeArtifactRoots emitted without matching contextModifier.`)
      console.error('    Either emit `contextModifier: { activeFrame: { activeArtifactRoots: ..., runContract: ... } }`')
      console.error('    in the same call, route through `attachContractFramePatch` (auto-emits the modifier),')
      console.error(`    or add an entry to scripts/check-context-modifier-shape.allowlist.json with a reason.`)
    }
  }
  process.exit(1)
}

main()
