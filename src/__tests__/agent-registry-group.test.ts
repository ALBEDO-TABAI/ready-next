import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentRegistryGroup,
  _agentRegistryGroupChannelsForTest,
  type AgentRegistryGroupDeps,
} from '../main/modules/claude-bridge/ipc/agent-registry-group'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createMockIpc() {
  const handlers = new Map<string, HandlerFn>()
  const removeHandlerCalls: string[] = []
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  return { ipc, handlers, removeHandlerCalls }
}

function record(overrides: Partial<AgentRegistryRecord>): AgentRegistryRecord {
  return {
    id: 'writer',
    name: 'Writer',
    charter: null,
    personaRef: null,
    status: 'active',
    parentAgentId: null,
    derivationReason: null,
    mergedIntoAgentId: null,
    createdAt: '2026-06-13T00:00:00.000Z',
    ...overrides,
  }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-registry-group-'))
  mkdirSync(join(root, 'agents', 'writer', 'knowledge', 'sites'), { recursive: true })
  mkdirSync(join(root, 'agents', 'editor', 'knowledge', 'sites'), { recursive: true })
  return root
}

function fm(overrides: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '写作经验',
    description: '写作 agent 的经验',
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-13',
    status: 'active',
    ...overrides,
  }
}

test('agentRegistryGroup registers and disposes its lifecycle channels', () => {
  const { ipc, handlers, removeHandlerCalls } = createMockIpc()
  const handle = agentRegistryGroup.register(ipc, {
    listAgents: () => [],
    getBeliefCardStore: () => null,
    updateStatus: () => record({}),
  })
  assert.deepEqual([...handlers.keys()].sort(), [..._agentRegistryGroupChannelsForTest].sort())
  assert.equal(agentRegistryGroup.namespace, 'agent:registry')

  const baseline = removeHandlerCalls.length
  handle.dispose()
  assert.deepEqual(removeHandlerCalls.slice(baseline).sort(), [..._agentRegistryGroupChannelsForTest].sort())
})

test('agentRegistryGroup lists agents and updates status through deps', async () => {
  const { ipc, handlers } = createMockIpc()
  const rows = [record({ id: 'writer', name: 'Writer' })]
  const updates: unknown[] = []
  const deps: AgentRegistryGroupDeps = {
    listAgents: () => rows,
    getBeliefCardStore: () => null,
    updateStatus: (id, status, options) => {
      updates.push({ id, status, options })
      return record({ id, status, mergedIntoAgentId: options?.mergedIntoAgentId ?? null })
    },
  }
  agentRegistryGroup.register(ipc, deps)

  const list = await handlers.get('agent:registry:list')?.({} as IpcMainInvokeEvent)
  assert.deepEqual(list, { success: true, data: rows })

  const update = await handlers.get('agent:registry:updateStatus')?.({} as IpcMainInvokeEvent, {
    id: 'writer',
    status: 'merged',
    mergedIntoAgentId: 'editor',
  })
  assert.deepEqual(updates, [{ id: 'writer', status: 'merged', options: { mergedIntoAgentId: 'editor' } }])
  assert.deepEqual(update, {
    success: true,
    data: record({ id: 'writer', status: 'merged', mergedIntoAgentId: 'editor' }),
  })
})

test('agentRegistryGroup rejects unsupported lifecycle statuses before deps write', async () => {
  const { ipc, handlers } = createMockIpc()
  let writes = 0
  agentRegistryGroup.register(ipc, {
    listAgents: () => [],
    getBeliefCardStore: () => null,
    updateStatus: () => {
      writes += 1
      return record({})
    },
  })
  const result = await handlers.get('agent:registry:updateStatus')?.({} as IpcMainInvokeEvent, {
    id: 'writer',
    status: 'active',
  })
  assert.equal(writes, 0)
  assert.deepEqual(result, {
    success: false,
    error: 'unsupported lifecycle status',
    errorKind: 'input_validation',
  })
})

test('agentRegistryGroup lists agent knowledge and migrates selected cards before merge status update', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'agents/writer/knowledge/style.md',
      frontmatter: fm(),
      body: '短句优先。',
    }).ok)
    const rows = [
      record({ id: 'writer', name: 'Writer', status: 'active' }),
      record({ id: 'editor', name: 'Editor', status: 'active' }),
    ]
    const updates: unknown[] = []
    agentRegistryGroup.register(ipc, {
      listAgents: () => rows,
      getBeliefCardStore: () => store,
      updateStatus: (id, status, options) => {
        updates.push({ id, status, options })
        return record({ id, status, mergedIntoAgentId: options?.mergedIntoAgentId ?? null })
      },
    })

    const knowledge = await handlers.get('agent:registry:listKnowledge')?.({} as IpcMainInvokeEvent, { id: 'writer' })
    assert.deepEqual(knowledge, {
      success: true,
      data: [{
        relPath: 'agents/writer/knowledge/style.md',
        title: '写作经验',
        description: '写作 agent 的经验',
        status: 'active',
      }],
    })

    const update = await handlers.get('agent:registry:updateStatus')?.({} as IpcMainInvokeEvent, {
      id: 'writer',
      status: 'merged',
      mergedIntoAgentId: 'editor',
      migrateCardRelPaths: ['agents/writer/knowledge/style.md'],
    })
    assert.equal((update as { success: boolean }).success, true)
    assert.equal(existsSync(join(root, 'agents', 'writer', 'knowledge', 'style.md')), false)
    assert.ok(store.readCard('agents/editor/knowledge/style.md', { includeStaged: true }))
    assert.deepEqual(updates, [{ id: 'writer', status: 'merged', options: { mergedIntoAgentId: 'editor' } }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
