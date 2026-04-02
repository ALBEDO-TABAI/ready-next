import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'

// ============================================================
// Browser API Mocks (must be installed before importing stores)
// ============================================================

const storage = new Map<string, string>()

const localStorageMock = {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => { storage.clear() },
    get length() { return storage.size },
    key: (index: number): string | null => [...storage.keys()][index] ?? null,
}

let prefersDark = false

const matchMediaMock = (query: string) => ({
    get matches() { return query === '(prefers-color-scheme: dark)' ? prefersDark : false },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_event: string, _cb: () => void) => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
})

const documentAttributes = new Map<string, string>()
const documentMock = {
    documentElement: {
        setAttribute: (name: string, value: string) => { documentAttributes.set(name, value) },
        getAttribute: (name: string) => documentAttributes.get(name) ?? null,
    },
}

let lastClipboardText: string | null = null
const navigatorMock = {
    clipboard: {
        writeText: async (text: string) => { lastClipboardText = text },
    },
}

// Install mocks on globalThis so they are accessible as global variables
;(globalThis as any).localStorage = localStorageMock
;(globalThis as any).document = documentMock
// navigator is read-only in Node 22+, so we override clipboard via defineProperty
try {
    ;(globalThis as any).navigator = navigatorMock
} catch {
    Object.defineProperty(globalThis, 'navigator', {
        value: navigatorMock,
        writable: true,
        configurable: true,
    })
}
;(globalThis as any).matchMedia = matchMediaMock

// Ensure `window` exists (self-referencing like in browsers)
if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = globalThis
}
;(globalThis as any).window.matchMedia = matchMediaMock
;(globalThis as any).window.electronAPI = undefined

// ============================================================
// Dynamic imports of Zustand stores (after mocks are installed)
// ============================================================

const { useMode } = await import('../renderer/stores/useMode')
const { useDocTabs } = await import('../renderer/stores/useDocTabs')
const { useAgent } = await import('../renderer/stores/useAgent')
const { useWorkspace } = await import('../renderer/stores/useWorkspace')
const { useTheme } = await import('../renderer/stores/useTheme')
const { useRSSSession } = await import('../renderer/stores/useRSSSession')

// ============================================================
// Existing Type Validation Tests (preserved from original)
// ============================================================

describe('Mode Store Types', () => {
    it('should have valid WorkbenchMode values', () => {
        const validModes = ['browser', 'document', 'rss', 'calendar']
        validModes.forEach(mode => {
            assert.strictEqual(typeof mode, 'string')
            assert.ok(mode.length > 0)
        })
    })

    it('should have valid AppMode values', () => {
        const validAppModes = ['workbench', 'ready']
        validAppModes.forEach(mode => {
            assert.strictEqual(typeof mode, 'string')
        })
    })
})

describe('Workspace Store Types', () => {
    it('should validate FileItem structure', () => {
        const fileItem = {
            name: 'readme.md',
            path: '/workspace/readme.md',
            isDirectory: false,
            size: 1024,
            modified: new Date()
        }
        assert.strictEqual(typeof fileItem.name, 'string')
        assert.strictEqual(typeof fileItem.path, 'string')
        assert.strictEqual(typeof fileItem.isDirectory, 'boolean')
        assert.strictEqual(typeof fileItem.size, 'number')
    })

    it('should handle directory FileItem', () => {
        const dirItem = {
            name: 'src',
            path: '/workspace/src',
            isDirectory: true,
            size: 0,
            modified: new Date()
        }
        assert.ok(dirItem.isDirectory)
        assert.strictEqual(dirItem.size, 0)
    })
})

describe('Agent Store Types', () => {
    it('should validate Agent structure', () => {
        const agent = {
            name: 'butler',
            status: 'idle' as const,
            task: undefined,
            isMock: false,
            spawnTime: Date.now()
        }
        assert.strictEqual(typeof agent.name, 'string')
        assert.strictEqual(agent.status, 'idle')
        assert.strictEqual(typeof agent.isMock, 'boolean')
    })

    it('should validate AgentMessage structure', () => {
        const message = {
            id: `msg-${Date.now()}`,
            agent: 'butler',
            content: 'Hello, world!',
            type: 'stdout' as const,
            timestamp: Date.now()
        }
        assert.strictEqual(typeof message.id, 'string')
        assert.ok(message.id.startsWith('msg-'))
        assert.strictEqual(typeof message.content, 'string')
    })

    it('should handle all agent status values', () => {
        const validStatuses = ['idle', 'working', 'done', 'error', 'timeout']
        validStatuses.forEach(status => {
            assert.strictEqual(typeof status, 'string')
            assert.ok(validStatuses.includes(status))
        })
    })

})

describe('Store Utilities', () => {
    it('should format message ID correctly', () => {
        const id = `msg-${Date.now()}`
        assert.ok(id.startsWith('msg-'))
        assert.ok(id.length > 4)
    })

    it('should handle path operations', () => {
        const path = '/workspace/src/main/index.ts'
        const parts = path.split('/')
        assert.strictEqual(parts[parts.length - 1], 'index.ts')
        assert.strictEqual(parts[1], 'workspace')
    })
})

// ============================================================
// useMode Store Tests
// ============================================================

