#!/usr/bin/env node
/**
 * Stage 6 deferred gate. run_state.json reads in task-projection/skill
 * runtime code must go through run-state-schema.ts instead of ad-hoc
 * JSON.parse(readFileSync(...)).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SCAN_RELS = [
  'src/main/modules/agent-control/task-projection',
  'src/main/modules/agent-control/skills/skill-running-projection.ts',
  'src/main/modules/agent-control/skills/skill-task-tracker.ts',
  'src/main/modules/agent-control/skills/skill-task-supervisor.ts',
  'src/main/modules/agent-control/skills/skill-child-runner.ts',
  'src/main/modules/agent-control/skills/skill-child-sub-agent.ts',
]
const SCHEMA_REL = 'src/main/modules/agent-control/task-projection/run-state-schema.ts'

function listFiles(abs) {
  const out = []
  if (!fs.existsSync(abs)) return out
  const stat = fs.statSync(abs)
  if (stat.isFile()) return [abs]
  const stack = [abs]
  while (stack.length) {
    const cur = stack.pop()
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(p)
    }
  }
  return out
}

function relposix(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function main() {
  const violations = []
  const schemaAbs = path.join(ROOT, SCHEMA_REL)
  if (!fs.existsSync(schemaAbs)) {
    violations.push({ file: SCHEMA_REL, line: 0, kind: 'schema_missing', detail: 'run-state-schema.ts does not exist' })
  } else {
    const schemaText = fs.readFileSync(schemaAbs, 'utf8')
    if (!/export\s+function\s+parseRunStateJson\s*\(/.test(schemaText)) {
      violations.push({ file: SCHEMA_REL, line: 0, kind: 'parser_missing', detail: 'parseRunStateJson is not exported' })
    }
    if (!/export\s+function\s+validateRunStateRecord\s*\(/.test(schemaText)) {
      violations.push({ file: SCHEMA_REL, line: 0, kind: 'validator_missing', detail: 'validateRunStateRecord is not exported' })
    }
  }

  for (const rel of SCAN_RELS) {
    for (const file of listFiles(path.join(ROOT, rel))) {
      const fileRel = relposix(file)
      if (fileRel === SCHEMA_REL) continue
      if (fileRel.includes('/__tests__/')) continue
      const text = fs.readFileSync(file, 'utf8')
      const re = /JSON\.parse\s*\(\s*readFileSync\s*\(/g
      let match
      while ((match = re.exec(text))) {
        const start = Math.max(0, match.index - 240)
        const end = Math.min(text.length, match.index + 240)
        const window = text.slice(start, end)
        if (!/runState|run_state|RUN_STATE/.test(window)) continue
        violations.push({
          file: fileRel,
          line: lineOf(text, match.index),
          kind: 'direct_run_state_json_parse',
          detail: 'run_state.json reads must go through run-state-schema.ts',
        })
      }
    }
  }

  if (violations.length === 0) {
    console.log('check-run-state-schema-single-source: ok')
    return
  }
  console.error('check-run-state-schema-single-source: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
