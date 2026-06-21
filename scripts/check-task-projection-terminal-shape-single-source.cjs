#!/usr/bin/env node
/**
 * P9C/C3 gate. task-projection terminal status/interaction/waitingFor shape
 * must be resolved from task-projection-terminal-shape.ts, not re-copied in
 * the live projection sync writer.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SHAPE_REL = 'src/main/modules/agent-control/task-projection/task-projection-terminal-shape.ts'
const SYNC_REL = 'src/main/modules/agent-control/task-projection/task-projection-sync.ts'

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

function push(violations, file, line, kind, detail) {
  violations.push({ file, line, kind, detail })
}

function check() {
  const violations = []
  const shape = fs.existsSync(path.join(ROOT, SHAPE_REL)) ? read(SHAPE_REL) : ''
  if (!shape) {
    push(violations, SHAPE_REL, 1, 'shape_source_missing', 'terminal projection shape source is missing')
  }
  for (const exportName of [
    'resolveTerminalProjectionStatus',
    'resolveTerminalProjectionInteractionState',
    'resolveTerminalProjectionWaitingFor',
  ]) {
    if (!new RegExp(`export\\s+function\\s+${exportName}\\s*\\(`).test(shape)) {
      push(violations, SHAPE_REL, 1, 'shape_export_missing', `${exportName} must be exported`)
    }
  }

  const sync = read(SYNC_REL)
  if (!sync.includes('./task-projection-terminal-shape')) {
    push(violations, SYNC_REL, 1, 'sync_import_missing', 'task-projection-sync must import terminal shape helpers')
  }
  for (const localName of [
    'resolveTerminalStatus',
    'resolveTerminalInteractionState',
    'resolveTerminalWaitingFor',
  ]) {
    const re = new RegExp(`function\\s+${localName}\\s*\\(`, 'g')
    let match
    while ((match = re.exec(sync))) {
      push(
        violations,
        SYNC_REL,
        lineOf(sync, match.index),
        'local_terminal_shape_resolver',
        `${localName} duplicates task-projection-terminal-shape.ts`,
      )
    }
  }
  return violations
}

if (require.main === module) {
  const violations = check()
  if (violations.length === 0) {
    console.log('check-task-projection-terminal-shape-single-source: ok')
    process.exit(0)
  }
  console.error('check-task-projection-terminal-shape-single-source: violations:')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} [${violation.kind}] ${violation.detail}`)
  }
  process.exit(1)
}

module.exports = { check }