describe('useMode Store', () => {
    beforeEach(() => {
        useMode.setState({
            appMode: 'workbench',
            workbenchMode: 'browser',
            splitMode: null,
            readySubMode: 'browser',
        })
    })

    it('should have correct default state', () => {
        const state = useMode.getState()
        assert.strictEqual(state.appMode, 'workbench')
        assert.strictEqual(state.workbenchMode, 'browser')
        assert.strictEqual(state.splitMode, null)
        assert.strictEqual(state.readySubMode, 'browser')
    })

    it('should set appMode to ready', () => {
        useMode.getState().setAppMode('ready')
        assert.strictEqual(useMode.getState().appMode, 'ready')
    })

    it('should set appMode to workbench', () => {
        useMode.getState().setAppMode('ready')
        useMode.getState().setAppMode('workbench')
        assert.strictEqual(useMode.getState().appMode, 'workbench')
    })

    it('should set each valid workbenchMode', () => {
        const modes: Array<'browser' | 'document' | 'rss' | 'calendar'> =
            ['browser', 'document', 'rss', 'calendar']
        for (const mode of modes) {
            useMode.getState().setWorkbenchMode(mode)
            assert.strictEqual(useMode.getState().workbenchMode, mode)
        }
    })

    it('should clear splitMode when setting workbenchMode', () => {
        useMode.getState().setSplitMode('document')
        assert.strictEqual(useMode.getState().splitMode, 'document')
        useMode.getState().setWorkbenchMode('rss')
        assert.strictEqual(useMode.getState().workbenchMode, 'rss')
        assert.strictEqual(useMode.getState().splitMode, null)
    })

    it('should set and clear splitMode', () => {
        useMode.getState().setSplitMode('rss')
        assert.strictEqual(useMode.getState().splitMode, 'rss')
        useMode.getState().setSplitMode(null)
        assert.strictEqual(useMode.getState().splitMode, null)
    })

    it('should set readySubMode', () => {
        useMode.getState().setReadySubMode('calendar')
        assert.strictEqual(useMode.getState().readySubMode, 'calendar')
        useMode.getState().setReadySubMode('document')
        assert.strictEqual(useMode.getState().readySubMode, 'document')
    })

    it('should toggle between workbench and ready', () => {
        assert.strictEqual(useMode.getState().appMode, 'workbench')
        useMode.getState().toggleMode()
        assert.strictEqual(useMode.getState().appMode, 'ready')
        useMode.getState().toggleMode()
        assert.strictEqual(useMode.getState().appMode, 'workbench')
    })

    it('should allow splitMode to be different from workbenchMode', () => {
        useMode.getState().setWorkbenchMode('browser')
        useMode.getState().setSplitMode('document')
        const state = useMode.getState()
        assert.strictEqual(state.workbenchMode, 'browser')
        assert.strictEqual(state.splitMode, 'document')
        assert.notStrictEqual(state.workbenchMode, state.splitMode)
    })
})

describe('useRSSSession Store', () => {
    beforeEach(() => {
        useRSSSession.getState().reset()
    })

    it('should allow clearing selected fields back to null', () => {
        useRSSSession.getState().setSelection({
            selectedSourceId: 'source-1',
            selectedItemId: 'item-1',
            selectedItemTitle: 'Title 1',
        })
        assert.strictEqual(useRSSSession.getState().selectedSourceId, 'source-1')
        assert.strictEqual(useRSSSession.getState().selectedItemId, 'item-1')
        assert.strictEqual(useRSSSession.getState().selectedItemTitle, 'Title 1')

        useRSSSession.getState().setSelection({
            selectedSourceId: null,
            selectedItemId: null,
            selectedItemTitle: null,
        })
        assert.strictEqual(useRSSSession.getState().selectedSourceId, null)
        assert.strictEqual(useRSSSession.getState().selectedItemId, null)
        assert.strictEqual(useRSSSession.getState().selectedItemTitle, null)
    })

    it('should allow explicitly clearing lastFetchAt', () => {
        useRSSSession.getState().setFeedSnapshot({
            totalItems: 12,
            unreadItems: 4,
            lastFetchAt: 123456,
        })
        assert.strictEqual(useRSSSession.getState().lastFetchAt, 123456)

        useRSSSession.getState().setFeedSnapshot({
            lastFetchAt: null,
        })
        assert.strictEqual(useRSSSession.getState().lastFetchAt, null)
        assert.strictEqual(useRSSSession.getState().totalItems, 12)
        assert.strictEqual(useRSSSession.getState().unreadItems, 4)
    })
})

// ============================================================
// useDocTabs Store Tests
// ============================================================

