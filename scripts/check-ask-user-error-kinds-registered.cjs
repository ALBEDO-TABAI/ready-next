#!/usr/bin/env node
/**
 * Stage U (PR 1) — every `errorKind` string literal that the ask_user_questions
 * IPC handlers / pure core / renderer can surface MUST be registered in
 * `src/main/modules/agent-control/error-kinds.ts` under `ASK_USER_ERROR_KINDS`.
 * Each registered entry must also EITHER reference a metric name from
 * `TOOL_ERROR_METRICS` OR carry `noMetric: true`.
 *
 * Why: this is the "code wrote an errorKind that nobody documented" guard.
 * If a new path returns `errorKind: 'foo'` but `foo` isn't in the registry,
 * the renderer error-handling logic has no way to map it to UX behavior and
 * the metric layer silently drops the diagnostic.
 *
 * Inputs scanned:
 *   - src/main/modules/tools/builtins/ask-user-questions.ts (pure core)
 *   - src/main/modules/claude-bridge/ipc-handler.ts (IPC thin wrapper —
 *     only the agent:askUserQuestions:* handlers; restricted via heuristic
 *     comment scan).
 *   - src/renderer/stores/useAgent.ts (`foldCardLocallyToCancelled` callers
 *     pass cancelReason values that mirror errorKinds for cross-process
 *     consistency — we only check `errorKind:` string literals there).
 *
 * Outputs:
 *   - exit 0 on clean
 *   - exit 1 on violation with per-line context
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const ERROR_KINDS_FILE = 'src/main/modules/agent-control/error-kinds.ts'
const TOOL_ERROR_METRICS_FILE = 'src/main/modules/agent-control/tool-error-metrics.ts'

// ask-user-questions.ts is the pure core — IPC handler delegates everything
// to it, so this single file owns every ask-user errorKind production site.
// The renderer's useAgent.ts CONSUMES errorKinds (via `=== '...'`) but it
// doesn't define new ones — `cancelHeadlineFromReason` etc. are about
// cancelReason values, which are scoped to the renderer's UI mapping.
const SCAN_FILES = [
  'src/main/modules/tools/builtins/ask-user-questions.ts',
]

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

// Extract `errorKind: '<value>'` literals from a TS source. Skips ones inside
// `//` line comments and `/* ... */` block comments to avoid false positives.
function extractErrorKindLiterals(src) {
  const out = []
  // Strip block comments first
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '')
  // Strip line comments (cheap heuristic — does NOT understand strings, but
  // sufficient here since errorKind literals never contain `//`)
  const noLine = noBlock.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
  const re = /errorKind\s*:\s*['"]([a-z][a-z0-9_]+)['"]/g
  let m
  while ((m = re.exec(noLine)) !== null) {
    out.push(m[1])
  }
  return out
}

function extractRegisteredErrorKinds(src) {
  // ASK_USER_ERROR_KINDS = { foo: { code: 'foo', ...}, bar: { code: 'bar', ... } }
  // Extract each `code: 'X'` literal that appears within the ASK_USER_ERROR_KINDS
  // object (heuristic: any `code: '<...>'` literal in the file. Acceptable
  // because file scope is dedicated to the registry.)
  const entries = []
  const re = /code:\s*['"]([a-z][a-z0-9_]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) entries.push(m[1])
  return entries
}

function extractMetricEntries(src) {
  // Each entry shape: `<key>: '<snake_case_metric>',` — capture the value.
  const out = new Set()
  const re = /['"]([a-z][a-z0-9_]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

function extractErrorKindMappings(src) {
  // Brace-counted parser. For each `<name>: {` opening inside
  // `ASK_USER_ERROR_KINDS = { ... }`, find its matching `}` and inspect the
  // object body for `code: 'X'`, `metricName: 'Y'?`, `noMetric: true?`.
  const startMatch = src.match(/ASK_USER_ERROR_KINDS\s*=\s*\{/)
  if (!startMatch) return []
  const startIdx = startMatch.index + startMatch[0].length
  const entries = []

  let i = startIdx
  while (i < src.length) {
    // Skip whitespace and comments
    while (i < src.length) {
      const ch = src[i]
      if (/\s/.test(ch)) { i += 1; continue }
      if (src.slice(i, i + 2) === '//') {
        const nl = src.indexOf('\n', i)
        i = nl === -1 ? src.length : nl + 1
        continue
      }
      if (src.slice(i, i + 2) === '/*') {
        const close = src.indexOf('*/', i + 2)
        i = close === -1 ? src.length : close + 2
        continue
      }
      break
    }
    if (i >= src.length || src[i] === '}') break
    // Now we should be at `<name>:`
    const nameMatch = src.slice(i).match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\{/)
    if (!nameMatch) {
      // Move forward one char to avoid infinite loop on unexpected input.
      i += 1
      continue
    }
    const bodyStart = i + nameMatch[0].length
    // Brace-count to find matching close
    let depth = 1
    let j = bodyStart
    while (j < src.length && depth > 0) {
      const ch = src[j]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      j += 1
    }
    const block = src.slice(bodyStart, j - 1)
    const codeMatch = block.match(/code:\s*['"]([a-z][a-z0-9_]+)['"]/)
    const metricMatch = block.match(/metricName:\s*['"]([a-z][a-z0-9_]+)['"]/)
    const noMetricMatch = /noMetric:\s*true/.test(block)
    if (codeMatch) {
      entries.push({
        code: codeMatch[1],
        metricName: metricMatch ? metricMatch[1] : null,
        noMetric: noMetricMatch,
      })
    }
    i = j
    // After closing `}`, skip optional comma + whitespace
    while (i < src.length && (src[i] === ',' || /\s/.test(src[i]))) i += 1
  }
  return entries
}

function main() {
  const violations = []

  const registrySrc = read(ERROR_KINDS_FILE)
  if (!registrySrc) {
    console.error(`MISSING REGISTRY: ${ERROR_KINDS_FILE}`)
    process.exit(1)
  }
  const registeredCodes = new Set(extractRegisteredErrorKinds(registrySrc))

  const metricsSrc = read(TOOL_ERROR_METRICS_FILE)
  if (!metricsSrc) {
    console.error(`MISSING METRIC REGISTRY: ${TOOL_ERROR_METRICS_FILE}`)
    process.exit(1)
  }
  const registeredMetrics = extractMetricEntries(metricsSrc)

  // Step 1: every errorKind literal in the scanned source files must be in
  // ASK_USER_ERROR_KINDS (or be one of the well-known provider/non-domain
  // ones intentionally not in this registry).
  // PR 3 will extend this with PROVIDER_ERROR_KINDS; for now we exempt the
  // provider kinds that the plan reserves.
  const ALLOWED_UNREGISTERED = new Set([
    // PR 3 will register these — for now they're scaffolded but not yet
    // emitted from the scanned files, so this exemption is defensive only.
    'provider_request_failed',
    'provider_thinking_echo_required',
    // Pre-existing tool dispatch kinds owned by other contracts:
    'tool_handler_failure',
    'tool_restricted_this_turn',
    'tool_not_registered',
    'authorization_denied',
    'aborted', // also covered in ASK_USER_ERROR_KINDS but used elsewhere
    'unknown',
    'host_unavailable',
  ])
  for (const file of SCAN_FILES) {
    const src = read(file)
    if (!src) continue
    const literals = extractErrorKindLiterals(src)
    for (const literal of literals) {
      if (!registeredCodes.has(literal) && !ALLOWED_UNREGISTERED.has(literal)) {
        violations.push({
          file,
          reason: `errorKind literal '${literal}' is not registered in ASK_USER_ERROR_KINDS (or the PR-3 PROVIDER_ERROR_KINDS reserve)`,
        })
      }
    }
  }

  // Step 2: every entry in ASK_USER_ERROR_KINDS must EITHER have a
  // metricName that exists in TOOL_ERROR_METRICS, OR carry noMetric: true.
  // Never both, never neither.
  const mappings = extractErrorKindMappings(registrySrc)
  for (const entry of mappings) {
    if (entry.noMetric && entry.metricName) {
      violations.push({
        file: ERROR_KINDS_FILE,
        reason: `errorKind '${entry.code}' must not declare both metricName and noMetric:true`,
      })
      continue
    }
    if (!entry.noMetric && !entry.metricName) {
      violations.push({
        file: ERROR_KINDS_FILE,
        reason: `errorKind '${entry.code}' must declare either metricName or noMetric:true`,
      })
      continue
    }
    if (entry.metricName && !registeredMetrics.has(entry.metricName)) {
      violations.push({
        file: ERROR_KINDS_FILE,
        reason: `errorKind '${entry.code}' references metricName '${entry.metricName}' but it is not in TOOL_ERROR_METRICS`,
      })
    }
  }

  if (violations.length > 0) {
    console.error('check-ask-user-error-kinds-registered: VIOLATIONS\n')
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.reason}`)
    }
    console.error('\nFix by registering the missing errorKind in error-kinds.ts under ASK_USER_ERROR_KINDS, or adding the missing metricName to TOOL_ERROR_METRICS.')
    process.exit(1)
  }
  console.log('check-ask-user-error-kinds-registered: OK')
}

main()
