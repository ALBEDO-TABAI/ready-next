#!/usr/bin/env node
/**
 * Stage 6 L4 gate. Asserts that the projection-first continuation contract
 * is enforced at the API boundary, for **both** `restoreContinuationTaskBudgetRuntime`
 * and `resolveTaskExecutionRoute`.
 *
 * Checks:
 *
 *   (A) `restoreContinuationTaskBudgetRuntime` declaration in
 *       `src/main/modules/agent-control/task-projection/run-budget-policy.ts` includes
 *       both `projectionBudget` and `projectionBudgetRuntime` as named
 *       parameter fields.
 *
 *   (B) Every call to `restoreContinuationTaskBudgetRuntime(` in production
 *       code passes a top-level `projectionBudget:` key (depth-1 only — keys
 *       inside nested objects do not satisfy).
 *
 *   (C) `resolveTaskExecutionRoute` declaration in
 *       `src/main/modules/agent-control/task-execution-router.ts` includes
 *       a `continuationContext:` parameter field (the {state, projection}
 *       paired shape per v9), and not the legacy `currentTaskContext:` shape.
 *
 *   (D) Every call to `resolveTaskExecutionRoute(` in production code passes
 *       a top-level `continuationContext:` key (depth-1).
 *
 * The depth-1 walker is a paren+brace token scanner in the same style as
 * Stage 5's `check-sqlite-test-skip-pattern.cjs`. AST is not required.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const HELPER_REL = 'src/main/modules/agent-control/task-projection/run-budget-policy.ts'
const HELPER_PATH = path.join(ROOT, HELPER_REL)
const ROUTER_REL = 'src/main/modules/agent-control/task-execution-router.ts'
const ROUTER_PATH = path.join(ROOT, ROUTER_REL)
const SCAN_DIRS = ['src/main/modules/']

function listFiles(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        stack.push(p)
      } else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) {
        out.push(p)
      }
    }
  }
  return out
}

function relposix(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

/**
 * Walk a call expression starting at `openParenIdx` (the `(` after the function
 * name) and return the slice of source up to (but excluding) the matching `)`.
 * Tracks string/template literals and nested brackets so we don't mistake a
 * `)` inside a string for the closing paren.
 */
function callBodySlice(text, openParenIdx) {
  let i = openParenIdx + 1
  let parens = 1
  let inString = null
  while (i < text.length && parens > 0) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inString) inString = null
      else if (inString === '`' && ch === '$' && text[i + 1] === '{') { i += 2; continue }
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; i++; continue }
    if (ch === '/' && text[i + 1] === '/') {
      // line comment
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '(') parens++
    else if (ch === ')') parens--
    if (parens === 0) break
    i++
  }
  return text.slice(openParenIdx + 1, i)
}

/**
 * Inside an object literal body (text between `{` and `}` at depth 0),
 * extract the set of top-level keys. Skip nested `{...}` / `[...]` / strings.
 */
function topLevelKeysInObject(body) {
  const keys = new Set()
  let i = 0
  let depth = 0
  let inString = null
  let pendingKey = ''
  let lookingForKey = true
  while (i < body.length) {
    const ch = body[i]
    if (inString) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inString) inString = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; i++; continue }
    if (ch === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++
      continue
    }
    if (ch === '/' && body[i + 1] === '*') {
      i += 2
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    if (depth === 0) {
      if (lookingForKey) {
        if (/[a-zA-Z0-9_$]/.test(ch)) pendingKey += ch
        else if (ch === ':' && pendingKey) {
          keys.add(pendingKey)
          pendingKey = ''
          lookingForKey = false
        } else if (/[\s,]/.test(ch)) {
          // continue
        } else {
          // Unexpected token — reset key buffer on hard breaks
          pendingKey = ''
        }
      } else if (ch === ',') {
        lookingForKey = true
        pendingKey = ''
      }
    }
    i++
  }
  return keys
}