describe('useDocTabs Store', () => {
    beforeEach(() => {
        // Reset to a known state with a single blank tab
        useDocTabs.setState({
            tabs: [{ id: 'reset-tab', path: null, title: '新文档', content: '', isDirty: false }],
            activeTabId: 'reset-tab',
            splitTabId: null,
            splitRatio: 50,
        })
    })

    it('should have initial state with one tab', () => {
        const state = useDocTabs.getState()
        assert.strictEqual(state.tabs.length, 1)
        assert.strictEqual(state.activeTabId, 'reset-tab')
        assert.strictEqual(state.splitTabId, null)
        assert.strictEqual(state.splitRatio, 50)
    })

    it('should open a new tab by file path', () => {
        useDocTabs.getState().openTab('/workspace/readme.md')
        const state = useDocTabs.getState()
        assert.strictEqual(state.tabs.length, 2)
        const newTab = state.tabs[1]
        assert.strictEqual(newTab.path, '/workspace/readme.md')
        assert.strictEqual(newTab.title, 'readme.md')
        assert.strictEqual(newTab.isDirty, false)
        assert.strictEqual(newTab.content, '')
        // New tab should be active
        assert.strictEqual(state.activeTabId, newTab.id)
    })

    it('should activate existing tab when opening same path', () => {
        useDocTabs.getState().openTab('/workspace/readme.md')
        const firstOpenState = useDocTabs.getState()
        const tabId = firstOpenState.tabs[1].id

        // Open another tab
        useDocTabs.getState().openTab('/workspace/other.md')
        assert.strictEqual(useDocTabs.getState().tabs.length, 3)

        // Re-open the first file - should not create a new tab
        useDocTabs.getState().openTab('/workspace/readme.md')
        const state = useDocTabs.getState()
        assert.strictEqual(state.tabs.length, 3)
        assert.strictEqual(state.activeTabId, tabId)
    })

    it('should open a blank tab when path is empty', () => {
        useDocTabs.getState().openTab('')
        const state = useDocTabs.getState()
        assert.strictEqual(state.tabs.length, 2)
        const newTab = state.tabs[1]
        assert.strictEqual(newTab.path, null)
        assert.strictEqual(newTab.title, '新文档')
    })

    it('should close a non-active tab without changing active', () => {
        useDocTabs.getState().openTab('/workspace/file1.md')
        const state1 = useDocTabs.getState()
        const secondTabId = state1.tabs[1].id

        // Active is the second tab (openTab activates it)
        assert.strictEqual(state1.activeTabId, secondTabId)

        // Close the first (non-active) tab
        useDocTabs.getState().closeTab('reset-tab')
        const state2 = useDocTabs.getState()
        assert.strictEqual(state2.tabs.length, 1)
        assert.strictEqual(state2.activeTabId, secondTabId)
    })

    it('should switch to neighbor when closing active tab', () => {
        useDocTabs.getState().openTab('/workspace/file1.md')
        useDocTabs.getState().openTab('/workspace/file2.md')
        const state = useDocTabs.getState()
        // 3 tabs: reset-tab, file1, file2. file2 is active.
        const activeId = state.activeTabId
        const file2Tab = state.tabs[2]
        assert.strictEqual(activeId, file2Tab.id)

        // Close active tab (file2)
        useDocTabs.getState().closeTab(activeId)
        const stateAfter = useDocTabs.getState()
        assert.strictEqual(stateAfter.tabs.length, 2)
        // Should switch to neighbor
        assert.ok(stateAfter.tabs.some(t => t.id === stateAfter.activeTabId))
    })

    it('should create a new blank tab when closing the last tab', () => {
        // Close the only tab
        useDocTabs.getState().closeTab('reset-tab')
        const state = useDocTabs.getState()
        assert.strictEqual(state.tabs.length, 1)
        assert.strictEqual(state.tabs[0].path, null)
        assert.strictEqual(state.tabs[0].title, '新文档')
        assert.strictEqual(state.activeTabId, state.tabs[0].id)
        assert.strictEqual(state.splitTabId, null)
    })

    it('should set active tab and clear split', () => {
        useDocTabs.getState().openTab('/workspace/file1.md')
        const tabId = useDocTabs.getState().tabs[0].id
        useDocTabs.getState().setSplitTab('some-tab')

        useDocTabs.getState().setActiveTab(tabId)
        const state = useDocTabs.getState()
        assert.strictEqual(state.activeTabId, tabId)
        assert.strictEqual(state.splitTabId, null)
    })

    it('should update tab content and mark as dirty', () => {
        useDocTabs.getState().updateTabContent('reset-tab', 'Hello World')
        const state = useDocTabs.getState()
        const tab = state.tabs.find(t => t.id === 'reset-tab')
        assert.ok(tab)
        assert.strictEqual(tab.content, 'Hello World')
        assert.strictEqual(tab.isDirty, true)
    })

    it('should mark tab as saved (clear dirty flag)', () => {
        useDocTabs.getState().updateTabContent('reset-tab', 'content')
        assert.strictEqual(useDocTabs.getState().tabs[0].isDirty, true)

        useDocTabs.getState().markTabSaved('reset-tab')
        assert.strictEqual(useDocTabs.getState().tabs[0].isDirty, false)
    })

    it('should reorder tabs', () => {
        useDocTabs.getState().openTab('/workspace/a.md')
        useDocTabs.getState().openTab('/workspace/b.md')
        // tabs: [reset-tab, a.md, b.md]
        const before = useDocTabs.getState().tabs.map(t => t.path)
        assert.deepStrictEqual(before, [null, '/workspace/a.md', '/workspace/b.md'])

        // Move first tab to last position
        useDocTabs.getState().reorderTabs(0, 2)
        const after = useDocTabs.getState().tabs.map(t => t.path)
        assert.deepStrictEqual(after, ['/workspace/a.md', '/workspace/b.md', null])
    })

    it('should set split tab', () => {
        useDocTabs.getState().openTab('/workspace/file1.md')
        const tabId = useDocTabs.getState().tabs[1].id
        useDocTabs.getState().setSplitTab(tabId)
        assert.strictEqual(useDocTabs.getState().splitTabId, tabId)

        useDocTabs.getState().setSplitTab(null)
        assert.strictEqual(useDocTabs.getState().splitTabId, null)
    })

    it('should clamp split ratio between 20 and 80', () => {
        useDocTabs.getState().setSplitRatio(50)
        assert.strictEqual(useDocTabs.getState().splitRatio, 50)

        useDocTabs.getState().setSplitRatio(10)
        assert.strictEqual(useDocTabs.getState().splitRatio, 20)

        useDocTabs.getState().setSplitRatio(90)
        assert.strictEqual(useDocTabs.getState().splitRatio, 80)

        useDocTabs.getState().setSplitRatio(20)
        assert.strictEqual(useDocTabs.getState().splitRatio, 20)

        useDocTabs.getState().setSplitRatio(80)
        assert.strictEqual(useDocTabs.getState().splitRatio, 80)
    })

    it('should clear split when closing the split tab', () => {
        useDocTabs.getState().openTab('/workspace/split.md')
        const splitId = useDocTabs.getState().tabs[1].id
        useDocTabs.getState().setSplitTab(splitId)
        assert.strictEqual(useDocTabs.getState().splitTabId, splitId)

        useDocTabs.getState().closeTab(splitId)
        assert.strictEqual(useDocTabs.getState().splitTabId, null)
    })

    it('should extract filename from path as tab title', () => {
        useDocTabs.getState().openTab('/a/b/c/deep-file.tsx')
        const tab = useDocTabs.getState().tabs[1]
        assert.strictEqual(tab.title, 'deep-file.tsx')
    })
})

// ============================================================
// useAgent Store Tests
// ============================================================

describe('useAgent Store', () => {
    beforeEach(() => {
        ;(globalThis as any).window.electronAPI = undefined
        useAgent.setState({
            agents: [
                { name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true },
                { name: 'copywriter', displayName: '文案', avatar: '', status: 'idle', selected: false },
                { name: 'video-editor', displayName: '剪辑', avatar: '', status: 'idle', selected: false },
                { name: 'analyst', displayName: '分析', avatar: '', status: 'idle', selected: false },
            ],
            messages: [],
            currentAgent: 'butler',
            currentScopeId: null,
            currentScope: null,
            scopes: [],
            inputValue: '',
            isStreaming: false,
            streamingMessageId: null,
            streamingRequestId: null,
            conversations: [],
            conversationId: null,
            attachments: [],
            filePool: [],
        })
    })

    it('should have correct default agents', () => {
        const state = useAgent.getState()
        assert.strictEqual(state.agents.length, 4)
        assert.strictEqual(state.agents[0].name, 'butler')
        assert.strictEqual(state.agents[0].selected, true)
        assert.strictEqual(state.currentAgent, 'butler')
    })

    it('should select a different agent', () => {
        useAgent.getState().selectAgent('copywriter')
        assert.strictEqual(useAgent.getState().currentAgent, 'copywriter')
    })

    it('should toggle agent selection', () => {
        // butler starts selected
        assert.strictEqual(useAgent.getState().agents[0].selected, true)
        useAgent.getState().toggleAgentSelection('butler')
        assert.strictEqual(useAgent.getState().agents[0].selected, false)
        useAgent.getState().toggleAgentSelection('butler')
        assert.strictEqual(useAgent.getState().agents[0].selected, true)
    })

    it('should toggle selection for non-selected agent', () => {
        assert.strictEqual(useAgent.getState().agents[1].selected, false)
        useAgent.getState().toggleAgentSelection('copywriter')
        assert.strictEqual(useAgent.getState().agents[1].selected, true)
    })

    it('should add a message', () => {
        const msg = {
            id: 'test-msg-1',
            agent: 'butler',
            content: 'Hello test',
            type: 'user' as const,
            timestamp: new Date(),
        }
        useAgent.getState().addMessage(msg)
        const state = useAgent.getState()
        assert.strictEqual(state.messages.length, 1)
        assert.strictEqual(state.messages[0].id, 'test-msg-1')
        assert.strictEqual(state.messages[0].content, 'Hello test')
        assert.strictEqual(state.messages[0].type, 'user')
    })

    it('should add multiple messages in order', () => {
        const msg1 = { id: 'm1', agent: 'butler', content: 'First', type: 'user' as const, timestamp: new Date() }
        const msg2 = { id: 'm2', agent: 'butler', content: 'Second', type: 'agent' as const, timestamp: new Date() }
        const msg3 = { id: 'm3', agent: 'butler', content: 'Third', type: 'system' as const, timestamp: new Date() }
        useAgent.getState().addMessage(msg1)
        useAgent.getState().addMessage(msg2)
        useAgent.getState().addMessage(msg3)
        const msgs = useAgent.getState().messages
        assert.strictEqual(msgs.length, 3)
        assert.strictEqual(msgs[0].content, 'First')
        assert.strictEqual(msgs[1].content, 'Second')
        assert.strictEqual(msgs[2].content, 'Third')
    })

    it('should append content to an existing message', () => {
        useAgent.getState().addMessage({
            id: 'stream-1',
            agent: 'butler',
            content: 'Hello',
            type: 'agent',
            timestamp: new Date(),
        })
        useAgent.getState().appendToMessage('stream-1', ' World')
        useAgent.getState().appendToMessage('stream-1', '!')
        const msg = useAgent.getState().messages[0]
        assert.strictEqual(msg.content, 'Hello World!')
    })

    it('should not modify other messages when appending', () => {
        useAgent.getState().addMessage({ id: 'a', agent: 'butler', content: 'AAA', type: 'user', timestamp: new Date() })
        useAgent.getState().addMessage({ id: 'b', agent: 'butler', content: 'BBB', type: 'agent', timestamp: new Date() })
        useAgent.getState().appendToMessage('b', ' appended')
        const msgs = useAgent.getState().messages
        assert.strictEqual(msgs[0].content, 'AAA')
        assert.strictEqual(msgs[1].content, 'BBB appended')
    })

    it('should set input value', () => {
        useAgent.getState().setInputValue('test input')
        assert.strictEqual(useAgent.getState().inputValue, 'test input')
        useAgent.getState().setInputValue('')
        assert.strictEqual(useAgent.getState().inputValue, '')
    })

    it('should set streaming state', () => {
        assert.strictEqual(useAgent.getState().isStreaming, false)
        useAgent.getState().setIsStreaming(true)
        assert.strictEqual(useAgent.getState().isStreaming, true)
        useAgent.getState().setIsStreaming(false)
        assert.strictEqual(useAgent.getState().isStreaming, false)
    })

    it('should replace all agents with setAgents', () => {
        const newAgents = [
            { name: 'custom', displayName: 'Custom', avatar: '', status: 'idle' as const, selected: true },
        ]
        useAgent.getState().setAgents(newAgents)
        const state = useAgent.getState()
        assert.strictEqual(state.agents.length, 1)
        assert.strictEqual(state.agents[0].name, 'custom')
    })

    it('should handle appendToMessage with non-existent id gracefully', () => {
        useAgent.getState().addMessage({ id: 'exists', agent: 'butler', content: 'OK', type: 'user', timestamp: new Date() })
        // Appending to a non-existent ID should not throw, just no-op
        useAgent.getState().appendToMessage('does-not-exist', 'chunk')
        assert.strictEqual(useAgent.getState().messages[0].content, 'OK')
    })

    it('should load scoped messages and sync current scope metadata', async () => {
        ;(globalThis as any).window.electronAPI = {
            agent: {
                getConversationScopeMessages: async (_scopeId: string) => ({
                    success: true,
                    data: [
                        {
                            id: 'remote-msg-1',
                            role: 'assistant',
                            content: '飞书线程里的回复',
                            timestamp: '2026-03-06T10:00:00.000Z',
                            meta: { direction: 'outbound' },
                        },
                    ],
                }),
            },
        }

        useAgent.setState({
            scopes: [
                {
                    id: 'scope-feishu-1',
                    agent: 'butler',
                    title: '飞书 · 张三',
                    sourceKind: 'channel',
                    sourceId: 'channel-feishu-default',
                    threadKey: 'om_xxx',
                    meta: { sourceLabel: '飞书', sender: '张三' },
                    createdAt: '2026-03-06T09:59:00.000Z',
                    updatedAt: '2026-03-06T10:00:00.000Z',
                    lastMessageAt: '2026-03-06T10:00:00.000Z',
                },
            ],
        })

        await useAgent.getState().loadScope('scope-feishu-1')

        const state = useAgent.getState()
        assert.strictEqual(state.currentScopeId, 'scope-feishu-1')
        assert.strictEqual(state.currentScope?.sourceKind, 'channel')
        assert.strictEqual(state.currentAgent, 'butler')
        assert.strictEqual(state.messages.length, 1)
        assert.strictEqual(state.messages[0].content, '飞书线程里的回复')
        assert.strictEqual(state.messages[0].type, 'agent')
    })

    it('should merge remote conversation events into scopes and active messages', async () => {
        const listeners: {
            onConversationEvent?: (data: unknown) => void
        } = {}

        ;(globalThis as any).window.electronAPI = {
            agent: {
                onStream: () => () => {},
                onStatusChange: () => () => {},
                onError: () => () => {},
                onToolAction: () => () => {},
                onConversationEvent: (cb: (data: unknown) => void) => {
                    listeners.onConversationEvent = cb
                    return () => { listeners.onConversationEvent = undefined }
                },
            },
        }

        const cleanup = (await import('../renderer/stores/useAgent')).initAgentListeners()

        useAgent.setState({
            currentScopeId: 'scope-feishu-2',
            currentScope: {
                id: 'scope-feishu-2',
                agent: 'butler',
                title: '飞书 · 李四',
                sourceKind: 'channel',
                sourceId: 'channel-feishu-default',
                threadKey: 'om_yyy',
                meta: { sourceLabel: '飞书', sender: '李四' },
                createdAt: '2026-03-06T10:00:00.000Z',
                updatedAt: '2026-03-06T10:00:00.000Z',
                lastMessageAt: null,
            },
            scopes: [],
            messages: [],
        })

        listeners.onConversationEvent?.({
            type: 'message_added',
            scope: {
                id: 'scope-feishu-2',
                agent: 'butler',
                title: '飞书 · 李四',
                sourceKind: 'channel',
                sourceId: 'channel-feishu-default',
                threadKey: 'om_yyy',
                meta: { sourceLabel: '飞书', sender: '李四' },
                createdAt: '2026-03-06T10:00:00.000Z',
                updatedAt: '2026-03-06T10:01:00.000Z',
                lastMessageAt: '2026-03-06T10:01:00.000Z',
            },
            message: {
                id: 'feishu-msg-2',
                role: 'user',
                content: '飞书过来的最新消息',
                timestamp: '2026-03-06T10:01:00.000Z',
                meta: { direction: 'inbound' },
            },
        })

        const state = useAgent.getState()
        assert.strictEqual(state.scopes.length, 1)
        assert.strictEqual(state.scopes[0].id, 'scope-feishu-2')
        assert.strictEqual(state.messages.length, 1)
        assert.strictEqual(state.messages[0].content, '飞书过来的最新消息')
        assert.strictEqual(state.messages[0].type, 'user')

        cleanup()
    })

    it('should keep streaming chunks keyed by runId and scopeId even after switching active scope', async () => {
        const listeners: {
            onStream?: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void
            onStatusChange?: (data: unknown) => void
            onError?: (data: unknown) => void
            onToolAction?: (data: unknown) => void
            onScopeRunEvent?: (data: unknown) => void
            onConversationEvent?: (data: unknown) => void
        } = {}

        ;(globalThis as any).window.electronAPI = {
            agent: {
                onStream: (cb: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void) => {
                    listeners.onStream = cb
                    return () => { listeners.onStream = undefined }
                },
                onStatusChange: (cb: (data: unknown) => void) => {
                    listeners.onStatusChange = cb
                    return () => { listeners.onStatusChange = undefined }
                },
                onError: (cb: (data: unknown) => void) => {
                    listeners.onError = cb
                    return () => { listeners.onError = undefined }
                },
                onToolAction: (cb: (data: unknown) => void) => {
                    listeners.onToolAction = cb
                    return () => { listeners.onToolAction = undefined }
                },
                onScopeRunEvent: (cb: (data: unknown) => void) => {
                    listeners.onScopeRunEvent = cb
                    return () => { listeners.onScopeRunEvent = undefined }
                },
                onConversationEvent: (cb: (data: unknown) => void) => {
                    listeners.onConversationEvent = cb
                    return () => { listeners.onConversationEvent = undefined }
                },
            },
        }

        const cleanup = (await import('../renderer/stores/useAgent')).initAgentListeners()

        useAgent.setState({
            currentScopeId: 'scope-b',
            currentScope: {
                id: 'scope-b',
                agent: 'copywriter',
                title: 'Scope B',
                sourceKind: 'local',
                sourceId: 'app',
                threadKey: 'scope-b',
                meta: {},
                createdAt: '2026-03-07T10:00:00.000Z',
                updatedAt: '2026-03-07T10:00:00.000Z',
            },
            scopes: [
                {
                    id: 'scope-a',
                    agent: 'butler',
                    title: 'Scope A',
                    sourceKind: 'local',
                    sourceId: 'app',
                    threadKey: 'scope-a',
                    meta: {},
                    createdAt: '2026-03-07T09:00:00.000Z',
                    updatedAt: '2026-03-07T09:00:00.000Z',
                },
                {
                    id: 'scope-b',
                    agent: 'copywriter',
                    title: 'Scope B',
                    sourceKind: 'local',
                    sourceId: 'app',
                    threadKey: 'scope-b',
                    meta: {},
                    createdAt: '2026-03-07T10:00:00.000Z',
                    updatedAt: '2026-03-07T10:00:00.000Z',
                },
            ],
            messages: [],
            scopeRunStates: {
                'scope-a': {
                    scopeId: 'scope-a',
                    agent: 'butler',
                    requestId: 'req-a',
                    phase: 'planning',
                    toolTrace: [],
                    startedAt: '2026-03-07T09:00:00.000Z',
                    updatedAt: '2026-03-07T09:00:00.000Z',
                    latestText: null,
                    blockedReason: null,
                    controllerId: null,
                    ownerTabId: null,
                    checkpointExpiresAt: null,
                    responseMessageId: 'msg-a',
                    responseBuffer: '',
                    stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
                    error: null,
                },
            },
        })

        listeners.onStream?.({
            agent: 'butler',
            sessionId: 'scope-a',
            runId: 'req-a',
            chunk: '后台流式输出',
            type: 'text',
        })

        const state = useAgent.getState()
        assert.strictEqual(state.currentScopeId, 'scope-b')
        assert.strictEqual(state.scopeRunStates['scope-a']?.responseBuffer, '后台流式输出')
        assert.strictEqual(state.scopeRunStates['scope-a']?.latestText, '后台流式输出')

        cleanup()
    })

})

