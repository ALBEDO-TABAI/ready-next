#!/usr/bin/env node
/**
 * Stage T PR-T5 — MCP tool-list path goes through `mcp.registry.isAuthorized`
 * with end-to-end (sessionId, scopeId) plumbing.
 *
 * Five sub-checks (plan v18 §6.5):
 *   (A) `mcp/registry.ts` exports `isAuthorized` with a 3-arity signature
 *       `(toolName, sessionId, scopeId)`.
 *   (B) `tool-registry.ts` imports the mcp registry and calls `isAuthorized`
 *       inside a `groupId === 'mcp'` branch of the model-visible list resolver.
 *   (C) The call site passes BOTH `sessionId` AND `scopeId`.
 *   (D) `RequestEnvelope.scopeId`, `ToolPolicy.scopeId`, and the gateway's
 *       `getToolDefinitionsForGroup` / `getToolSchemasForGroup` (4 surface
 *       points) all carry scopeId.
 *   (E) The schema-list resolver applies the same authorization filter — so
 *       both definitions AND OpenAI/Anthropic schema bundles agree.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const REGISTRY_FILE = 'src/main/modules/mcp/registry.ts'
const TOOL_REGISTRY_FILE = 'src/main/modules/agent-control/tools-runtime/tool-registry.ts'
const TOOL_GATEWAY_FILE = 'src/main/modules/agent-control/tools-runtime/tool-gateway.ts'
const REQUEST_ENVELOPE_FILE = 'src/main/modules/agent-control/contracts/request-envelope.ts'
const TOOL_POLICY_FILE = 'src/main/modules/agent-control/tool-policy/execution-tool-config.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  // (A) registry exports isAuthorized with 3 args.
  const registrySrc = read(REGISTRY_FILE)
  if (!registrySrc) {
    violations.push({ file: REGISTRY_FILE, reason: 'missing file' })
  } else {
    if (!/export\s+function\s+isAuthorized\s*\(/.test(registrySrc)) {
      violations.push({ file: REGISTRY_FILE, reason: 'must export `isAuthorized(...)` function' })
    }
    // 3-arity: toolName + sessionId + scopeId.
    if (!/export\s+function\s+isAuthorized\s*\(\s*toolName\s*:\s*string\s*,\s*sessionId\s*:[^,]+,\s*scopeId\s*:/.test(registrySrc)) {
      violations.push({
        file: REGISTRY_FILE,
        reason: 'isAuthorized must take 3 args: (toolName, sessionId, scopeId)',
      })
    }
  }

  // (B) tool-registry imports mcp registry and calls isAuthorized inside an mcp branch.
  const toolRegistrySrc = read(TOOL_REGISTRY_FILE)
  if (!toolRegistrySrc) {
    violations.push({ file: TOOL_REGISTRY_FILE, reason: 'missing file' })
  } else {
    if (!/import\s+\*\s+as\s+mcpRegistry\s+from\s+['"]\.\.\/mcp\/registry['"]/.test(toolRegistrySrc)
      && !/from\s+['"]\.\.\/mcp\/registry['"]/.test(toolRegistrySrc)) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: 'must import mcp registry from ../mcp/registry',
      })
    }
    // Need a guarded mcp branch + isAuthorized call.
    const hasMcpBranch = /groupId\s*===\s*['"]mcp['"]/.test(toolRegistrySrc)
    if (!hasMcpBranch) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: "must guard the model-visible mcp filter with `groupId === 'mcp'`",
      })
    }
    const isAuthorizedCalls = (toolRegistrySrc.match(/mcpRegistry\.isAuthorized\s*\(/g) || []).length
    if (isAuthorizedCalls < 2) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: `mcpRegistry.isAuthorized called ${isAuthorizedCalls} time(s); expected ≥ 2 (definitions + schemas paths)`,
      })
    }
    // (C) call site passes sessionId AND scopeId.
    const callsHaveBothArgs = /mcpRegistry\.isAuthorized\s*\(\s*[^,]+,\s*sessionId\s*,\s*scopeId\s*\)/.test(toolRegistrySrc)
    if (!callsHaveBothArgs) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: 'mcpRegistry.isAuthorized call must pass BOTH sessionId and scopeId',
      })
    }
    // mcp provider must be registered.
    if (!/^\s*mcp:\s*\{/m.test(toolRegistrySrc)) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: 'GROUP_TOOL_PROVIDERS must contain `mcp:` entry',
      })
    }
  }

  // (D) RequestEnvelope.scopeId + ToolPolicy.scopeId + gateway 2 method signatures.
  const envelopeSrc = read(REQUEST_ENVELOPE_FILE)
  if (!envelopeSrc) {
    violations.push({ file: REQUEST_ENVELOPE_FILE, reason: 'missing file' })
  } else {
    if (!/RequestEnvelope[\s\S]*?scopeId\s*\?\s*:\s*string/.test(envelopeSrc)) {
      violations.push({
        file: REQUEST_ENVELOPE_FILE,
        reason: 'RequestEnvelope must declare `scopeId?: string`',
      })
    }
  }
  const policySrc = read(TOOL_POLICY_FILE)
  if (!policySrc) {
    violations.push({ file: TOOL_POLICY_FILE, reason: 'missing file' })
  } else {
    // ToolPolicy interface block must declare scopeId?.
    if (!/interface\s+ToolPolicy\s*\{[\s\S]*?\bscopeId\?\s*:\s*string/.test(policySrc)) {
      violations.push({
        file: TOOL_POLICY_FILE,
        reason: 'ToolPolicy must declare `scopeId?: string`',
      })
    }
    // Bundle path must thread policy.scopeId into both gateway calls.
    const scopeIdThreadCount = (policySrc.match(/policy\?\.scopeId/g) || []).length
    if (scopeIdThreadCount < 2) {
      violations.push({
        file: TOOL_POLICY_FILE,
        reason: `policy?.scopeId threaded into ${scopeIdThreadCount} gateway call(s); expected ≥ 2 (anthropic + openai bundle)`,
      })
    }
  }

  const gatewaySrc = read(TOOL_GATEWAY_FILE)
  if (!gatewaySrc) {
    violations.push({ file: TOOL_GATEWAY_FILE, reason: 'missing file' })
  } else {
    // getToolSchemasForGroup signature must include scopeId param.
    if (!/getToolSchemasForGroup\s*\([\s\S]*?scopeId\?\s*:\s*string[\s\S]*?\)/.test(gatewaySrc)) {
      violations.push({
        file: TOOL_GATEWAY_FILE,
        reason: 'getToolSchemasForGroup must accept `scopeId?: string`',
      })
    }
  }
  if (toolRegistrySrc) {
    if (!/getToolDefinitionsForGroup\s*\([\s\S]*?scopeId\?\s*:\s*string[\s\S]*?\)/.test(toolRegistrySrc)) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: 'getToolDefinitionsForGroup must accept `scopeId?: string`',
      })
    }
    if (!/getToolSchemasForGroup\s*\([\s\S]*?scopeId\?\s*:\s*string[\s\S]*?\)/.test(toolRegistrySrc)) {
      violations.push({
        file: TOOL_REGISTRY_FILE,
        reason: 'getToolSchemasForGroup must accept `scopeId?: string`',
      })
    }
  }

  // (E) schema-list resolver applies the same filter (definitions and schemas
  //     resolvers each carry an mcp-branch isAuthorized filter — counted as
  //     ≥ 2 above).
  // already enforced via the `< 2` callCount above.

  if (violations.length > 0) {
    console.error('[check-mcp-tools-go-through-authorization] FAIL:')
    for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
    process.exit(1)
  }
  console.log('[check-mcp-tools-go-through-authorization] OK')
}

main()
