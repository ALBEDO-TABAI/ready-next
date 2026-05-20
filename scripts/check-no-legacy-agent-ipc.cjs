#!/usr/bin/env node
/**
 * Stage U PR U1.2 — fence reintroduction of legacy AgentManager IPC.
 *
 * Audit §1.1 / plan §2 U1.2 — the channels below were the pre-SDK-runtime
 * admission surface, exposed by `claude-bridge/ipc-handler.ts` and proxied
 * through `preload/index.ts` + `renderer/types/electron.d.ts`. They allowed
 * old `AgentManager` to be driven from renderer, bypassing the new
 * `ToolRuntime` admission contract. Verified zero production callers
 * before deletion in U1.2; this gate prevents reintroduction.
 *
 * Forbidden channel literals in src/main, src/preload, src/renderer:
 *   - 'agent:orchestrate'
 *   - 'agent:getStatus'
 *   - 'agent:getAll'
 *   - 'agent:getDiagnostics'
 *   - 'tool_execute' (U0.1 retired the EventEmitter bridge; this completes
 *     the fence around it)
 *
 * Whitelist (read-only):
 *   - This gate itself
 *   - Test fixtures (may pin the historical shape)
 *   - docs/ + Stage U plan/audit (history)
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOTS = ['src/main', 'src/preload', 'src/renderer']
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'])

const FILE_ALLOWLIST = [
  /^scripts\/check-no-legacy-agent-ipc\.cjs$/,
  /^src\/__tests__\//,
  /^docs\//,
]

const FORBIDDEN_CHANNELS = [
  /['"]agent:orchestrate['"]/,
  /['"]agent:getStatus['"]/,
  /['"]agent:getAll['"]/,
  /['"]agent:getDiagnostics['"]/,
  /['"]tool_execute['"]/,
]

function isAllowed(rel) {
  return FILE_ALLOWLIST.some((rx) => rx.test(rel))
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__tests__') continue
      yield* walk(full)
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      yield full
    }
  }
}

function stripComments(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock.replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function checkNoLegacyAgentIpc() {
  const violations = []
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root)
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full)
      if (isAllowed(rel)) continue
      const raw = fs.readFileSync(full, 'utf8')
      const source = stripComments(raw)
      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        for (const pattern of FORBIDDEN_CHANNELS) {
          if (pattern.test(lines[i])) {
            violations.push({
              file: rel,
              line: i + 1,
              pattern: pattern.toString(),
              code: lines[i].trim().slice(0, 160),
            })
          }
        }
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkNoLegacyAgentIpc()
  if (ok) { console.log('[check-no-legacy-agent-ipc] OK'); return 0 }
  console.error('[check-no-legacy-agent-ipc] FAIL — legacy AgentManager IPC channels are retired (Stage U1.2 / U0.1).')
  console.error('  Use agent:getRuntimeStatus / agent:getCapabilityRuntimeSnapshot instead.')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkNoLegacyAgentIpc }
