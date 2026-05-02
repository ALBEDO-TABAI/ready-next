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
    get matches() {
        if (query === '(prefers-color-scheme: dark)') return prefersDark
        // Tests run in a non-interactive environment — advertise prefers-reduced-motion so the
        // theme store's isRitualBypassActive() short-circuit applies data-theme synchronously
        // instead of deferring it until the overlay's holding phase ends.
        if (query === '(prefers-reduced-motion: reduce)') return true
        return false
    },
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
const { useSettings } = await import('../renderer/stores/useSettings')
const { createDefaultAIWorkspace, getActiveAIConfig } = await import('../shared/ai-providers')

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
            workbenchSplitRatio: 50,
            readySubMode: 'browser',
        })
    })

    it('should have correct default state', () => {
        const state = useMode.getState()
        assert.strictEqual(state.appMode, 'workbench')
        assert.strictEqual(state.workbenchMode, 'browser')
        assert.strictEqual(state.splitMode, null)
        assert.strictEqual(state.workbenchSplitRatio, 50)
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

    it('should clamp workbench split ratio between 20 and 80', () => {
        useMode.getState().setWorkbenchSplitRatio(50)
        assert.strictEqual(useMode.getState().workbenchSplitRatio, 50)

        useMode.getState().setWorkbenchSplitRatio(10)
        assert.strictEqual(useMode.getState().workbenchSplitRatio, 20)

        useMode.getState().setWorkbenchSplitRatio(90)
        assert.strictEqual(useMode.getState().workbenchSplitRatio, 80)
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
            documentSplitRatio: 50,
        })
    })

    it('should have initial state with one tab', () => {
        const state = useDocTabs.getState()
        assert.strictEqual(state.tabs.length, 1)
        assert.strictEqual(state.activeTabId, 'reset-tab')
        assert.strictEqual(state.splitTabId, null)
        assert.strictEqual(state.documentSplitRatio, 50)
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

    it('should clamp document split ratio between 20 and 80', () => {
        useDocTabs.getState().setDocumentSplitRatio(50)
        assert.strictEqual(useDocTabs.getState().documentSplitRatio, 50)

        useDocTabs.getState().setDocumentSplitRatio(10)
        assert.strictEqual(useDocTabs.getState().documentSplitRatio, 20)

        useDocTabs.getState().setDocumentSplitRatio(90)
        assert.strictEqual(useDocTabs.getState().documentSplitRatio, 80)

        useDocTabs.getState().setDocumentSplitRatio(20)
        assert.strictEqual(useDocTabs.getState().documentSplitRatio, 20)

        useDocTabs.getState().setDocumentSplitRatio(80)
        assert.strictEqual(useDocTabs.getState().documentSplitRatio, 80)
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

    it('should migrate persisted splitRatio into documentSplitRatio', async () => {
        const migrated = await (useDocTabs as typeof useDocTabs & {
            persist: {
                getOptions: () => { migrate?: (state: unknown) => Promise<Record<string, unknown>> | Record<string, unknown> }
            }
        }).persist.getOptions().migrate?.({
            tabs: [{ id: 'doc-1', path: null, title: '旧文档', content: '', isDirty: false }],
            activeTabId: 'doc-1',
            splitTabId: null,
            splitRatio: 62,
        })

        assert.ok(migrated)
        assert.strictEqual(migrated?.documentSplitRatio, 62)
        assert.strictEqual('splitRatio' in (migrated || {}), false)
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

    it('should fall back to chat history when scoped conversation loading is temporarily unavailable', async () => {
        ;(globalThis as any).window.electronAPI = {
            agent: {
                listConversationScopes: async () => ({
                    success: false,
                    error: 'runtime unavailable',
                }),
            },
            chat: {
                getConversations: async (_agent: string) => ({
                    success: true,
                    data: [
                        {
                            id: 'conv-local-history-1',
                            agent: 'butler',
                            title: '历史会话',
                            created_at: '2026-04-15T09:00:00.000Z',
                            updated_at: '2026-04-15T09:30:00.000Z',
                        },
                    ],
                }),
            },
        }

        await useAgent.getState().loadScopes()

        const state = useAgent.getState()
        assert.strictEqual(state.scopes.length, 1)
        assert.strictEqual(state.scopes[0].id, 'conv-local-history-1')
        assert.strictEqual(state.scopes[0].sourceKind, 'local')
        assert.strictEqual(state.currentScopeId, 'conv-local-history-1')
        assert.strictEqual(state.conversations.length, 1)
        assert.strictEqual(state.conversations[0].title, '历史会话')
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

    it('should preserve the placeholder local scope id when creating a fresh local session', async () => {
        const createLocalScopeCalls: Array<{ agent: string; scopeId?: string }> = []
        const createConversationCalls: Array<{ id: string; agent: string; title: string }> = []

        ;(globalThis as any).window.electronAPI = {
            agent: {
                createLocalScope: async (agent: string, scopeId?: string) => {
                    createLocalScopeCalls.push({ agent, scopeId })
                    const id = scopeId || 'persisted-scope-id'
                    return {
                        success: true,
                        data: {
                            id,
                            agent,
                            title: '新对话',
                            sourceKind: 'local',
                            sourceId: 'app',
                            threadKey: id,
                            meta: { sourceLabel: '应用内', createdBy: 'app' },
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                            lastMessageAt: null,
                        },
                    }
                },
            },
            chat: {
                createConversation: async (data: { id: string; agent: string; title: string }) => {
                    createConversationCalls.push(data)
                    return { success: true }
                },
            },
        }

        useAgent.getState().newSession()
        const initialScopeId = useAgent.getState().currentScopeId

        assert.ok(initialScopeId)
        assert.match(initialScopeId!, /^conv-local-/)

        await new Promise((resolve) => setTimeout(resolve, 0))

        const state = useAgent.getState()
        assert.deepStrictEqual(createLocalScopeCalls, [{ agent: 'butler', scopeId: initialScopeId! }])
        assert.deepStrictEqual(createConversationCalls, [{
            id: initialScopeId!,
            agent: 'butler',
            title: '新对话',
        }])
        assert.strictEqual(state.currentScopeId, initialScopeId)
        assert.strictEqual(state.currentScope?.id, initialScopeId)
    })

    it('should persist a local scope before sending when the runtime scope bootstrap fails', async () => {
        const createConversationCalls: Array<{ id: string; agent: string; title: string }> = []
        const createLocalScopeCalls: Array<{ agent: string; scopeId?: string }> = []
        ;(globalThis as any).window.electronAPI = {
            agent: {
                createLocalScope: async (agent: string, scopeId?: string) => {
                    createLocalScopeCalls.push({ agent, scopeId })
                    return { success: false, error: 'runtime unavailable' }
                },
                sendScoped: async () => ({ success: true }),
                kill: async () => ({ success: true }),
            },
            chat: {
                createConversation: async (data: { id: string; agent: string; title: string }) => {
                    createConversationCalls.push(data)
                    return { success: true }
                },
                saveMessage: async () => ({ success: true }),
                updateConversationTitle: async () => ({ success: true }),
            },
        }

        useAgent.setState({
            currentAgent: 'butler',
            currentScopeId: 'conv-local-test-send',
            currentScope: {
                id: 'conv-local-test-send',
                agent: 'butler',
                title: '新对话',
                sourceKind: 'local',
                sourceId: 'app',
                threadKey: 'conv-local-test-send',
                meta: { sourceLabel: '应用内', createdBy: 'app' },
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                lastMessageAt: null,
            },
            scopes: [],
            conversations: [],
            messages: [],
            attachments: [],
            filePool: [],
            isStreaming: false,
            sendCoalescingEnabled: false,
        })

        await useAgent.getState().sendMessage('hello')

        assert.deepStrictEqual(createConversationCalls, [{
            id: 'conv-local-test-send',
            agent: 'butler',
            title: '新对话',
        }])
        assert.deepStrictEqual(createLocalScopeCalls, [{
            agent: 'butler',
            scopeId: 'conv-local-test-send',
        }])
    })

    it('should retry once after rebuilding a missing local scope during send', async () => {
        const createConversationCalls: Array<{ id: string; agent: string; title: string }> = []
        const createLocalScopeCalls: Array<{ agent: string; scopeId?: string }> = []
        const sendScopedCalls: Array<Record<string, unknown>> = []

        ;(globalThis as any).window.electronAPI = {
            agent: {
                createLocalScope: async (agent: string, scopeId?: string) => {
                    createLocalScopeCalls.push({ agent, scopeId })
                    const id = scopeId || 'conv-local-retry'
                    return {
                        success: true,
                        data: {
                            id,
                            agent,
                            title: '新对话',
                            sourceKind: 'local',
                            sourceId: 'app',
                            threadKey: id,
                            meta: { sourceLabel: '应用内', createdBy: 'app' },
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                            lastMessageAt: null,
                        },
                    }
                },
                sendScoped: async (payload: Record<string, unknown>) => {
                    sendScopedCalls.push(payload)
                    if (sendScopedCalls.length === 1) {
                        return { success: false, error: `Conversation scope not found: ${String(payload?.scopeId)}` }
                    }
                    return { success: true }
                },
                kill: async () => ({ success: true }),
            },
            chat: {
                createConversation: async (data: { id: string; agent: string; title: string }) => {
                    createConversationCalls.push(data)
                    return { success: true }
                },
                saveMessage: async () => ({ success: true }),
                updateConversationTitle: async () => ({ success: true }),
            },
            settings: {
                getAIConfig: async () => ({ success: true, data: null }),
            },
        }

        useAgent.setState({
            currentAgent: 'butler',
            currentScopeId: 'conv-local-retry',
            currentScope: {
                id: 'conv-local-retry',
                agent: 'butler',
                title: '新对话',
                sourceKind: 'local',
                sourceId: 'app',
                threadKey: 'conv-local-retry',
                meta: { sourceLabel: '应用内', createdBy: 'app' },
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                lastMessageAt: null,
            },
            scopes: [{
                id: 'conv-local-retry',
                agent: 'butler',
                title: '新对话',
                sourceKind: 'local',
                sourceId: 'app',
                threadKey: 'conv-local-retry',
                meta: { sourceLabel: '应用内', createdBy: 'app' },
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                lastMessageAt: null,
            }],
            conversations: [{
                id: 'conv-local-retry',
                agent: 'butler',
                title: '新对话',
                created_at: '2026-04-15T10:00:00.000Z',
                updated_at: '2026-04-15T10:00:00.000Z',
            }],
            messages: [],
            attachments: [],
            filePool: [],
            isStreaming: false,
            sendCoalescingEnabled: false,
        })

        await useAgent.getState().sendMessage('hello again')

        assert.deepStrictEqual(createConversationCalls, [
            {
                id: 'conv-local-retry',
                agent: 'butler',
                title: '新对话',
            },
            {
                id: 'conv-local-retry',
                agent: 'butler',
                title: '新对话',
            },
        ])
        assert.deepStrictEqual(
            sendScopedCalls.map((call) => call.scopeId),
            ['conv-local-retry', 'conv-local-retry'],
        )
        assert.deepStrictEqual(
            sendScopedCalls.map((call) => call.agent),
            ['butler', 'butler'],
        )
        assert.strictEqual(sendScopedCalls[0].message, 'hello again')
        assert.ok(typeof sendScopedCalls[0].requestId === 'string' && (sendScopedCalls[0].requestId as string).length > 0)
        assert.deepStrictEqual(createLocalScopeCalls, [
            { agent: 'butler', scopeId: 'conv-local-retry' },
            { agent: 'butler', scopeId: 'conv-local-retry' },
        ])
    })

    it('should show a friendly message when sendScoped reports user message persistence failure', async () => {
        const sendScopedCalls: Array<Record<string, unknown>> = []

        ;(globalThis as any).window.electronAPI = {
            agent: {
                createLocalScope: async (_agent: string, scopeId?: string) => ({
                    success: true,
                    data: {
                        id: scopeId || 'conv-local-persist-failed',
                        agent: 'butler',
                        title: '新对话',
                        sourceKind: 'local',
                        sourceId: 'app',
                        threadKey: scopeId || 'conv-local-persist-failed',
                        meta: { sourceLabel: '应用内', createdBy: 'app' },
                        createdAt: '2026-04-15T10:00:00.000Z',
                        updatedAt: '2026-04-15T10:00:00.000Z',
                        lastMessageAt: null,
                    },
                }),
                sendScoped: async (payload: Record<string, unknown>) => {
                    sendScopedCalls.push(payload)
                    return {
                        success: false,
                        error: 'SQLITE constraint failed: chat_messages.id',
                        errorKind: 'message_persist_failed',
                        persistence: {
                            scope: 'pre-existing',
                            message: 'failed',
                            attachments: 'none',
                            inputAttachments: 'none',
                        },
                    }
                },
                emitRendererMetric: async () => ({ success: true }),
                kill: async () => ({ success: true }),
            },
            chat: {
                createConversation: async () => ({ success: true }),
                saveMessage: async () => ({ success: true }),
                updateConversationTitle: async () => ({ success: true }),
            },
            settings: {
                getAIConfig: async () => ({ success: true, data: null }),
            },
        }

        useAgent.setState({
            currentAgent: 'butler',
            currentScopeId: 'conv-local-persist-failed',
            currentScope: {
                id: 'conv-local-persist-failed',
                agent: 'butler',
                title: '新对话',
                sourceKind: 'local',
                sourceId: 'app',
                threadKey: 'conv-local-persist-failed',
                meta: { sourceLabel: '应用内', createdBy: 'app' },
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                lastMessageAt: null,
            },
            scopes: [],
            conversations: [],
            messages: [],
            attachments: [],
            filePool: [],
            isStreaming: false,
            sendCoalescingEnabled: false,
        })

        const result = await useAgent.getState().sendMessage('hello')

        assert.equal(sendScopedCalls.length, 1)
        assert.equal(result.success, false)
        assert.equal(result.preserveInput, true)
        assert.equal(result.shouldClearInput, false)
        assert.ok(sendScopedCalls[0].userMessage, 'sendScoped payload should carry the user message persistence bundle')
        const errorMessage = useAgent.getState().messages.find((message) => message.type === 'system')
        assert.ok(errorMessage)
        assert.match(errorMessage!.content, /消息保存失败，请重试/)
        assert.doesNotMatch(errorMessage!.content, /SQLITE/i)
        assert.equal(useAgent.getState().isStreaming, false)
    })

    it('should stop sending and keep attachments when attachment input cannot be read', async () => {
        const sendScopedCalls: Array<Record<string, unknown>> = []
        const originalAttachment = {
            id: 'attach-failed',
            name: 'missing.txt',
            path: '/tmp/missing.txt',
            type: 'text' as const,
            size: 10,
            ext: '.txt',
            source: 'file' as const,
        }

        ;(globalThis as any).window.electronAPI = {
            agent: {
                createLocalScope: async (_agent: string, scopeId?: string) => ({
                    success: true,
                    data: {
                        id: scopeId || 'conv-local-attachment-failed',
                        agent: 'butler',
                        title: '新对话',
                        sourceKind: 'local',
                        sourceId: 'app',
                        threadKey: scopeId || 'conv-local-attachment-failed',
                        meta: { sourceLabel: '应用内', createdBy: 'app' },
                        createdAt: '2026-04-15T10:00:00.000Z',
                        updatedAt: '2026-04-15T10:00:00.000Z',
                        lastMessageAt: null,
                    },
                }),
                sendScoped: async (payload: Record<string, unknown>) => {
                    sendScopedCalls.push(payload)
                    return { success: true }
                },
                emitRendererMetric: async () => ({ success: true }),
                kill: async () => ({ success: true }),
            },
            chat: {
                createConversation: async () => ({ success: true }),
                readFileForAI: async () => ({ success: false, error: 'ENOENT /tmp/missing.txt' }),
                updateConversationTitle: async () => ({ success: true }),
            },
            settings: {
                getAIConfig: async () => ({ success: true, data: null }),
            },
        }

        useAgent.setState({
            currentAgent: 'butler',
            currentScopeId: 'conv-local-attachment-failed',
            currentScope: {
                id: 'conv-local-attachment-failed',
                agent: 'butler',
                title: '新对话',
                sourceKind: 'local',
                sourceId: 'app',
                threadKey: 'conv-local-attachment-failed',
                meta: { sourceLabel: '应用内', createdBy: 'app' },
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                lastMessageAt: null,
            },
            scopes: [],
            conversations: [],
            messages: [],
            attachments: [originalAttachment],
            filePool: [],
            isStreaming: false,
            sendCoalescingEnabled: false,
        })

        const result = await useAgent.getState().sendMessage('please read it')

        assert.equal(sendScopedCalls.length, 0)
        assert.equal(result.success, false)
        assert.equal(result.preserveInput, true)
        assert.equal(result.shouldClearInput, false)
        assert.deepStrictEqual(useAgent.getState().attachments, [originalAttachment])
        const errorMessage = useAgent.getState().messages.find((message) => message.type === 'system')
        assert.ok(errorMessage)
        assert.match(errorMessage!.content, /附件读取失败，请重新选择文件/)
        assert.doesNotMatch(errorMessage!.content, /ENOENT/)
        assert.equal(useAgent.getState().isStreaming, false)
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
        // Use a 4+-segment safe root (validateWorkspaceRoot rejects shorter
        // paths to prevent the bb529f1 home-directory index storm).
        const safeRoot = '/Users/test/Documents/project'
        const result = useWorkspace.getState().setWorkspaceRoot(safeRoot)
        assert.strictEqual(result.ok, true, `setWorkspaceRoot rejected: ${result.message}`)
        const state = useWorkspace.getState()
        assert.strictEqual(state.workspaceRoot, safeRoot)
        assert.strictEqual(state.currentPath, safeRoot)
        assert.strictEqual(state.selectedFile, null)
        // Should persist to localStorage
        assert.strictEqual(storage.get('ready-workspace-root'), safeRoot)
    })

    it('should set workspace root and populate mock files', () => {
        useWorkspace.getState().setWorkspaceRoot('/Users/test/Documents/project')
        const state = useWorkspace.getState()
        // refreshFiles() mock mode populates 7 items
        assert.ok(state.files.length > 0)
    })

    it('should reject dangerous workspace roots and not mutate state', () => {
        // Reset to known state first
        useWorkspace.getState().clearWorkspace()
        const beforeRoot = useWorkspace.getState().workspaceRoot

        const r1 = useWorkspace.getState().setWorkspaceRoot('/Users/alice')
        assert.strictEqual(r1.ok, false)
        assert.strictEqual(r1.reason, 'forbidden_user_root')
        assert.strictEqual(useWorkspace.getState().workspaceRoot, beforeRoot)

        const r2 = useWorkspace.getState().setWorkspaceRoot('/')
        assert.strictEqual(r2.ok, false)
        assert.strictEqual(r2.reason, 'forbidden_system_root')

        const r3 = useWorkspace.getState().setWorkspaceRoot('/Users/alice/Documents')
        assert.strictEqual(r3.ok, false)
        assert.strictEqual(r3.reason, 'forbidden_personal_dir')

        const r4 = useWorkspace.getState().setWorkspaceRoot('/a/b/c')
        assert.strictEqual(r4.ok, false)
        assert.strictEqual(r4.reason, 'too_short')

        // localStorage was never written
        assert.strictEqual(storage.get('ready-workspace-root'), undefined)
    })

    it('should clear workspace completely', () => {
        useWorkspace.getState().addPinnedFolder('/folder')
        useWorkspace.getState().setWorkspaceRoot('/Users/test/Documents/project')
        useWorkspace.getState().selectFile('/Users/test/Documents/project/file.md')

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
        // Primary folder must pass validateWorkspaceRoot (4+ segments, non-personal-dir).
        const safePrimary = '/Users/test/Documents/loaded-a'
        useWorkspace.getState().loadSavedWorkspace([safePrimary, '/loaded-b'])
        const state = useWorkspace.getState()
        assert.deepStrictEqual(state.pinnedFolders, [safePrimary, '/loaded-b'])
        assert.strictEqual(state.workspaceRoot, safePrimary)
        assert.strictEqual(state.currentPath, safePrimary)
    })

    it('should drop unsafe primary in saved workspace and leave workspaceRoot null', () => {
        // Legacy saved workspaces from before validation should not auto-trigger
        // a home-directory index storm.
        useWorkspace.getState().clearWorkspace()
        useWorkspace.getState().loadSavedWorkspace(['/Users/alice', '/another'])
        const state = useWorkspace.getState()
        // Pinned list still preserved
        assert.deepStrictEqual(state.pinnedFolders, ['/Users/alice', '/another'])
        // But workspaceRoot is null (and storage cleared)
        assert.strictEqual(state.workspaceRoot, null)
        assert.strictEqual(state.currentPath, '/')
        assert.strictEqual(storage.get('ready-workspace-root'), undefined)
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

    it('should toggle theme strictly between light and dark (no system)', () => {
        assert.strictEqual(useTheme.getState().theme, 'light')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'dark')
        assert.strictEqual(useTheme.getState().resolvedTheme, 'dark')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'light')
        assert.strictEqual(useTheme.getState().resolvedTheme, 'light')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'dark')
    })

    it('should persist toggled theme to localStorage', () => {
        useTheme.getState().toggleTheme() // light -> dark
        assert.strictEqual(storage.get('ready-theme'), 'dark')
        useTheme.getState().toggleTheme() // dark -> light
        assert.strictEqual(storage.get('ready-theme'), 'light')
    })

    it('should apply correct data-theme attribute when toggling', () => {
        useTheme.getState().toggleTheme() // light -> dark
        assert.strictEqual(documentAttributes.get('data-theme'), 'dark')

        useTheme.getState().toggleTheme() // dark -> light
        assert.strictEqual(documentAttributes.get('data-theme'), 'light')
        assert.strictEqual(useTheme.getState().resolvedTheme, 'light')

        useTheme.getState().toggleTheme() // light -> dark
        assert.strictEqual(documentAttributes.get('data-theme'), 'dark')
    })

    it('should overwrite system theme with explicit resolved on toggle', () => {
        prefersDark = true
        useTheme.getState().setTheme('system')
        assert.strictEqual(useTheme.getState().theme, 'system')
        assert.strictEqual(useTheme.getState().resolvedTheme, 'dark')

        useTheme.getState().toggleTheme()
        assert.strictEqual(useTheme.getState().theme, 'light')
        assert.strictEqual(useTheme.getState().resolvedTheme, 'light')
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

describe('useSettings Store', () => {
    beforeEach(() => {
        storage.clear()
        const workspace = createDefaultAIWorkspace()
        ;(globalThis as any).window.electronAPI = {
            settings: {
                getAIWorkspace: async () => ({ success: true, data: workspace }),
                getAIConfig: async () => ({ success: true, data: getActiveAIConfig(workspace) }),
                get: async () => ({ success: false }),
                setAIWorkspace: async () => ({ success: true }),
                setAIConfig: async () => ({ success: true }),
                set: async () => ({ success: true }),
                testAIConnection: async () => ({ success: false, error: 'not configured' }),
            },
        }
        useSettings.setState({
            config: getActiveAIConfig(workspace)!,
            workspace,
            selectedProfileId: workspace.activeProfileId,
            loaded: true,
            testStatus: 'idle',
            testMessage: '',
            testLatency: null,
            remoteModels: [],
            savedConfigs: {},
        })
    })

    it('debounces updateField persistence and only flushes the latest value', async () => {
        const calls: string[] = []
        ;(globalThis as any).window.electronAPI.settings.setAIWorkspace = async (workspace: { profiles: Array<{ id: string; config: { apiKey: string } }>; activeProfileId: string }) => {
            const profile = workspace.profiles.find((item) => item.id === workspace.activeProfileId)
            calls.push(profile?.config.apiKey || '')
            return { success: true }
        }
        ;(globalThis as any).window.electronAPI.settings.set = async () => ({ success: true })

        useSettings.getState().updateField('apiKey', 'first')
        useSettings.getState().updateField('apiKey', 'second')

        await new Promise((resolve) => setTimeout(resolve, 120))
        assert.deepStrictEqual(calls, [])

        await new Promise((resolve) => setTimeout(resolve, 260))
        assert.deepStrictEqual(calls, ['second'])
    })

    it('flushes pending config before switching provider', async () => {
        const calls: Array<{ provider: string; apiKey: string }> = []
        ;(globalThis as any).window.electronAPI.settings.setAIWorkspace = async (workspace: { profiles: Array<{ id: string; config: { provider: string; apiKey: string } }>; activeProfileId: string }) => {
            const profile = workspace.profiles.find((item) => item.id === workspace.activeProfileId)
            calls.push({ provider: profile?.config.provider || '', apiKey: profile?.config.apiKey || '' })
            return { success: true }
        }
        ;(globalThis as any).window.electronAPI.settings.set = async () => ({ success: true })

        useSettings.getState().updateField('apiKey', 'buffered-key')
        useSettings.getState().switchProvider('openai')

        await new Promise((resolve) => setTimeout(resolve, 20))

        assert.strictEqual(calls[0]?.provider, 'moonshot')
        assert.strictEqual(calls[0]?.apiKey, 'buffered-key')
        assert.strictEqual(calls[1]?.provider, 'openai')
    })
})
