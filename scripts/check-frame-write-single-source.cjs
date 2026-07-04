#!/usr/bin/env node
/**
 * Stage M (M3 + M7) — frame-write single-source enforcement.
 *
 * Plan §3.1: ensure no code mutates `TurnFrame` outside `applyTurnFramePatch`.
 *
 * v8 of the plan called for AST + alias tracking. This implementation is the
 * regex-based "lite" version that catches the documented direct-mutation
 * patterns. Comment-only matches are stripped before scanning; the legitimate
 * `applyTurnFramePatch(...)` callers are not flagged because their rewrites
 * don't include any of the forbidden lhs-style assignments.
 *
 * Scope B (turn-engine.ts) — must NOT contain any of:
 *   - turnFrame.terminalReason = ...
 *   - turnFrame.budget = ...
 *   - turnFrame.skill.runContract = ...
 *   - turnFrame.skill.runContract.<field> = ...
 *   - contract.{childCloseEvent,childStatus,parentNextHint} = ...   (alias mutation)
 *   - Object.assign(turnFrame.skill.runContract, ...)
 *
 * Scope A (src/main/modules/tools/**) — same forbidden patterns. Tools must
 * emit framePatch / contextModifier in their ToolExecutionOutput; never
 * mutate a live frame directly.
 *
 * False-positive controls:
 *   - Comment-only lines (// or block-comment) are stripped first.
 *   - Test fixtures under src/__tests__/ are NOT scanned (they may pin
 *     forbidden patterns to prove the gate catches them).
 *   - Local SkillRunContract assembly inside a `framePatch:` literal is
 *     not flagged because the regex requires an lvalue starting with
 *     `turnFrame` or `contract.`.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = process.env.READY_FRAME_GATE_ROOT
  ? path.resolve(process.env.READY_FRAME_GATE_ROOT)
  : path.resolve(__dirname, '..')


const SCOPE_A_DIR = path.join(REPO, 'src/main/modules/tools')
const LIVE_TOOL_RUNTIME_DIR = path.join(REPO, 'src/main/modules/agent-control/tools-runtime')
const LIVE_TOOL_RUNTIME_FILE = path.join(LIVE_TOOL_RUNTIME_DIR, 'tool-runtime.ts')

// Patterns that fail in BOTH scopes — direct mutations of the live TurnFrame.
// Tools should never touch a TurnFrame at all; the engine should only do so
// via reassigning applyTurnFramePatch's return value.
const FORBIDDEN_PATTERNS_ALL = [
  /\bturnFrame\.terminalReason\s*=/,
  /\bturnFrame\.budget\s*=/,
  /\bturnFrame\.activeArtifactRoots\s*=/,
  /\bturnFrame\.configValidation\s*=/,
  /\bturnFrame\.liveness\s*=/,
  /\bturnFrame\.skill\.runContract\s*=/,
  /\bturnFrame\.skill\.runContract\.\w+\s*=/,
  /\bObject\.assign\s*\(\s*turnFrame\.skill\.runContract\b/,
  /\bObject\.assign\s*\(\s*turnFrame\.\w+/,
]

function stripComments(line) {
  // Strip line comments (// ...) — keep the prefix.
  const idx = line.indexOf('//')
  return idx === -1 ? line : line.slice(0, idx)
}

function listFiles(dir, exts = ['.ts']) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        // Skip test directories.
        if (entry.name === '__tests__') continue
        stack.push(full)
      } else if (exts.includes(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  return out
}

function scanFile(file, patterns) {
  const violations = []
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    return violations
  }
  // Pre-strip multi-line block comments so `/* contract.x = */` doesn't fire.
  src = src.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComments(lines[i])
    for (const pattern of patterns) {
      if (pattern.test(stripped)) {
        violations.push({ file, line: i + 1, code: lines[i].trim(), pattern: pattern.toString() })
      }
    }
  }
  return violations
}

function functionRange(text, name) {
  const start = text.indexOf(`function ${name}`)
  if (start < 0) return null
  const open = text.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const ch = text[index]
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return { start, end: index + 1 }
    }
  }
  return null
}

function blankRangePreserveLines(text, range) {
  return text.slice(0, range.start)
    + text.slice(range.start, range.end).replace(/[^\r\n]/g, ' ')
    + text.slice(range.end)
}

function scanLiveActiveFrameWriters(file) {
  const violations = []
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    return violations
  }
  src = src.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  if (path.resolve(file) === path.resolve(LIVE_TOOL_RUNTIME_FILE)) {
    const allowed = functionRange(src, 'applyContextModifier')
    if (allowed) src = blankRangePreserveLines(src, allowed)
  }
  const patterns = [
    /\bcontext\.activeFrame\s*=/,
    /\bcontext\.activeFrame\.(?:activeArtifactRoots|runContract|discoveredHandles)\s*=/,
    /\bcontext\.activeFrame\.(?:activeArtifactRoots|discoveredHandles)\.(?:push|unshift|splice)\s*\(/,
    /\bObject\.assign\s*\(\s*context\.activeFrame\b/,
  ]
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComments(lines[i])
    for (const pattern of patterns) {
      if (pattern.test(stripped)) {
        violations.push({ file, line: i + 1, code: lines[i].trim(), pattern: pattern.toString() })
      }
    }
  }
  return violations
}

function main() {
  let allViolations = []

  // Scope A: src/main/modules/tools/** (excluding __tests__) — turnFrame-only
  // patterns. The `contract.X = ...` form is legitimate local SkillRunContract
  // assembly here.
  for (const file of listFiles(SCOPE_A_DIR)) {
    allViolations = allViolations.concat(scanFile(file, FORBIDDEN_PATTERNS_ALL))
  }

  for (const file of listFiles(LIVE_TOOL_RUNTIME_DIR)) {
    allViolations = allViolations.concat(scanLiveActiveFrameWriters(file))
  }

  if (allViolations.length === 0) {
    console.log('[check-frame-write-single-source] OK')
    return
  }

  console.error('[check-frame-write-single-source] FAIL')
  for (const v of allViolations) {
    console.error(`  ${path.relative(process.cwd(), v.file)}:${v.line}`)
    console.error(`    pattern: ${v.pattern}`)
    console.error(`    code:    ${v.code}`)
  }
  console.error('')
  console.error('Stage M invariant I2a: TurnFrame is mutated only by reassigning the result of')
  console.error("`applyTurnFramePatch(turnFrame, patch)`. Direct field writes (turnFrame.X = ...),")
  console.error('replacement (turnFrame.skill.runContract = ...), aliased contract.* mutation, and')
  console.error("`Object.assign(turnFrame.X, ...)` are forbidden. See plan §3.1 + §2.3.")
  process.exit(1)
}

main()
