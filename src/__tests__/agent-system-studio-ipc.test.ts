import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentSystemStudioGroup,
  _agentSystemStudioGroupChannelsForTest,
  type AgentSystemStudioGroupDeps,
} from '../main/modules/claude-bridge/ipc/agent-system-studio-group'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { SpecialistContentEditProposalStore } from '../main/modules/agent-control/agents/specialist-content-edit-proposals'

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

test('agentSystemStudioGroup registers and disposes its Studio channels', () => {
  const { ipc, handlers, removeHandlerCalls } = createMockIpc()
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-system-studio-ipc-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const proposalStore = new SpecialistContentEditProposalStore()
    const handle = agentSystemStudioGroup.register(ipc, {
      listAgents: () => [],
      getAgentRegistry: () => ({ get: () => null }),
      getBeliefCardStore: () => store,
      getContentEditProposalStore: () => proposalStore,
    })
    assert.deepEqual([...handlers.keys()].sort(), [..._agentSystemStudioGroupChannelsForTest].sort())
    assert.equal(agentSystemStudioGroup.namespace, 'agent:systemStudio')

    const baseline = removeHandlerCalls.length
    handle.dispose()
    assert.deepEqual(removeHandlerCalls.slice(baseline).sort(), [..._agentSystemStudioGroupChannelsForTest].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agentSystemStudioGroup returns a snapshot through deps without exposing writes', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-system-studio-ipc-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const deps: AgentSystemStudioGroupDeps = {
      listAgents: () => [{
        id: 'butler',
        name: 'Butler',
        charter: '主 agent',
        personaRef: null,
        status: 'active',
        parentAgentId: null,
        derivationReason: null,
        mergedIntoAgentId: null,
        createdAt: '2026-06-19T00:00:00.000Z',
      }],
      getAgentRegistry: () => ({ get: (id) => deps.listAgents().find((agent) => agent.id === id) ?? null }),
      getBeliefCardStore: () => store,
      getContentEditProposalStore: () => new SpecialistContentEditProposalStore(),
    }
    agentSystemStudioGroup.register(ipc, deps)
    const result = await handlers.get('agent:systemStudio:getSnapshot')?.({} as IpcMainInvokeEvent)
    assert.equal((result as { success: boolean }).success, true)
    const snapshot = (result as { data: { agents: Array<{ id: string }> } }).data
    assert.equal(snapshot.agents[0].id, 'butler')
    assert.equal(handlers.has('agent:systemStudio:simulateRouting'), false)
    assert.equal(handlers.has('agent:systemStudio:create'), false)
    assert.equal(handlers.has('agent:systemStudio:transition'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agentSystemStudioGroup stages and confirms content edit proposals through allowlisted channels', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-system-studio-ipc-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const proposalStore = new SpecialistContentEditProposalStore()
    const agents = [{
      id: 'writer',
      name: 'Writer',
      charter: '写作专项',
      personaRef: null,
      status: 'active' as const,
      parentAgentId: 'butler',
      derivationReason: null,
      mergedIntoAgentId: null,
      createdAt: '2026-06-19T00:00:00.000Z',
    }]
    const deps: AgentSystemStudioGroupDeps = {
      listAgents: () => agents,
      getAgentRegistry: () => ({ get: (id) => agents.find((agent) => agent.id === id) ?? null }),
      getBeliefCardStore: () => store,
      getContentEditProposalStore: () => proposalStore,
    }
    agentSystemStudioGroup.register(ipc, deps)

    const staged = await handlers.get('agent:systemStudio:stageContentEdit')?.(
      {} as IpcMainInvokeEvent,
      {
        agentId: 'writer',
        targetKind: 'rules',
        proposedContent: '# Writer\n\n- 每次输出前先列边界。\n',
      },
    )
    assert.equal((staged as { success: boolean }).success, true)
    const proposalId = (staged as { data: { proposalId: string } }).data.proposalId
    assert.ok(proposalId)

    const snapshot = await handlers.get('agent:systemStudio:getSnapshot')?.({} as IpcMainInvokeEvent)
    assert.equal((snapshot as { data: { agents: Array<{ contentSummary: { stagedContentEdits: number } }> } }).data.agents[0].contentSummary.stagedContentEdits, 1)

    const confirmed = await handlers.get('agent:systemStudio:confirmContentEdit')?.(
      {} as IpcMainInvokeEvent,
      { proposalId },
    )
    assert.equal((confirmed as { success: boolean }).success, true)
    assert.equal((confirmed as { data: { status: string } }).data.status, 'applied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
