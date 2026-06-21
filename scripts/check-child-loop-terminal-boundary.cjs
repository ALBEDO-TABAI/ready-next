#!/usr/bin/env node
/**
 * P1c / C17 child-loop terminal boundary gate.
 *
 * Child-loop terminal projection records are an independent child state
 * machine, but their write boundary still needs to be machine-checkable.
 * This gate keeps construction and finished scope-run publication inside the
 * small set of child-runner close methods.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_ROOT = process.cwd()
const CHILD_RUNNER_REL = 'src/main/modules/agent-control/skills/skill-child-runner.ts'
const SCAN_DIR_REL = 'src/main/modules'

const ALLOWED_BUILD_CALLERS = new Set([
  'publishScopeRunClose',
  'upsertChildTaskProjection',
  'publishInactiveChildRunClose',
  'updateInactiveChildRunProjectionSiblings',
])

const ALLOWED_FINISHED_EVENT_CALLERS = new Set([
  'publishScopeRunClose',
])

function relposix(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function listFiles(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
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

function findMatchingBrace(text, openIdx) {
  let depth = 0
  let state = 'code'
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === 'line_comment') {
      if (ch === '\n') state = 'code'
      continue
    }
    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        i += 1
        state = 'code'
      }
      continue
    }
    if (state === 'single_quote') {
      if (ch === '\\') {
        i += 1
      } else if (ch === "'") {
        state = 'code'
      }
      continue
    }
    if (state === 'double_quote') {
      if (ch === '\\') {
        i += 1
      } else if (ch === '"') {
        state = 'code'
      }
      continue
    }
    if (state === 'template') {
      if (ch === '\\') {
        i += 1
      } else if (ch === '`') {
        state = 'code'
      }
      continue
    }

    if (ch === '/' && next === '/') {
      i += 1
      state = 'line_comment'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 1
      state = 'block_comment'
      continue
    }
    if (ch === "'") {
      state = 'single_quote'
      continue
    }
    if (ch === '"') {
      state = 'double_quote'
      continue
    }
    if (ch === '`') {
      state = 'template'
      continue
    }
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function findMatchingParen(text, openIdx) {
  let depth = 0
  let state = 'code'
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === 'line_comment') {
      if (ch === '\n') state = 'code'
      continue
    }
    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        i += 1
        state = 'code'
      }
      continue
    }
    if (state === 'single_quote') {
      if (ch === '\\') {
        i += 1
      } else if (ch === "'") {
        state = 'code'
      }
      continue
    }
    if (state === 'double_quote') {
      if (ch === '\\') {
        i += 1
      } else if (ch === '"') {
        state = 'code'
      }
      continue
    }
    if (state === 'template') {
      if (ch === '\\') {
        i += 1
      } else if (ch === '`') {
        state = 'code'
      }
      continue
    }

    if (ch === '/' && next === '/') {
      i += 1
      state = 'line_comment'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 1
      state = 'block_comment'
      continue
    }
    if (ch === "'") {
      state = 'single_quote'
      continue
    }
    if (ch === '"') {
      state = 'double_quote'
      continue
    }
    if (ch === '`') {
      state = 'template'
      continue
    }
    if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function findNamedBlock(text, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:(?:private|public|protected)\\s+)?(?:async\\s+)?(?:function\\s+)?${escapeRegExp(name)}\\s*\\(`, 'g')
  const match = re.exec(text)
  if (!match) return null
  const paren = text.indexOf('(', match.index)
  const closeParen = paren >= 0 ? findMatchingParen(text, paren) : -1
  if (closeParen < 0) return null
  const open = text.indexOf('{', closeParen)
  if (open < 0) return null
  const close = findMatchingBrace(text, open)
  if (close < 0) return null
  return {
    name,
    start: match.index,
    open,
    close,
    body: text.slice(open + 1, close),
  }
}

function containingBlock(blocks, idx) {
  return blocks.find((block) => idx >= block.start && idx <= block.close) || null
}

function push(violations, file, line, kind, detail) {
  violations.push({ file, line, kind, detail })
}

function checkChildRunnerSource(root, violations) {
  const rel = CHILD_RUNNER_REL
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) {
    push(violations, rel, 0, 'source_missing', 'skill-child-runner.ts is missing')
    return
  }
  const text = fs.readFileSync(file, 'utf8')
  const blockNames = [
    'publishScopeRunClose',
    'upsertChildTaskProjection',
    'publishInactiveChildRunClose',
    'updateInactiveChildRunProjectionSiblings',
    'buildChildTaskProjectionRecord',
    'childProjectionStatusForState',
    'persistTerminalClose',
  ]
  const blocks = blockNames.map((name) => findNamedBlock(text, name)).filter(Boolean)
  for (const required of ['publishScopeRunClose', 'upsertChildTaskProjection', 'publishInactiveChildRunClose', 'updateInactiveChildRunProjectionSiblings', 'buildChildTaskProjectionRecord']) {
    if (!blocks.some((block) => block.name === required)) {
      push(violations, rel, 0, 'required_boundary_missing', `${required} block not found`)
    }
  }

  const buildRe = /\bbuildChildTaskProjectionRecord\s*\(/g
  let match
  while ((match = buildRe.exec(text))) {
    const block = containingBlock(blocks, match.index)
    if (block?.name === 'buildChildTaskProjectionRecord') continue
    if (!block || !ALLOWED_BUILD_CALLERS.has(block.name)) {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'child_projection_builder_outside_boundary',
        `buildChildTaskProjectionRecord may only be called from ${Array.from(ALLOWED_BUILD_CALLERS).join(', ')}`,
      )
    }
  }

  const finishedRe = /\btype\s*:\s*['"]finished['"]/g
  while ((match = finishedRe.exec(text))) {
    const block = containingBlock(blocks, match.index)
    if (!block || !ALLOWED_FINISHED_EVENT_CALLERS.has(block.name)) {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'finished_event_outside_boundary',
        'finished scope-run events must be published only by publishScopeRunClose',
      )
    }
  }

  const terminalStatusRe = /\bstatus\s*:\s*['"](?:completed|failed|killed)['"]/g
  const callRe = /\.\s*(?:update|create)\s*\(/g
  while ((match = callRe.exec(text))) {
    const open = text.indexOf('(', match.index)
    const close = open >= 0 ? findMatchingParen(text, open) : -1
    if (open < 0 || close < 0) continue
    const callText = text.slice(open, close + 1)
    if (!terminalStatusRe.test(callText)) {
      terminalStatusRe.lastIndex = 0
      continue
    }
    terminalStatusRe.lastIndex = 0
    if (callText.includes('buildChildTaskProjectionRecord(')) continue
    push(
      violations,
      rel,
      lineOf(text, match.index),
      'direct_terminal_projection_write',
      'direct terminal projection status writes must route through buildChildTaskProjectionRecord',
    )
  }

  const siblingCallRe = /\bupdateInactiveChildRunProjectionSiblings\s*\(/g
  while ((match = siblingCallRe.exec(text))) {
    const block = containingBlock(blocks, match.index)
    if (block?.name === 'updateInactiveChildRunProjectionSiblings') continue
    if (block?.name !== 'publishInactiveChildRunClose') {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'sibling_projection_sync_outside_inactive_close',
        'updateInactiveChildRunProjectionSiblings must only be called from publishInactiveChildRunClose',
      )
    }
  }
}

function checkOtherProductionFiles(root, violations) {
  const scanDir = path.join(root, SCAN_DIR_REL)
  if (!fs.existsSync(scanDir)) return
  const callRe = /\.\s*(?:update|create)\s*\(/g
  const terminalStatusRe = /\bstatus\s*:\s*['"](?:completed|failed|killed)['"]/g
  for (const file of listFiles(scanDir)) {
    const rel = relposix(root, file)
    if (rel === CHILD_RUNNER_REL) continue
    if (rel.includes('/__tests__/')) continue
    if (rel.includes('/scripts/') || rel.includes('/snapshots/')) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('skill-child:') && !text.includes('childRunId')) continue
    let match
    while ((match = callRe.exec(text))) {
      const open = text.indexOf('(', match.index)
      const close = open >= 0 ? findMatchingParen(text, open) : -1
      if (open < 0 || close < 0) continue
      const callText = text.slice(open, close + 1)
      if (!terminalStatusRe.test(callText)) {
        terminalStatusRe.lastIndex = 0
        continue
      }
      terminalStatusRe.lastIndex = 0
      if (!callText.includes('skill-child:') && !callText.includes('childRunId')) continue
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'external_child_terminal_projection_write',
        'child projection terminal writes must stay inside skill-child-runner boundary',
      )
    }
  }
}

function checkChildLoopTerminalBoundary(options = {}) {
  const root = options.root || DEFAULT_ROOT
  const violations = []
  checkChildRunnerSource(root, violations)
  checkOtherProductionFiles(root, violations)
  return { ok: violations.length === 0, violations }
}

function main() {
  const result = checkChildLoopTerminalBoundary()
  if (result.ok) {
    console.log('check-child-loop-terminal-boundary: ok')
    return
  }
  console.error('check-child-loop-terminal-boundary: violations:')
  for (const violation of result.violations) {
    console.error(`  ${violation.file}:${violation.line} [${violation.kind}] ${violation.detail}`)
  }
  process.exit(1)
}

if (require.main === module) {
  main()
}

module.exports = {
  checkChildLoopTerminalBoundary,
}
