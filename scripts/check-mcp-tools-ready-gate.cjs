#!/usr/bin/env node
'use strict'

const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const registry = readFileSync(resolve(__dirname, '../src/main/modules/mcp/registry.ts'), 'utf8')
const tools = readFileSync(resolve(__dirname, '../src/main/modules/agent-control/tools-runtime/tool-registry.ts'), 'utf8')
const executor = readFileSync(resolve(__dirname, '../src/main/modules/tools/mcp-tools.ts'), 'utf8')
const violations = []

if (!/export function isMcpToolReady\(toolName: string\)/.test(registry)) {
  violations.push('registry must export the connected-catalog readiness gate')
}
if ((tools.match(/mcpRegistry\.isMcpToolReady\(/g) || []).length < 2) {
  violations.push('model-visible definitions and schemas must both use the readiness gate')
}
if (!/isMcpToolReady\(toolName\)/.test(executor)) {
  violations.push('execution must recheck the readiness gate')
}
if (/oauth|websocket|deferred/i.test(registry)) {
  violations.push('registry must not contain retired remote MCP paths')
}

if (violations.length) {
  console.error('[check-mcp-tools-ready-gate] FAIL')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}
console.log('[check-mcp-tools-ready-gate] OK')