// ============================================================
// useWorkspace Store Tests
// ============================================================

describe('useWorkspace Store', () => {
    beforeEach(() => {
        storage.clear()
        lastClipboardText = null
        ;(globalThis as any).window.electronAPI = undefined
        useWorkspace.setState({
            workspaceRoot: null,
            currentPath: '/',
            files: [],
            selectedFile: null,
            expandedDirs: new Set<string>(),
            dirChildren: new Map(),
            pinnedFolders: [],
            sidebarVisible: true,
            sidePanelVariant: 'files',
            sidePanelWidths: { files: 220, search: 220, skills: 220 },
            skillsSplitRatio: 0.5,
            chatPanelVisible: true,
            chatPanelWidth: 380,
            renamingPath: null,
            creatingType: null,
        })
    })

    it('should have correct default state', () => {
        const state = useWorkspace.getState()
        assert.strictEqual(state.workspaceRoot, null)
        assert.strictEqual(state.currentPath, '/')
        assert.deepStrictEqual(state.files, [])
        assert.strictEqual(state.selectedFile, null)
        assert.strictEqual(state.pinnedFolders.length, 0)
        assert.strictEqual(state.sidebarVisible, true)
        assert.strictEqual(state.chatPanelVisible, true)
    })

    it('should add a pinned folder', () => {
        useWorkspace.getState().addPinnedFolder('/Users/test/project')
        const state = useWorkspace.getState()
        assert.deepStrictEqual(state.pinnedFolders, ['/Users/test/project'])
        // Should persist to localStorage
        const stored = JSON.parse(storage.get('ready-pinned-folders') || '[]')
        assert.deepStrictEqual(stored, ['/Users/test/project'])
    })

    it('should not add duplicate pinned folder', () => {
        useWorkspace.getState().addPinnedFolder('/Users/test/project')
        useWorkspace.getState().addPinnedFolder('/Users/test/project')
        assert.strictEqual(useWorkspace.getState().pinnedFolders.length, 1)
    })

    it('should add multiple distinct pinned folders', () => {
        useWorkspace.getState().addPinnedFolder('/folder-a')
        useWorkspace.getState().addPinnedFolder('/folder-b')
        useWorkspace.getState().addPinnedFolder('/folder-c')
        assert.deepStrictEqual(useWorkspace.getState().pinnedFolders, ['/folder-a', '/folder-b', '/folder-c'])
    })

    it('should remove a pinned folder', () => {
        useWorkspace.getState().addPinnedFolder('/folder-a')
        useWorkspace.getState().addPinnedFolder('/folder-b')
        useWorkspace.getState().removePinnedFolder('/folder-a')
        assert.deepStrictEqual(useWorkspace.getState().pinnedFolders, ['/folder-b'])
        const stored = JSON.parse(storage.get('ready-pinned-folders') || '[]')
        assert.deepStrictEqual(stored, ['/folder-b'])
    })

    it('should handle removing non-existent pinned folder gracefully', () => {
        useWorkspace.getState().addPinnedFolder('/exists')
        useWorkspace.getState().removePinnedFolder('/does-not-exist')
        assert.deepStrictEqual(useWorkspace.getState().pinnedFolders, ['/exists'])
    })

    it('should select and deselect a file', () => {
        useWorkspace.getState().selectFile('/workspace/readme.md')
        assert.strictEqual(useWorkspace.getState().selectedFile, '/workspace/readme.md')
        useWorkspace.getState().selectFile(null)
        assert.strictEqual(useWorkspace.getState().selectedFile, null)
    })

    it('should toggle sidebar visibility', () => {
        assert.strictEqual(useWorkspace.getState().sidebarVisible, true)
        useWorkspace.getState().toggleSidebar()
        assert.strictEqual(useWorkspace.getState().sidebarVisible, false)
        useWorkspace.getState().toggleSidebar()
        assert.strictEqual(useWorkspace.getState().sidebarVisible, true)
    })

    it('should set and clamp side panel width by variant', () => {
        const store = useWorkspace.getState()
        store.setSidePanelWidth('skills', 360)
        assert.strictEqual(useWorkspace.getState().sidePanelWidths.shared, 360)
        store.setSidePanelWidth('search', 100)
        assert.strictEqual(useWorkspace.getState().sidePanelWidths.shared, 220)
        store.setSidePanelWidth('files', 999)
        assert.strictEqual(useWorkspace.getState().sidePanelWidths.shared, 420)

        const persisted = JSON.parse(storage.get('ready-side-panel-widths-v2') || '{}')
        assert.strictEqual(persisted.shared, 420)
    })

    it('should set and persist skills split ratio with clamp', () => {
        const store = useWorkspace.getState()
        store.setSkillsSplitRatio(0.6)
        assert.strictEqual(useWorkspace.getState().skillsSplitRatio, 0.6)
        store.setSkillsSplitRatio(0.01)
        assert.strictEqual(useWorkspace.getState().skillsSplitRatio, 0.25)
        store.setSkillsSplitRatio(0.99)
        assert.strictEqual(useWorkspace.getState().skillsSplitRatio, 0.75)
        assert.strictEqual(storage.get('ready-skills-split-ratio-v2'), '0.75')
    })

    it('should toggle chat panel visibility', () => {
        assert.strictEqual(useWorkspace.getState().chatPanelVisible, true)
        useWorkspace.getState().toggleChatPanel()
        assert.strictEqual(useWorkspace.getState().chatPanelVisible, false)
        useWorkspace.getState().toggleChatPanel()
        assert.strictEqual(useWorkspace.getState().chatPanelVisible, true)
    })

    it('should set workspace root and update currentPath', () => {
        useWorkspace.getState().setWorkspaceRoot('/Users/test/project')
        const state = useWorkspace.getState()
        assert.strictEqual(state.workspaceRoot, '/Users/test/project')
        assert.strictEqual(state.currentPath, '/Users/test/project')
        assert.strictEqual(state.selectedFile, null)
        // Should persist to localStorage
        assert.strictEqual(storage.get('ready-workspace-root'), '/Users/test/project')
    })

    it('should set workspace root and populate mock files', () => {
        useWorkspace.getState().setWorkspaceRoot('/project')
        const state = useWorkspace.getState()
        // refreshFiles() mock mode populates 7 items
        assert.ok(state.files.length > 0)
    })

    it('should clear workspace completely', () => {
        useWorkspace.getState().addPinnedFolder('/folder')
        useWorkspace.getState().setWorkspaceRoot('/project')
        useWorkspace.getState().selectFile('/project/file.md')

        useWorkspace.getState().clearWorkspace()
        const state = useWorkspace.getState()
        assert.strictEqual(state.workspaceRoot, null)
        assert.strictEqual(state.currentPath, '/')
        assert.deepStrictEqual(state.files, [])
        assert.strictEqual(state.selectedFile, null)
        assert.deepStrictEqual(state.pinnedFolders, [])
        // localStorage should be cleaned
        assert.strictEqual(storage.get('ready-workspace-root'), undefined)
        assert.strictEqual(storage.get('ready-pinned-folders'), undefined)
    })

    it('should set files directly', () => {
        const files = [
            { name: 'test.md', path: '/test.md', isDirectory: false, size: 100, modified: new Date() },
        ]
        useWorkspace.getState().setFiles(files)
        assert.strictEqual(useWorkspace.getState().files.length, 1)
        assert.strictEqual(useWorkspace.getState().files[0].name, 'test.md')
    })

    it('should save and retrieve workspaces', () => {
        useWorkspace.getState().addPinnedFolder('/folder-a')
        useWorkspace.getState().addPinnedFolder('/folder-b')
        useWorkspace.getState().saveWorkspace('My Workspace')

        const saved = useWorkspace.getState().getSavedWorkspaces()
        assert.strictEqual(saved.length, 1)
        assert.strictEqual(saved[0].name, 'My Workspace')
        assert.deepStrictEqual(saved[0].folders, ['/folder-a', '/folder-b'])
    })

    it('should not save workspace with no pinned folders', () => {
        useWorkspace.getState().saveWorkspace('Empty')
        const saved = useWorkspace.getState().getSavedWorkspaces()
        assert.strictEqual(saved.length, 0)
    })

    it('should overwrite saved workspace with same name', () => {
        useWorkspace.getState().addPinnedFolder('/v1')
        useWorkspace.getState().saveWorkspace('W')
        // Change pinned and save again with same name
        useWorkspace.setState({ pinnedFolders: ['/v2'] })
        useWorkspace.getState().saveWorkspace('W')
        const saved = useWorkspace.getState().getSavedWorkspaces()
        assert.strictEqual(saved.length, 1)
        assert.deepStrictEqual(saved[0].folders, ['/v2'])
    })

    it('should load a saved workspace', () => {
        useWorkspace.getState().loadSavedWorkspace(['/loaded-a', '/loaded-b'])
        const state = useWorkspace.getState()
        assert.deepStrictEqual(state.pinnedFolders, ['/loaded-a', '/loaded-b'])
        assert.strictEqual(state.workspaceRoot, '/loaded-a')
        assert.strictEqual(state.currentPath, '/loaded-a')
    })

    it('should delete a saved workspace', () => {
        useWorkspace.getState().addPinnedFolder('/x')
        useWorkspace.getState().saveWorkspace('ToDelete')
        useWorkspace.getState().saveWorkspace('ToKeep')

        useWorkspace.getState().deleteSavedWorkspace('ToDelete')
        const saved = useWorkspace.getState().getSavedWorkspaces()
        assert.strictEqual(saved.length, 1)
        assert.strictEqual(saved[0].name, 'ToKeep')
    })

    it('should start and cancel renaming', () => {
        useWorkspace.getState().startRenaming('/workspace/file.md')
        assert.strictEqual(useWorkspace.getState().renamingPath, '/workspace/file.md')
        useWorkspace.getState().cancelRenaming()
        assert.strictEqual(useWorkspace.getState().renamingPath, null)
    })

    it('should start and cancel creating', () => {
        useWorkspace.getState().startCreating('file')
        assert.strictEqual(useWorkspace.getState().creatingType, 'file')
        useWorkspace.getState().cancelCreating()
        assert.strictEqual(useWorkspace.getState().creatingType, null)

        useWorkspace.getState().startCreating('folder')
        assert.strictEqual(useWorkspace.getState().creatingType, 'folder')
    })

    it('should create a file in mock mode', async () => {
        useWorkspace.setState({ currentPath: '/workspace' })
        const result = await useWorkspace.getState().createFile('new-file.md')
        assert.strictEqual(result, true)
        const state = useWorkspace.getState()
        assert.ok(state.files.some(f => f.name === 'new-file.md'))
        assert.strictEqual(state.creatingType, null)
        assert.strictEqual(state.selectedFile, '/workspace/new-file.md')
    })

    it('should create a folder in mock mode', async () => {
        useWorkspace.setState({ currentPath: '/workspace' })
        const result = await useWorkspace.getState().createFolder('new-folder')
        assert.strictEqual(result, true)
        const state = useWorkspace.getState()
        const folder = state.files.find(f => f.name === 'new-folder')
        assert.ok(folder)
        assert.strictEqual(folder.isDirectory, true)
        assert.strictEqual(state.creatingType, null)
    })

    it('should rename an item in mock mode', async () => {
        useWorkspace.setState({
            currentPath: '/workspace',
            files: [
                { name: 'old.md', path: '/workspace/old.md', isDirectory: false, size: 100, modified: new Date() },
            ],
            renamingPath: '/workspace/old.md',
        })
        const result = await useWorkspace.getState().renameItem('/workspace/old.md', 'new.md')
        assert.strictEqual(result, true)
        const state = useWorkspace.getState()
        assert.ok(state.files.some(f => f.name === 'new.md'))
        assert.ok(!state.files.some(f => f.name === 'old.md'))
        assert.strictEqual(state.renamingPath, null)
    })

    it('should delete an item in mock mode', async () => {
        useWorkspace.setState({
            files: [
                { name: 'delete-me.md', path: '/workspace/delete-me.md', isDirectory: false, size: 100, modified: new Date() },
                { name: 'keep-me.md', path: '/workspace/keep-me.md', isDirectory: false, size: 200, modified: new Date() },
            ],
            selectedFile: '/workspace/delete-me.md',
        })
        const result = await useWorkspace.getState().deleteItem('/workspace/delete-me.md')
        assert.strictEqual(result, true)
        const state = useWorkspace.getState()
        assert.strictEqual(state.files.length, 1)
        assert.strictEqual(state.files[0].name, 'keep-me.md')
        // Selected file should be cleared since deleted file was selected
        assert.strictEqual(state.selectedFile, null)
    })

    it('should keep selectedFile when deleting a different item', async () => {
        useWorkspace.setState({
            files: [
                { name: 'a.md', path: '/a.md', isDirectory: false, size: 100, modified: new Date() },
                { name: 'b.md', path: '/b.md', isDirectory: false, size: 200, modified: new Date() },
            ],
            selectedFile: '/a.md',
        })
        await useWorkspace.getState().deleteItem('/b.md')
        assert.strictEqual(useWorkspace.getState().selectedFile, '/a.md')
    })

    it('should set currentPath and trigger mock file loading', () => {
        useWorkspace.getState().setCurrentPath('/test/dir')
        const state = useWorkspace.getState()
        assert.strictEqual(state.currentPath, '/test/dir')
        // refreshFiles mock populates files
        assert.ok(state.files.length > 0)
    })
})

