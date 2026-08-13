import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentRegistryGroup,
  _agentRegistryGroupChannelsForTest,
} from '../main/modules/claude-bridge/ipc/agent-registry-group'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => unknown

function mockIpc() {
  const handlers = new Map<string, Handler>()
  const removed: string[] = []
  const ipc = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel) },
  } as unknown as IpcMain
  return { ipc, handlers, removed }
}

const agent: AgentRegistryRecord = {
  id: 'writer', name: 'Writer', charter: null, personaRef: null, status: 'active',
  parentAgentId: null, derivationReason: null, mergedIntoAgentId: null,
  createdAt: '2026-06-13T00:00:00.000Z',
}

test('agent registry IPC registers only historical read channels', () => {
  const { ipc, handlers, removed } = mockIpc()
  const handle = agentRegistryGroup.register(ipc, {
    listAgents: () => [agent],
    getBeliefCardStore: () => null,
  })
  assert.deepEqual([...handlers.keys()], ['agent:registry:list', 'agent:registry:listKnowledge'])
  assert.deepEqual(_agentRegistryGroupChannelsForTest, ['agent:registry:list', 'agent:registry:listKnowledge'])
  handle.dispose()
  assert.deepEqual(removed.slice(-2), ['agent:registry:list', 'agent:registry:listKnowledge'])
})

test('agent registry IPC lists historical rows and knowledge without mutation channels', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-registry-readonly-'))
  try {
    mkdirSync(join(root, 'agents', 'writer', 'knowledge'), { recursive: true })
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.equal(store.writeCard({
      relPath: 'agents/writer/knowledge/style.md',
      frontmatter: {
        title: '写作经验', description: '短句优先', confidence: 'H', tag: 'knowledge',
        created: '2026-06-13', status: 'active',
      },
      body: '短句优先。',
    }).ok, true)
    const { ipc, handlers } = mockIpc()
    agentRegistryGroup.register(ipc, {
      listAgents: () => [agent],
      getBeliefCardStore: () => store,
    })
    assert.deepEqual(await handlers.get('agent:registry:list')?.({} as IpcMainInvokeEvent), {
      success: true,
      data: [agent],
    })
    const knowledge = await handlers.get('agent:registry:listKnowledge')?.({} as IpcMainInvokeEvent, { id: 'writer' })
    assert.equal((knowledge as { success: boolean }).success, true)
    assert.deepEqual((knowledge as { data: Array<{ relPath: string }> }).data.map((item) => item.relPath), [
      'agents/writer/knowledge/style.md',
    ])
    assert.equal(handlers.has('agent:registry:updateStatus'), false)
    assert.equal(handlers.has('agent:registry:delete'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
