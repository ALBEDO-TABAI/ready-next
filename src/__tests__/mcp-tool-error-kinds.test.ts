import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isRegisteredErrorKind,
  lookupErrorKindMeta,
  MCP_TOOL_ERROR_KINDS,
} from '../main/modules/agent-control/contracts/error-kinds'
import {
  McpClient,
  registerMcpClient,
  __resetMcpClientsForTests,
  type McpToolCallRequest,
  type McpToolCallResult,
} from '../main/modules/mcp/client'
import {
  authorizeMcpToolForScope,
  registerMcpServer,
  __resetMcpRegistryForTests,
} from '../main/modules/mcp/registry'
import { setCachedMcpOAuthToken, __resetMcpOAuthForTests } from '../main/modules/mcp/oauth'
import { executeMcpTool } from '../main/modules/tools/mcp-tools'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

class FakeMcpClient extends McpClient {
  private readonly handler: (request: McpToolCallRequest) => Promise<McpToolCallResult> | McpToolCallResult

  constructor(
    serverId: string,
    handler: (request: McpToolCallRequest) => Promise<McpToolCallResult> | McpToolCallResult,
  ) {
    super({
      serverId,
      transport: 'stdio',
      endpoint: 'test',
      requiresAuthorization: false,
    })
    this.handler = handler
  }

  override async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    return this.handler(request)
  }
}

function resetMcpState() {
  __resetMcpRegistryForTests()
  __resetMcpClientsForTests()
  __resetMcpOAuthForTests()
}

function registerPublicTool(serverId = 'mcp-test-server', toolName = 'mcp_test_action') {
  registerMcpServer({
    serverId,
    toolNames: [toolName],
    requiresAuthorization: false,
  })
  return { serverId, toolName }
}

function registerAuthorizedTool() {
  const serverId = 'mcp-authorized-server'
  const toolName = 'mcp_authorized_action'
  const sessionId = 'session-a'
  const scopeId = 'scope-a'
  registerMcpServer({
    serverId,
    toolNames: [toolName],
    requiresAuthorization: true,
  })
  setCachedMcpOAuthToken(serverId, {
    accessToken: 'token',
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
  authorizeMcpToolForScope(serverId, toolName, sessionId, scopeId)
  return { serverId, toolName, sessionId, scopeId }
}

async function assertMcpDomainError(
  promise: Promise<unknown>,
  expectedKind: string,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof ToolDomainError, true)
    assert.equal((error as ToolDomainError).errorKind, expectedKind)
    return true
  })
}

test('mcp tool errorKinds are registered in runtime helpers', () => {
  for (const meta of Object.values(MCP_TOOL_ERROR_KINDS)) {
    assert.equal(isRegisteredErrorKind(meta.code), true, `${meta.code} should be registered`)
    assert.deepEqual(lookupErrorKindMeta(meta.code), meta)
  }
})

test('executeMcpTool reports unregistered tools with the shared MCP code', async () => {
  resetMcpState()

  await assertMcpDomainError(
    executeMcpTool('mcp_missing_action', {}, {}),
    MCP_TOOL_ERROR_KINDS.toolUnregistered.code,
  )
})

test('executeMcpTool reports scope denial with the shared MCP code', async () => {
  resetMcpState()
  registerMcpServer({
    serverId: 'mcp-denied-server',
    toolNames: ['mcp_denied_action'],
    requiresAuthorization: true,
  })

  await assertMcpDomainError(
    executeMcpTool('mcp_denied_action', {}, { sessionId: 'session-a', scopeId: 'scope-a' }),
    MCP_TOOL_ERROR_KINDS.authorizationDenied.code,
  )
})

test('executeMcpTool reports missing clients with the shared MCP code', async () => {
  resetMcpState()
  const { toolName } = registerPublicTool()

  await assertMcpDomainError(
    executeMcpTool(toolName, {}, { sessionId: 'session-a', scopeId: 'scope-a' }),
    MCP_TOOL_ERROR_KINDS.clientMissing.code,
  )
})

test('executeMcpTool reports thrown client errors with the shared MCP code', async () => {
  resetMcpState()
  const { serverId, toolName, sessionId, scopeId } = registerAuthorizedTool()
  registerMcpClient(new FakeMcpClient(serverId, () => {
    throw new Error('client boom')
  }))

  await assertMcpDomainError(
    executeMcpTool(toolName, {}, { sessionId, scopeId }),
    MCP_TOOL_ERROR_KINDS.toolFailed.code,
  )
})

test('executeMcpTool reports non-ok client results without a kind with the shared MCP code', async () => {
  resetMcpState()
  const { serverId, toolName, sessionId, scopeId } = registerAuthorizedTool()
  registerMcpClient(new FakeMcpClient(serverId, () => ({
    ok: false,
    error: { message: 'no kind supplied' } as { kind: string; message: string },
  })))

  await assertMcpDomainError(
    executeMcpTool(toolName, {}, { sessionId, scopeId }),
    MCP_TOOL_ERROR_KINDS.toolFailed.code,
  )
})

test('executeMcpTool preserves external MCP error kinds returned by clients', async () => {
  resetMcpState()
  const { serverId, toolName, sessionId, scopeId } = registerAuthorizedTool()
  registerMcpClient(new FakeMcpClient(serverId, () => ({
    ok: false,
    error: {
      kind: 'external_quota_exceeded',
      message: 'quota exceeded',
    },
  })))

  await assertMcpDomainError(
    executeMcpTool(toolName, {}, { sessionId, scopeId }),
    'external_quota_exceeded',
  )
})
