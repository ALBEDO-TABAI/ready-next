import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { useAgent } = await import('../renderer/stores/useAgent')

function resetStore(): void {
  useAgent.setState({
    agents: [
      { name: 'butler', displayName: '管家', avatar: '🤖', status: 'idle', selected: true },
      { name: 'copywriter', displayName: '文案', avatar: '✍️', status: 'idle', selected: false },
      { name: 'video-editor', displayName: '剪辑', avatar: '🎬', status: 'idle', selected: false },
      { name: 'analyst', displayName: '分析', avatar: '📊', status: 'idle', selected: false },
    ],
    currentAgent: 'butler',
  })
}

function installPersonalityListMock(list: () => Promise<unknown>): void {
  ;(globalThis as any).window.electronAPI = {
    agentPersonality: { list },
  }
}

function installRegistryListMock(listRegistry: () => Promise<unknown>): void {
  ;(globalThis as any).window.electronAPI = {
    agent: { listRegistry },
  }
}

describe('useAgent personality switcher contract', () => {
  beforeEach(() => {
    resetStore()
    ;(globalThis as any).window.electronAPI = undefined
  })

  it('reloadAgents maps agent personalities into the chat switcher', async () => {
    useAgent.setState((state) => ({
      currentAgent: 'analyst',
      agents: state.agents.map((agent) => ({ ...agent, selected: agent.name === 'analyst' })),
    }))
    installPersonalityListMock(async () => ({
      success: true,
      data: [
        {
          id: 'p-designer',
          agentName: 'designer',
          displayName: '设计审稿师',
          personalityText: 'Review design.',
          metaJson: { emoji: '🎨' },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'p-analyst',
          agentName: 'analyst',
          displayName: '分析',
          personalityText: 'Analyze.',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }))

    await useAgent.getState().reloadAgents()

    const state = useAgent.getState()
    assert.deepEqual(state.agents.map((agent) => agent.name), ['designer', 'analyst'])
    assert.equal(state.agents[0].displayName, '设计审稿师')
    assert.equal(state.agents[0].avatar, '🎨')
    assert.equal(state.agents[1].avatar, '🤖')
    assert.equal(state.agents[1].selected, true)
    assert.equal(state.currentAgent, 'analyst')
  })

  it('reloadAgents prefers active registry agents over standalone personalities', async () => {
    useAgent.setState({ currentAgent: 'disabled-writer' })
    installRegistryListMock(async () => ({
      success: true,
      data: [
        { id: 'butler', name: 'Ready', status: 'active' },
        { id: 'campaign-writer', name: '营销文案', status: 'active' },
        { id: 'disabled-writer', name: '停用文案', status: 'disabled' },
        { id: 'merged-writer', name: '已合并文案', status: 'merged' },
      ],
    }))

    await useAgent.getState().reloadAgents()

    const state = useAgent.getState()
    assert.deepEqual(state.agents.map((agent) => agent.name), ['butler', 'campaign-writer'])
    assert.equal(state.agents[0].displayName, 'Ready')
    assert.equal(state.agents[1].displayName, '营销文案')
    assert.equal(state.currentAgent, 'butler')
  })

  it('reloadAgents falls back to built-in agents when the personality list is empty or fails', async () => {
    useAgent.setState({ currentAgent: 'missing-agent' })
    installPersonalityListMock(async () => ({ success: true, data: [] }))

    await useAgent.getState().reloadAgents()

    assert.deepEqual(
      useAgent.getState().agents.map((agent) => agent.name),
      ['butler', 'copywriter', 'video-editor', 'analyst'],
    )
    assert.equal(useAgent.getState().currentAgent, 'butler')

    useAgent.setState({ agents: [], currentAgent: 'missing-agent' })
    installPersonalityListMock(async () => {
      throw new Error('offline')
    })

    await useAgent.getState().reloadAgents()

    assert.deepEqual(
      useAgent.getState().agents.map((agent) => agent.name),
      ['butler', 'copywriter', 'video-editor', 'analyst'],
    )
    assert.equal(useAgent.getState().currentAgent, 'butler')
  })
})
