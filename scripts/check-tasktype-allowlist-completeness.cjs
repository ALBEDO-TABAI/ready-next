#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * Every `taskType: '<literal>'` field assignment in the production tree
 * must use a value declared by the shared TASK_TYPES source of truth.
 *
 * This ensures the typed union and the literals stay in sync. New task
 * types added without updating shared/task-types.ts are caught here.
 *
 * Whitelist (per plan §3.1.11):
 *   - shared/task-types.ts (the union itself)
 *   - browser-engine/capability-types.ts:77 (BrowserCapabilityTaskKind, not TaskType)
 *   - tools/schemas/browser-content-schemas.ts:64
 *   - task-projection-repository.ts (SQL constants)
 *   - __tests__/fixtures/**
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SCAN_ROOTS = ['src/main/', 'src/renderer/', 'src/shared/']
const taskTypesSource = fs.readFileSync(path.join(ROOT, 'src/shared/task-types.ts'), 'utf8')
const taskTypesLiteral = taskTypesSource.match(/export const TASK_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/)
if (!taskTypesLiteral) {
  console.error('[check-tasktype-allowlist-completeness] FAIL: cannot read shared TASK_TYPES')
  process.exit(1)
}
const ALLOWED = new Set(
  Array.from(taskTypesLiteral[1].matchAll(/['"]([a-zA-Z_][\w-]*)['"]/g), (match) => match[1]),
)
if (ALLOWED.size === 0) {
  console.error('[check-tasktype-allowlist-completeness] FAIL: shared TASK_TYPES is empty')
  process.exit(1)
}

const WHITELIST_PATTERNS = [
  /^src\/shared\/task-types\.ts$/,
  /^src\/main\/modules\/browser-engine\/capability-types\.ts$/,
  /^src\/main\/modules\/tools\/schemas\/browser-content-schemas\.ts$/,
  /^src\/main\/modules\/agent-control\/task-projection-repository\.ts$/,
  /^src\/__tests__\/fixtures\//,
  /\.test\.ts$/,
  /\.test\.tsx$/,
]

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

function isWhitelisted(rel) {
  return WHITELIST_PATTERNS.some((re) => re.test(rel))
}

const errors = []

for (const scanRoot of SCAN_ROOTS) {
  const abs = path.join(ROOT, scanRoot)
  if (!fs.existsSync(abs)) continue
  for (const file of listFiles(abs)) {
    const rel = relposix(file)
    if (isWhitelisted(rel)) continue
    let body
    try { body = fs.readFileSync(file, 'utf8') } catch { continue }
    // Match `taskType: 'literal'` assignments where literal is a string literal.
    const re = /taskType\s*:\s*['"]([a-zA-Z_][\w-]*)['"]/g
    let m
    while ((m = re.exec(body)) !== null) {
      const literal = m[1]
      if (!ALLOWED.has(literal)) {
        // compute line number for human-readable message
        const upToMatch = body.slice(0, m.index)
        const line = upToMatch.split('\n').length
        errors.push(`${rel}:${line}: taskType: '${literal}' not in allowed set (must be one of ${[...ALLOWED].join('/')})`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error('[check-tasktype-allowlist-completeness] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-tasktype-allowlist-completeness] OK')
