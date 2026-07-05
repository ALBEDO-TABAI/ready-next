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
  isAuthorized,
  listMcpToolNames,
} from '../main/modules/mcp/registry'
import { parseMcpServersConfig, bootstrapMcpServersFromSettings, MCP_SERVERS_SETTING_KEY } from '../main/modules/mcp/bootstrap'
import { resolveConfirmationGate } from '../main/modules/agent-control/safety/action-confirmation-policy'
import { executeMcpTool } from '../main/modules/tools/mcp-tools'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('mcp-stdio-transport declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'mcp-stdio-transport transitive sqlite load')
})

const FIXTURE_PATH = join(process.cwd(), 'scripts/test-fixtures/mcp-stdio-fixture-server.cjs')

function makeFixtureClient(serverId = 'fixture'): McpClient {
  return new McpClient({
    serverId,
    transport: 'stdio',
    endpoint: process.execPath,
    args: [FIXTURE_PATH],
    requiresAuthorization: false,
  })
}

test('canonical tool name sanitizes server id and remote name', () => {
  assert.equal(canonicalMcpToolName('My-Server', 'read/File'), 'mcp_my_server_read_file')
  assert.equal(canonicalMcpToolName('fixture', 'echo_read'), 'mcp_fixture_echo_read')
})

test('stdio e2e: handshake → tools/list → tools/call round-trip → close kills the child', async () => {
  const client = makeFixtureClient()
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'mcp_fixture_echo_read',
      'mcp_fixture_write_note',
    ])
    const echo = tools.find((tool) => tool.name === 'mcp_fixture_echo_read')
    assert.equal(echo?.remoteName, 'echo_read')
    assert.equal(echo?.annotations?.readOnlyHint, true)
    assert.equal((echo?.inputSchema as { required?: string[] })?.required?.[0], 'text')

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
    assert.equal(discovery.tools.length, 2)
    applyDiscoveryResult(discovery, { requiresAuthorization: false })
    registerMcpClient(client)

    assert.ok(listMcpToolNames().includes('mcp_fixture_echo_read'))
    assert.equal(isAuthorized('mcp_fixture_echo_read', 'sess-1', 'scope-1'), true, 'no-auth stdio server authorizes directly')
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
  }, { requiresAuthorization: false })

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
  assert.equal(parsed.configs[0].requiresAuthorization, false, 'stdio defaults to no-OAuth')
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