// ============================================================
// useTheme Store Tests
// ============================================================

describe('useTheme Store', () => {
    beforeEach(() => {
        storage.clear()
        prefersDark = false
        documentAttributes.clear()
        useTheme.setState({
            theme: 'light',
            resolvedTheme: 'light',
            skin: 'liquid-glass',
        })
    })

    it('should have light as default theme', () => {
        const state = useTheme.getState()
        assert.strictEqual(state.theme, 'light')
        assert.strictEqual(state.resolvedTheme, 'light')
        assert.strictEqual(state.skin, 'liquid-glass')
    })

    it('should set theme to dark', () => {
        useTheme.getState().setTheme('dark')
        const state = useTheme.getState()
        assert.strictEqual(state.theme, 'dark')
        assert.strictEqual(state.resolvedTheme, 'dark')
    })

    it('should set theme to light', () => {
        useTheme.getState().setTheme('dark')
        useTheme.getState().setTheme('light')
        const state = useTheme.getState()
        assert.strictEqual(state.theme, 'light')
        assert.strictEqual(state.resolvedTheme, 'light')
    })

    it('should resolve system theme to light when prefers-color-scheme is light', () => {
        prefersDark = false
        useTheme.getState().setTheme('system')
        const state = useTheme.getState()
        assert.strictEqual(state.theme, 'system')
        assert.strictEqual(state.resolvedTheme, 'light')
    })

    it('should resolve system theme to dark when prefers-color-scheme is dark', () => {
        prefersDark = true
        useTheme.getState().setTheme('system')
        const state = useTheme.getState()
        assert.strictEqual(state.theme, 'system')
        assert.strictEqual(state.resolvedTheme, 'dark')
    })

    it('should persist theme choice to localStorage', () => {
        useTheme.getState().setTheme('dark')
        assert.strictEqual(storage.get('ready-theme'), 'dark')
        useTheme.getState().setTheme('system')
        assert.strictEqual(storage.get('ready-theme'), 'system')
        useTheme.getState().setTheme('light')
        assert.strictEqual(storage.get('ready-theme'), 'light')
    })

    it('should apply theme to document element', () => {
        useTheme.getState().setTheme('dark')
        assert.strictEqual(documentAttributes.get('data-theme'), 'dark')
        useTheme.getState().setTheme('light')
        assert.strictEqual(documentAttributes.get('data-theme'), 'light')
    })

    it('should toggle theme in cycle: light -> dark -> system -> light', () => {
        assert.strictEqual(useTheme.getState().theme, 'light')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'dark')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'system')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'light')
    })

    it('should persist toggled theme to localStorage', () => {
        useTheme.getState().toggleTheme() // light -> dark
        assert.strictEqual(storage.get('ready-theme'), 'dark')
        useTheme.getState().toggleTheme() // dark -> system
        assert.strictEqual(storage.get('ready-theme'), 'system')
    })

    it('should apply correct data-theme attribute when toggling', () => {
        prefersDark = true

        useTheme.getState().toggleTheme() // light -> dark
        assert.strictEqual(documentAttributes.get('data-theme'), 'dark')

        useTheme.getState().toggleTheme() // dark -> system (prefers dark)
        assert.strictEqual(documentAttributes.get('data-theme'), 'dark')
        assert.strictEqual(useTheme.getState().resolvedTheme, 'dark')

        useTheme.getState().toggleTheme() // system -> light
        assert.strictEqual(documentAttributes.get('data-theme'), 'light')
    })

    it('should set skin to liquid-glass and persist it', () => {
        useTheme.getState().setSkin('liquid-glass')
        const state = useTheme.getState()
        assert.strictEqual(state.skin, 'liquid-glass')
        assert.strictEqual(storage.get('ready-theme-skin'), 'liquid-glass')
        assert.strictEqual(documentAttributes.get('data-skin'), 'liquid-glass')
    })

    it('should keep skin pinned to liquid-glass', () => {
        assert.strictEqual(useTheme.getState().skin, 'liquid-glass')

        useTheme.getState().toggleSkin()
        assert.strictEqual(useTheme.getState().skin, 'liquid-glass')
        assert.strictEqual(storage.get('ready-theme-skin'), 'liquid-glass')

        useTheme.getState().toggleSkin()
        assert.strictEqual(useTheme.getState().skin, 'liquid-glass')
        assert.strictEqual(storage.get('ready-theme-skin'), 'liquid-glass')
        assert.strictEqual(documentAttributes.get('data-skin'), 'liquid-glass')
    })
})
