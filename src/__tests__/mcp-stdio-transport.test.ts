/**
 * Phase M（2026-07-05）—— stdio transport / discovery / 装配 / 确认闸动态
 * 映射的行为合同。e2e 段真 spawn 仓内 fixture server
 * （scripts/test-fixtures/mcp-stdio-fixture-server.cjs，无网络确定性）。
 *
 * 合同锚：调研 `2026-07-05-phase-M-mcp-ecosystem-survey.md` 块 1/2/3/4/7。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { McpClient, canonicalMcpToolName, __resetMcpClientsForTests, registerMcpClient } from '../main/modules/mcp/client'
import {
  applyDiscoveryResult,
  discoverToolsFromServer,
  MAX_TOOLS_PER_SERVER,
} from '../main/modules/mcp/tool-discovery'
import {
  __resetMcpRegistryForTests,
  getMcpToolAnnotations,
  getMcpToolCatalogEntry,
  isMcpToolReady,
  listMcpToolNames,
  registerMcpServer,
} from '../main/modules/mcp/registry'
import { parseMcpServersConfig, bootstrapMcpServersFromSettings, MCP_SERVERS_SETTING_KEY } from '../main/modules/mcp/bootstrap'
import { resolveConfirmationGate } from '../main/modules/agent-control/safety/action-confirmation-policy'
import { executeMcpTool } from '../main/modules/tools/mcp-tools'
import { normalizeCodexNativeNotification } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('mcp-stdio-transport declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'mcp-stdio-transport transitive sqlite load')
})

const FIXTURE_PATH = join(process.cwd(), 'scripts/test-fixtures/mcp-stdio-fixture-server.cjs')

function makeFixtureClient(
  serverId = 'fixture',
  env: Record<string, string> = {},
): McpClient {
  const root = mkdtempSync(join(tmpdir(), 'ready-mcp-test-'))
  return new McpClient({
    serverId,
    transport: 'stdio',
    endpoint: process.execPath,
    args: [FIXTURE_PATH],
    cwd: root,
    dataDir: root,
    env: {
      MCP_FIXTURE_EXPLICIT: 'visible',
      MCP_FIXTURE_NOISY: '1',
      ELECTRON_RUN_AS_NODE: '1',
      ...env,
    },
  })
}

test('canonical tool name sanitizes server id and remote name', () => {
  assert.equal(canonicalMcpToolName('My-Server', 'read/File'), 'mcp_my_server_read_file')
  assert.equal(canonicalMcpToolName('fixture', 'echo_read'), 'mcp_fixture_echo_read')
})

test('stdio catalog pagination reads every tool, resource, and resource template page', async () => {
  const client = makeFixtureClient('paged', { MCP_FIXTURE_PAGINATE: '1' })
  try {
    assert.equal((await client.listTools()).length, 3)
    assert.deepEqual((await client.listResources()).map((resource) => resource.uri), [
      'fixture://readme',
      'fixture://second',
    ])
    assert.deepEqual((await client.listResourceTemplates()).map((template) => template.uriTemplate), [
      'fixture://item/{id}',
      'fixture://page/{id}',
    ])
  } finally {
    await client.close()
  }
})

test('MCP canonical collisions fail before publishing an ambiguous tool', async () => {
  const client = makeFixtureClient('fixture', { MCP_FIXTURE_COLLISION: '1' })
  try {
    await assert.rejects(client.listTools(), /canonical tool collision/)
  } finally {
    await client.close()
  }

  __resetMcpRegistryForTests()
  registerMcpServer({
    serverId: 'first',
    toolNames: ['mcp_shared_read'],
    approvalMode: 'writes',
  })
  assert.throws(() => registerMcpServer({
    serverId: 'second',
    toolNames: ['mcp_shared_read'],
    approvalMode: 'writes',
  }), /mcp_cross_server_tool_collision/)
  assert.throws(() => registerMcpServer({
    serverId: 'duplicate',
    toolNames: ['mcp_duplicate_read', 'mcp_duplicate_read'],
    approvalMode: 'writes',
  }), /mcp_duplicate_canonical_tool/)
  __resetMcpRegistryForTests()
})

test('native Matrix MCP notifications are rejected so Ready remains the only MCP channel', () => {
  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'item/mcpToolCall/progress',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  }), { kind: 'invalid', code: 'opted_out_method' })
})

test('stdio e2e: handshake → tools/list → tools/call round-trip → close kills the child', async () => {
  const client = makeFixtureClient()
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'mcp_fixture_echo_read',
      'mcp_fixture_read_env',
      'mcp_fixture_write_note',
    ])
    const echo = tools.find((tool) => tool.name === 'mcp_fixture_echo_read')
    assert.equal(echo?.remoteName, 'echo_read')
    assert.equal(echo?.annotations?.readOnlyHint, true)
    assert.equal((echo?.inputSchema as { required?: string[] })?.required?.[0], 'text')

    const metadata = await client.getMetadata()
    assert.equal(metadata.serverInfo?.name, 'ready-mcp-fixture')
    assert.match(metadata.instructions || '', /untrusted/)
    assert.deepEqual((await client.listResources()).map((resource) => resource.uri), ['fixture://readme'])
    assert.deepEqual((await client.listResourceTemplates()).map((template) => template.uriTemplate), ['fixture://item/{id}'])
    assert.equal((await client.readResource('fixture://readme')).contents instanceof Array, true)
    assert.match(client.getDiagnostics().stderrTail, /fixture-noise/)

    const call = await client.callTool({
      toolName: 'mcp_fixture_echo_read',
      arguments: { text: 'ready' },
    })
    assert.equal(call.ok, true)
    assert.deepEqual(call.output, { text: 'echo:ready' })

    const structured = await client.callTool({
      toolName: 'mcp_fixture_write_note',
      arguments: { note: 'hello' },
    })
    assert.equal(structured.ok, true)
    assert.deepEqual(structured.output, { written: true, note: 'hello' })

    const env = await client.callTool({
      toolName: 'mcp_fixture_read_env',
      arguments: { keys: ['MCP_FIXTURE_EXPLICIT', 'OPENAI_API_KEY'] },
    })
    assert.deepEqual(env.output, {
      values: { MCP_FIXTURE_EXPLICIT: 'visible', OPENAI_API_KEY: null },
    })

    const unknown = await client.callTool({
      toolName: 'mcp_fixture_missing_tool',
      arguments: {},
    })
    assert.equal(unknown.ok, false)
    assert.match(String(unknown.error?.message || ''), /unknown tool/)
  } finally {
    await client.close()
  }
})

test('discovery + registry: catalog carries annotations, no-auth server authorizes directly, dispatch round-trips', async () => {
  __resetMcpRegistryForTests()
  __resetMcpClientsForTests()
  const client = makeFixtureClient()
  try {
    const discovery = await discoverToolsFromServer(client)
    assert.equal(discovery.error, undefined)
    assert.equal(discovery.tools.length, 3)
    applyDiscoveryResult(discovery, { approvalMode: 'writes' })
    registerMcpClient(client)

    assert.ok(listMcpToolNames().includes('mcp_fixture_echo_read'))
    assert.equal(isMcpToolReady('mcp_fixture_echo_read'), true)
    assert.equal(getMcpToolAnnotations('mcp_fixture_echo_read')?.readOnlyHint, true)
    assert.equal(getMcpToolCatalogEntry('mcp_fixture_write_note')?.remoteName, 'write_note')

    // 全链 dispatch（tool-executor case 'mcp' 的核心路径）：结构化回灌
    const output = await executeMcpTool('mcp_fixture_echo_read', { text: '全链' }, {
      sessionId: 'sess-1',
      scopeId: 'scope-1',
    })
    const data = (output as { structured?: { data?: Record<string, unknown> } }).structured?.data
      ?? (JSON.parse(output.text.replace(/^mcp ok:.*$/m, '') || '{}') as Record<string, unknown>)
    void data
    assert.match(output.text, /mcp ok: fixture\/mcp_fixture_echo_read/)
  } finally {
    await client.close()
    __resetMcpRegistryForTests()
    __resetMcpClientsForTests()
  }
})

test('confirmation gate: declared read-only mcp tool allows; non-read-only requires M2 confirm; unknown mcp name stays conservative', () => {
  __resetMcpRegistryForTests()
  applyDiscoveryResult({
    serverId: 'fixture',
    tools: [
      { name: 'mcp_fixture_echo_read', remoteName: 'echo_read', annotations: { readOnlyHint: true } },
      { name: 'mcp_fixture_write_note', remoteName: 'write_note' },
      { name: 'mcp_fixture_drop_table', remoteName: 'drop_table', annotations: { destructiveHint: true } },
    ],
  }, { approvalMode: 'writes' })

  const readOnly = resolveConfirmationGate('mcp_fixture_echo_read', {})
  assert.equal(readOnly.action, 'allow')
  assert.equal(readOnly.ruleId, 'mcp-readonly-declared')

  const write = resolveConfirmationGate('mcp_fixture_write_note', {})
  assert.equal(write.mode, 'M2')
  assert.equal(write.action, 'confirm')
  assert.equal(write.ruleId, 'mcp-external-write-default')

  const destructive = resolveConfirmationGate('mcp_fixture_drop_table', {})
  assert.equal(destructive.action, 'confirm')
  assert.match(destructive.reason, /destructiveHint/)

  const unknown = resolveConfirmationGate('mcp_ghost_unknown_tool', {})
  assert.equal(unknown.mode, 'M2')
  assert.equal(unknown.action, 'confirm')

  const builtin = resolveConfirmationGate('some_builtin_tool', {})
  assert.equal(builtin.ruleId, 'default-unlisted')

  applyDiscoveryResult({
    serverId: 'always',
    tools: [{ name: 'mcp_always_read', remoteName: 'read', annotations: { readOnlyHint: true } }],
  }, { approvalMode: 'always' })
  assert.equal(resolveConfirmationGate('mcp_always_read', {}).action, 'confirm')

  applyDiscoveryResult({
    serverId: 'never',
    tools: [{ name: 'mcp_never_write', remoteName: 'write' }],
  }, { approvalMode: 'never' })
  assert.equal(resolveConfirmationGate('mcp_never_write', {}).action, 'allow')
  __resetMcpRegistryForTests()
})

test('per-server tool cap drops beyond MAX_TOOLS_PER_SERVER and reports the dropped names', async () => {
  const manyTools = Array.from({ length: MAX_TOOLS_PER_SERVER + 3 }, (_, index) => ({
    name: `tool_${index}`,
    remoteName: `tool_${index}`,
  }))
  const fakeClient = {
    serverId: 'big',
    listTools: async () => manyTools.map((tool) => ({
      name: canonicalMcpToolName('big', tool.remoteName),
      remoteName: tool.remoteName,
    })),
    listResources: async () => [],
    listResourceTemplates: async () => [],
    getMetadata: async () => ({ protocolVersion: '2024-11-05', serverInfo: null, capabilities: {}, instructions: null }),
  } as unknown as McpClient
  const discovery = await discoverToolsFromServer(fakeClient)
  assert.equal(discovery.tools.length, MAX_TOOLS_PER_SERVER)
  assert.equal(discovery.dropped?.length, 3)
})

test('bootstrap config parsing skips invalid entries with reasons and normalizes valid ones', () => {
  const parsed = parseMcpServersConfig(JSON.stringify([
    { id: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    { id: 'ws-server', transport: 'websocket', command: 'x' },
    { id: '', command: 'x' },
    { id: 'filesystem', command: 'dup' },
    { id: 'disabled-one', command: 'node', enabled: false },
    'garbage',
  ]))
  assert.equal(parsed.configs.length, 2)
  assert.equal(parsed.configs[0].id, 'filesystem')
  assert.equal(parsed.configs[0].approvalMode, 'writes')
  assert.equal(parsed.configs[1].enabled, false)
  assert.deepEqual(parsed.skipped.map((s) => s.reason.split(':')[0]), [
    'unsupported_transport_phase_m',
    'missing_id',
    'duplicate_id',
    'not_an_object',
  ])
  assert.equal(parseMcpServersConfig('not json').configs.length, 0)
  assert.equal(parseMcpServersConfig('').configs.length, 0)
})

test('bootstrap assembles enabled servers, tolerates per-server failure, and logs dropped tools', async () => {
  const logs: string[] = []
  const outcomes = await bootstrapMcpServersFromSettings({
    getSetting: (key) => {
      assert.equal(key, MCP_SERVERS_SETTING_KEY)
      return JSON.stringify([
        { id: 'good', command: 'node' },
        { id: 'bad', command: 'node' },
        { id: 'off', command: 'node', enabled: false },
      ])
    },
    log: (line) => logs.push(line),
    connectAndDiscover: async (config) => {
      if (config.id === 'bad') throw new Error('spawn ENOENT')
      return { tools: 2, dropped: ['mcp_good_extra'] }
    },
  })
  assert.deepEqual(outcomes.map((o) => [o.serverId, o.ok]), [['good', true], ['bad', false]])
  assert.ok(logs.some((line) => line.includes('tool cap dropped 1')), 'dropped tools must be observable')
  assert.ok(logs.some((line) => line.includes('off disabled')), 'disabled skip must be observable')
  assert.ok(logs.some((line) => line.includes('bad failed: spawn ENOENT')))
})