/**
 * For a `restoreContinuationTaskBudgetRuntime(` call, return the top-level
 * object-literal keys passed as the single argument, or null if the call
 * doesn't take an inline object literal (rare; treat as violation).
 */
function callObjectLiteralKeys(text, openParenIdx) {
  const body = callBodySlice(text, openParenIdx)
  // Find the first `{` at depth 0 and its matching `}`.
  let i = 0
  let inString = null
  while (i < body.length) {
    const ch = body[i]
    if (inString) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inString) inString = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; i++; continue }
    if (ch === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++
      continue
    }
    if (ch === '/' && body[i + 1] === '*') {
      i += 2
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '{') {
      // Find matching `}`
      let depth = 1
      let j = i + 1
      let s = null
      while (j < body.length && depth > 0) {
        const c = body[j]
        if (s) {
          if (c === '\\') { j += 2; continue }
          if (c === s) s = null
          j++
          continue
        }
        if (c === "'" || c === '"' || c === '`') { s = c; j++; continue }
        if (c === '{') depth++
        else if (c === '}') depth--
        if (depth === 0) break
        j++
      }
      const inner = body.slice(i + 1, j)
      return topLevelKeysInObject(inner)
    }
    i++
  }
  return null
}

/**
 * Find the inline object literal value of a top-level `<keyName>:` inside the
 * call body following `openParenIdx`, then return its top-level keys. If the
 * value isn't an inline literal (e.g. it's a variable, null, undefined,
 * spread, or function call), return null — the gate doesn't enforce inner
 * shape on those because TypeScript already type-checks them at the call.
 */
function innerObjectLiteralKeys(text, openParenIdx, keyName) {
  const body = callBodySlice(text, openParenIdx)
  // Locate `<keyName>:` at top depth-0.
  const re = new RegExp(`(^|[\\s,(])${keyName}\\s*:`, 'm')
  let depth = 0
  let inString = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue }
    if (ch === '/' && body[i + 1] === '*') { i += 2; while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++; i += 2; continue }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    if (depth === 1) {
      // depth 1 == inside the outer object literal (which is depth 1 from
      // the call paren's perspective at depth 0). Match the keyword.
      const tail = body.slice(i)
      const m = re.exec(tail)
      if (m && tail.startsWith(m[0])) {
        // skip past the colon
        let j = i + m[0].length
        while (j < body.length && /\s/.test(body[j])) j++
        if (body[j] !== '{') return null  // value isn't an inline literal
        // Walk the matching `}`
        let inner = ''
        let d = 1
        let s = null
        let k = j + 1
        while (k < body.length && d > 0) {
          const c = body[k]
          if (s) {
            if (c === '\\') { k += 2; continue }
            if (c === s) s = null
            inner += c
            k++
            continue
          }
          if (c === "'" || c === '"' || c === '`') { s = c; inner += c; k++; continue }
          if (c === '{') d++
          else if (c === '}') d--
          if (d === 0) break
          inner += c
          k++
        }
        return topLevelKeysInObject(inner)
      }
    }
  }
  return null
}

