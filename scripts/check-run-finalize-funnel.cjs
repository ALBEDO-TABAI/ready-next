#!/usr/bin/env node
/**
 * S1-3 run-finalize funnel gate.
 *
 * Terminal run_meta writes must go through runtime-core/run-finalizer.ts.
 * Terminal projection patch construction must also live in that finalizer; other
 * modules may import and apply the constructor, but must not build the terminal
 * object locally.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_FINALIZER_REL = 'src/main/modules/agent-control/runtime-core/run-finalizer.ts'
const RUN_META_REPOSITORY_REL = 'src/main/modules/agent-control/task-projection/run-meta-repository.ts'
const SCAN_DIRS = [
  'src/main/modules/agent-control/',
  'src/main/modules/claude-bridge/',
]

const TERMINAL_RUN_META_STATUSES = [
  'done',
  'error',
  'cancelled',
  'preempted',
  'interrupted',
  'checkpoint',
  'completed',
  'failed',
  'killed',
]
const TERMINAL_STATUS_ALT = TERMINAL_RUN_META_STATUSES.join('|')

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

function relposix(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function isAllowedRunMetaWriter(rel) {
  return rel === RUN_FINALIZER_REL || rel === RUN_META_REPOSITORY_REL
}

function isAllowedProjectionPatchConstructor(rel) {
  return rel === RUN_FINALIZER_REL
}

function pushRegexViolations(violations, rel, text, rules) {
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`)
    let m
    while ((m = re.exec(text))) {
      violations.push({
        file: rel,
        line: lineOf(text, m.index),
        kind: rule.kind,
        detail: rule.detail,
      })
    }
  }
}

function main() {
  const violations = []
  const files = []
  for (const dirRel of SCAN_DIRS) {
    const dir = path.join(ROOT, dirRel)
    if (!fs.existsSync(dir)) continue
    files.push(...listFiles(dir))
  }

  const runMetaRules = [
    {
      kind: 'run_meta_terminal_update',
      detail: 'terminal run_meta update must be routed through run-finalizer.ts',
      re: new RegExp(`\\brunMeta(?:Repository|Repo)?\\.update\\s*\\([^,]+,\\s*\\{[\\s\\S]{0,900}?\\bstatus\\s*:\\s*['"](?:${TERMINAL_STATUS_ALT})['"]`, 'g'),
    },
    {
      kind: 'run_meta_terminal_create',
      detail: 'terminal run_meta create must be routed through run-finalizer.ts',
      re: new RegExp(`\\brunMeta(?:Repository|Repo)?\\.create\\s*\\(\\s*\\{[\\s\\S]{0,900}?\\bstatus\\s*:\\s*['"](?:${TERMINAL_STATUS_ALT})['"]`, 'g'),
    },
    {
      kind: 'run_meta_terminal_sql',
      detail: 'direct run_meta SQL with status writes must stay behind the repository/finalizer funnel',
      re: /\b(?:INSERT\s+INTO|UPDATE)\s+run_meta\b[\s\S]{0,700}\bstatus\b/gi,
    },
  ]

  const projectionPatchRules = [
    {
      kind: 'terminal_projection_patch_constructor',
      detail: 'terminal projection patch constructors may only be defined in run-finalizer.ts',
      re: /\b(?:export\s+)?function\s+buildTerminalProjectionPatch\s*\(/g,
    },
    {
      kind: 'terminal_projection_patch_constructor',
      detail: 'terminal projection patch constructors may only be defined in run-finalizer.ts',
      re: /\b(?:const|let|var)\s+buildTerminalProjectionPatch\s*=/g,
    },
    {
      kind: 'terminal_projection_patch_literal',
      detail: 'sibling takeover terminal projection patches must be constructed by run-finalizer.ts',
      re: /status\s*:\s*['"]killed['"][\s\S]{0,700}?(?:taskSummary|blockedReason)\s*:\s*['"]已被新消息接管['"]/g,
    },
    {
      kind: 'terminal_projection_patch_literal',
      detail: 'superseded continuation terminal patches must be constructed by run-finalizer.ts',
      re: /blockerType\s*:\s*['"]superseded['"]/g,
    },
  ]

  for (const file of files) {
    const rel = relposix(file)
    const text = fs.readFileSync(file, 'utf8')
    if (!isAllowedRunMetaWriter(rel)) {
      pushRegexViolations(violations, rel, text, runMetaRules)
    }
    if (!isAllowedProjectionPatchConstructor(rel)) {
      pushRegexViolations(violations, rel, text, projectionPatchRules)
    }
  }

  if (violations.length === 0) {
    console.log('check-run-finalize-funnel: ok')
    return
  }

  console.error('check-run-finalize-funnel: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