function main() {
  const violations = []

  // Rule (A): declaration must include both new fields
  if (!fs.existsSync(HELPER_PATH)) {
    violations.push({ file: HELPER_REL, line: 0, kind: 'helper_missing', detail: 'helper file does not exist' })
  } else {
    const helperText = fs.readFileSync(HELPER_PATH, 'utf8')
    if (!/projectionBudget\s*:\s*TaskBudget\s*\|\s*null\b/.test(helperText)) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'declaration_missing_field', detail: 'projectionBudget required field not declared' })
    }
    if (!/projectionBudgetRuntime\s*:\s*TaskBudgetRuntime\s*\|\s*null\b/.test(helperText)) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'declaration_missing_field', detail: 'projectionBudgetRuntime required field not declared' })
    }
  }

  // Rule (C): resolveTaskExecutionRoute declaration must include continuationContext
  // and must NOT carry the legacy currentTaskContext name.
  if (!fs.existsSync(ROUTER_PATH)) {
    violations.push({ file: ROUTER_REL, line: 0, kind: 'router_missing', detail: 'router file does not exist' })
  } else {
    const routerText = fs.readFileSync(ROUTER_PATH, 'utf8')
    if (!/continuationContext\s*:\s*\{[^}]*\bstate\b[^}]*\bprojection\b/s.test(routerText)) {
      violations.push({ file: ROUTER_REL, line: 0, kind: 'router_declaration_missing', detail: 'resolveTaskExecutionRoute must declare continuationContext: { state, projection } | null' })
    }
    if (/\bcurrentTaskContext\s*[?]?\s*:/.test(routerText)) {
      violations.push({ file: ROUTER_REL, line: 0, kind: 'router_legacy_field', detail: 'resolveTaskExecutionRoute still declares legacy currentTaskContext field' })
    }
  }

  // Rule (B): every call to restoreContinuationTaskBudgetRuntime passes top-level projectionBudget
  // Rule (D): every call to resolveTaskExecutionRoute passes top-level continuationContext.
  //          When that value is an object literal (not null/variable), the literal's keys
  //          must include both `state` and `projection` (paired-shape contract).
  const callConfigs = [
    { fn: 'restoreContinuationTaskBudgetRuntime', requiredKey: 'projectionBudget', allowOwnFile: HELPER_REL },
    { fn: 'resolveTaskExecutionRoute', requiredKey: 'continuationContext', allowOwnFile: ROUTER_REL, innerPair: ['state', 'projection'] },
  ]

  for (const dirRel of SCAN_DIRS) {
    const dir = path.join(ROOT, dirRel)
    if (!fs.existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      const rel = relposix(file)
      if (rel.includes('/__tests__/')) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const cfg of callConfigs) {
        if (rel === cfg.allowOwnFile) continue  // declaration site allowed
        if (!text.includes(cfg.fn)) continue
        const callRe = new RegExp(`\\b${cfg.fn}\\s*\\(`, 'g')
        let m
        while ((m = callRe.exec(text))) {
          const openParen = m.index + m[0].length - 1
          const keys = callObjectLiteralKeys(text, openParen)
          if (!keys) {
            violations.push({
              file: rel,
              line: lineOf(text, m.index),
              kind: 'call_missing_object_literal',
              detail: `${cfg.fn} call does not pass an inline object literal`,
            })
            continue
          }
          if (!keys.has(cfg.requiredKey)) {
            violations.push({
              file: rel,
              line: lineOf(text, m.index),
              kind: `call_missing_${cfg.requiredKey.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
              detail: `top-level ${cfg.requiredKey} key not present in ${cfg.fn}(...) call`,
            })
            continue
          }
          // Inner-pair check (rule D's tighter half): if the value passed for
          // `requiredKey` is itself an inline object literal, its top-level
          // keys must include every entry in `innerPair`. This catches a
          // call that says `continuationContext: { state }` (missing projection)
          // or vice versa. We don't enforce when the value is a variable (e.g.
          // `continuationContext: ctx`) — TS already enforces the type there.
          if (cfg.innerPair && cfg.innerPair.length > 0) {
            const innerKeys = innerObjectLiteralKeys(text, openParen, cfg.requiredKey)
            if (innerKeys && !cfg.innerPair.every((k) => innerKeys.has(k))) {
              const missing = cfg.innerPair.filter((k) => !innerKeys.has(k))
              violations.push({
                file: rel,
                line: lineOf(text, m.index),
                kind: `${cfg.requiredKey}_inner_pair_incomplete`,
                detail: `${cfg.fn}(...) call passes ${cfg.requiredKey}: { ... } missing required key(s): ${missing.join(', ')}`,
              })
            }
          }
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('check-continuation-context-shape: ok')
    return
  }
  console.error('check-continuation-context-shape: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
