import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import Database from 'better-sqlite3'
import { runMigrations } from '../main/modules/migrations'
import { BrowserStore } from '../main/modules/database/browser-store'
import { BrowserWorkTabOwnershipStore } from '../main/modules/browser-engine/work-tab-ownership-store'
import { BrowserTabLifecycleService, type BrowserLifecycleTabRecord } from '../main/modules/browser-engine/tab-lifecycle-service'
import { BrowserTabMetaService } from '../main/modules/browser-engine/tab-meta-service'
import { BrowserTabShellService } from '../main/modules/browser-engine/tab-shell-service'
import { BrowserTaskPersistenceService } from '../main/modules/browser-engine/task-persistence-service'
import { BrowserRepository } from '../main/modules/repositories/browser-repository'
import { readBrowserUserAttention } from '../main/modules/browser-engine/browser-user-attention'
import type { BrowserController } from '../main/modules/browser-engine/browser-controller'
import { useAgent } from '../renderer/stores/useAgent'
import { browserTasksForRun, installBrowserTaskRereadTriggers, requestBrowserTaskReread, resetBrowserTaskWorkForTest, useBrowserTaskWork } from '../renderer/modules/browser/browser-task-work'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// Only native host construction is replaced; migration, ownership, tab lifecycle and controller methods run unchanged.
export const __breaksInvariants = ['browser.controller.native-construction-replaced-with-isolated-test-ports', 'browser.task-work.test-state-reset']
type Controller = Pick<BrowserController, 'createTab' | 'createAgentWorkTab' | 'registerDormantTabs' | 'getTabList'
  | 'getTaskWorkTabIds' | 'getAgentWorkTab' | 'closeTaskTabs' | 'closeTab' | 'getTaskAttention'>

function loadControllerModule(file: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, new () => Controller> = {}
  const output = ts.transpileModule(readFileSync(resolve(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(output, { exports, require: (id: string) => dependencies[id] ?? {}, process, console })
  return exports
}

const tabRuntime = loadControllerModule('src/main/modules/browser-engine/browser-controller-tab-runtime.ts', {
  './browser-controller-interaction-runtime': { BrowserControllerInteractionRuntime: class {} },
})
const controllerModule = loadControllerModule('src/main/modules/browser-engine/browser-controller.ts', {
  './browser-controller-capture-runtime': { BrowserControllerCaptureRuntime: tabRuntime.BrowserControllerTabRuntime },
  './browser-user-attention': { readBrowserUserAttention },
})

function controller(db: Database.Database) {
  const tabs = new Map<string, BrowserLifecycleTabRecord>()
  const effects: string[] = []
  let counter = 0, activeTabId: string | null = null
  const ownership = new BrowserWorkTabOwnershipStore(() => db)
  const host = {
    tabs, useMock: true,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (id: string | null) => { activeTabId = id },
    setSplitTabId: () => {}, getSplitTabId: () => null,
    observeRestoredTabId: (id: string) => { counter = Math.max(counter, Number(id.replace('tab-', '')) || 0) },
    getNextTabId: () => `tab-${++counter}`,
    isAllowedUrl: (url: string) => url.startsWith('https://'),
    extractDomain: (url: string) => new URL(url).hostname,
    queueTabUpdate: () => {}, sendToRenderer: () => {},
  }
  const meta = new BrowserTabMetaService(host)
  const lifecycle = new BrowserTabLifecycleService({ ...host, buildTabPayload: tab => meta.buildTabPayload(tab) } as ConstructorParameters<typeof BrowserTabLifecycleService>[0])
  const shell = new BrowserTabShellService(host as ConstructorParameters<typeof BrowserTabShellService>[0])
  const repository = new class extends BrowserRepository {
    override getTask(id: string) { return new BrowserStore(() => db).getBrowserTask(id) }
  }()
  const runtime = Object.assign(new controllerModule.BrowserController(), {
    tabs, workTabOwnershipStore: ownership, taskWorkTabs: new Map(), agentWorkTabs: new Map(),
    workflowPhysicalBindings: new Map(), pendingPhysicalTakeovers: new Set(),
    tabLifecycleService: lifecycle, tabMetaService: meta, tabShellService: shell,
    taskPersistenceService: new BrowserTaskPersistenceService(repository),
    getPhysicalTargetToken: (id: string) => tabs.has(id) ? `physical-${id}` : null,
    attachTargetClaimSupervision: () => {}, attachAgentTabSupervision: () => {}, clearSplitTabHost: () => {},
    emitTabMeta: (id: string) => meta.emitTabMeta(id),
    dialogService: { ensure: async () => {} },
    performanceRuntime: { reconcile: () => {}, scheduleReclaim: () => {}, disposeTab: () => {} },
    hostLayoutService: { mountBackgroundWorkHost: () => { effects.push('mount') } },
    partitionForTab: () => null,
    disposeTabRuntimeResources: () => { effects.push('dispose') },
    notifyTabClosed: () => { effects.push('closed') },
    sendToRenderer: (_channel: string, _data: { scopeId: string; browserTaskId: string }) => {},
  })
  return { runtime, ownership, tabs, effects }
}

function seed(db: Database.Database) {
  runMigrations(db)
  db.prepare(`INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
    VALUES ('scope', 'butler', '测试任务', 'now', 'now')`).run()
  db.prepare(`INSERT INTO task_projections (
    task_id, scope_id, run_id, task_type, module, status, interaction_state, steps_json, created_at, updated_at
  ) VALUES ('parent', 'scope', 'run-1', 'research', 'browser', 'running', 'running', '[]', 'now', 'now')`).run()
  new BrowserStore(() => db).createBrowserTask({
    id: 'task', kind: 'browser_workflow', status: 'running', payload_json: '{}',
    created_at: 'now', updated_at: 'now', parent_task_id: 'parent', created_by_run_id: 'run-1',
    active_execution_binding_json: JSON.stringify({ runId: 'run-1' }),
  })
}

test('BA10: database reopen and dormant registration retain task grouping without execution or focus', async t => {
  if (skipIfSqliteUnavailable(t, 'browser work tab restart')) return
  const root = mkdtempSync(join(tmpdir(), 'work-tabs-')), path = join(root, 'ready.db')
  let db = new Database(path)
  try {
    seed(db)
    const before = controller(db)
    const manual = await before.runtime.createTab('https://user.test/')
    const opened = await before.runtime.createAgentWorkTab('task', 'https://work.test/', manual.tabId!)
    assert.equal(opened.success, true)
    new BrowserStore(() => db).updateBrowserTask('task', { payload_json: JSON.stringify({
      userAttention: { id: 'attention', reason: 'takeover', tabId: opened.tabId, physicalTargetToken: `physical-${opened.tabId}` },
    }) })
    const persisted = [...before.tabs.values()].map(tab => ({ ...tab }))
    db.close()
    db = new Database(path)
    runMigrations(db)
    const after = controller(db)
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousScope = useAgent.getState().currentScopeId
    let onAttention: ((data: { scopeId: string; browserTaskId: string }) => void) | undefined
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout, clearTimeout, electronAPI: {
        browser: {
          getTabs: async () => after.runtime.getTabList(),
          getAgentSupervisionState: async () => ({ claims: [] }),
          getTaskDownloadReceipts: async () => ({ success: true, downloadReceipts: [] }),
        },
        agent: {
          onBrowserTaskAttentionChanged: (listener: typeof onAttention) => { onAttention = listener; return () => {} },
          getBrowserTaskAttention: async ({ scopeId, browserTaskId }: { scopeId: string; browserTaskId: string }) =>
            scopeId === 'scope' ? after.runtime.getTaskAttention(browserTaskId) : null,
          getTaskProjection: async () => ({ success: false }),
        },
      },
    } })
    useAgent.setState({ currentScopeId: 'different-scope' })
    resetBrowserTaskWorkForTest()
    const cleanup = installBrowserTaskRereadTriggers()
    t.after(() => {
      cleanup(); resetBrowserTaskWorkForTest(); useAgent.setState({ currentScopeId: previousScope })
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    })
    await requestBrowserTaskReread('mount')
    after.runtime.sendToRenderer = (_channel, data) => { onAttention?.(data) }
    const result = after.runtime.registerDormantTabs({ tabs: persisted, activeTabId: manual.tabId!, splitTabId: null })
    assert.equal(result.success, true)
    await requestBrowserTaskReread('card', ['task'])
    const card = browserTasksForRun(useBrowserTaskWork.getState().tasks, 'run-1')[0]
    assert.deepEqual(card?.tabIds, [opened.tabId])
    assert.equal(card.attention?.tabId, opened.tabId)
    assert.equal(card.scopeId, 'scope', 'restoration names the original conversation even when another one is open')
    const list = after.runtime.getTabList()
    assert.equal(list.find(tab => tab.id === opened.tabId)?.browserTaskId, 'task')
    assert.equal(list.find(tab => tab.id === opened.tabId)?.openerTabId, manual.tabId)
    assert.equal(list.find(tab => tab.id === manual.tabId)?.browserTaskId, undefined)
    assert.equal(result.activeTabId, manual.tabId)
    assert.ok(result.dormantTabIds?.includes(opened.tabId!))
    assert.deepEqual([...after.runtime.getTaskWorkTabIds('task')], [])
    assert.equal(after.runtime.getAgentWorkTab('task'), null)
    assert.deepEqual(after.effects, [])
    assert.equal(after.runtime.registerDormantTabs({ tabs: [], activeTabId: null, splitTabId: null }).success, false)
    assert.equal(after.runtime.getTabList().find(tab => tab.id === opened.tabId)?.browserTaskId, 'task')
    const closed = after.runtime.closeTaskTabs({ browserTaskId: 'task' })
    assert.equal(closed.success, true)
    assert.deepEqual([...closed.closedTabIds], [opened.tabId])
    assert.deepEqual(after.ownership.list(), [])
    assert.deepEqual(after.runtime.getTabList().map(tab => tab.id), [manual.tabId])
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test('BA10: accepted restoration prunes missing, rejected and changed-profile tabs; a failed write permits retry', async t => {
  if (skipIfSqliteUnavailable(t, 'browser work tab reconciliation')) return
  const db = new Database(':memory:')
  try {
    seed(db)
    const before = controller(db)
    const manual = await before.runtime.createTab('https://user.test/')
    const kept = await before.runtime.createTab('https://named.test/', { background: true, profile: 'research', owner: 'agent' })
    assert.ok(kept.tabId)
    before.ownership.add(before.tabs.get(kept.tabId)!, manual.tabId!, before.ownership.captureOwner('task'))
    const missing = await before.runtime.createAgentWorkTab('task', 'https://missing.test/', null)
    const changed = await before.runtime.createAgentWorkTab('task', 'https://changed.test/', null)
    const rejected = await before.runtime.createAgentWorkTab('task', 'https://rejected.test/', null)
    const restored = [...before.tabs.values()].filter(tab => tab.id !== missing.tabId).map(tab => ({
      ...tab,
      ...(tab.id === changed.tabId ? { profile: 'other' } : {}),
      ...(tab.id === rejected.tabId ? { url: 'javascript:alert(1)' } : {}),
    }))
    const after = controller(db)
    db.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON browser_work_tab_ownership BEGIN SELECT RAISE(ABORT, 'prune denied'); END")
    const request = { tabs: restored, activeTabId: manual.tabId!, splitTabId: null }
    const failed = after.runtime.registerDormantTabs(request)
    assert.equal(failed.success, false)
    assert.match(failed.error!, /prune denied/)
    assert.equal(after.tabs.size, 0)
    assert.deepEqual(after.effects, [])
    db.exec('DROP TRIGGER reject_prune')
    assert.equal(after.runtime.registerDormantTabs(request).success, true)
    assert.deepEqual(after.ownership.list().map(row => [row.tabId, row.profile]), [[kept.tabId, 'research']])
    const ordinary = after.runtime.getTabList().find(tab => tab.id === changed.tabId)
    assert.equal(ordinary?.browserTaskId, undefined)
    assert.equal(ordinary?.owner, 'manual')
    assert.equal(ordinary?.activity, 'idle')
    assert.equal(ordinary?.required, false)
    assert.equal(after.tabs.has(rejected.tabId!), false)
    assert.equal(after.tabs.has(missing.tabId!), false)
    const empty = controller(db)
    assert.equal(empty.runtime.registerDormantTabs({ tabs: [], activeTabId: null, splitTabId: null }).success, false)
    assert.deepEqual(empty.ownership.list(), [], 'an empty restore must clear all old ownership')
    const oldTab = after.tabs.get(kept.tabId)!
    after.ownership.add(oldTab, null, after.ownership.captureOwner('task'))
    await empty.runtime.createTab('https://new-session.test/')
    assert.deepEqual(empty.ownership.list(), [], 'new tabs without restoration cannot inherit old tab ids')
  } finally { db.close() }
})

test('BA10: a finished turn or task keeps its tabs grouped; a lost session or task clears ownership in the same transaction', async t => {
  if (skipIfSqliteUnavailable(t, 'browser work tab invalidation')) return
  // The tab stays with its task when the turn ends, the task finishes or waits for the person, or a later run takes it.
  const kept = [
    ...['completed', 'failed', 'cancelled'].map(status => (db: Database.Database) => {
      assert.equal(new BrowserStore(() => db).updateBrowserTask('task', { status }), true)
    }),
    ...['completed', 'failed', 'killed'].map(status => (db: Database.Database) => {
      db.prepare('UPDATE task_projections SET status = ? WHERE task_id = ?').run(status, 'parent')
    }),
    (db: Database.Database) => { db.exec("UPDATE task_projections SET run_id = 'run-2'") },
    (db: Database.Database) => { db.exec("UPDATE browser_tasks SET active_execution_binding_json = '{\"runId\":\"run-2\"}'") },
  ]
  for (const change of kept) {
    const db = new Database(':memory:')
    try {
      seed(db)
      const { runtime, ownership } = controller(db)
      const opened = await runtime.createAgentWorkTab('task', 'https://work.test/', null)
      change(db)
      assert.equal(ownership.list().length, 1)
      assert.equal(runtime.getTabList()[0].browserTaskId, 'task')
      assert.deepEqual([...runtime.getTaskWorkTabIds('task')], [opened.tabId])
    } finally { db.close() }
  }
  const invalidations = [
    (db: Database.Database) => { db.exec("UPDATE chat_conversations SET closed_at = 'now'") },
    (db: Database.Database) => { db.exec('UPDATE chat_conversations SET message_visibility_epoch = 1') },
    (db: Database.Database) => {
      db.exec("INSERT INTO chat_conversations (id, agent, source_id, created_at, updated_at) VALUES ('scope-2', 'butler', 'scope-2', 'now', 'now'); UPDATE task_projections SET scope_id = 'scope-2'")
    },
    (db: Database.Database) => { db.exec('DELETE FROM chat_conversations') },
    (db: Database.Database) => { db.exec('DELETE FROM task_projections') },
    (db: Database.Database) => { db.exec('DELETE FROM browser_tasks') },
  ]
  for (const invalidate of invalidations) {
    const db = new Database(':memory:')
    try {
      seed(db)
      const { runtime, ownership, tabs } = controller(db)
      const opened = await runtime.createAgentWorkTab('task', 'https://work.test/', null)
      db.exec('BEGIN')
      invalidate(db)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_work_tab_ownership').get<{ n: number }>()?.n, 0)
      db.exec('ROLLBACK')
      assert.equal(ownership.list().length, 1, 'rollback restores the original ownership too')
      invalidate(db)
      assert.equal(runtime.getTabList()[0].browserTaskId, undefined)
      assert.deepEqual([...runtime.getTaskWorkTabIds('task')], [])
      assert.equal(runtime.getAgentWorkTab('task'), null)
      assert.equal(tabs.has(opened.tabId!), true, 'existing rule keeps the page as an ordinary tab')
    } finally { db.close() }
  }
})

test('BA10: late opens cannot replace the new run; failed writes and closes preserve explicit ordering', async t => {
  if (skipIfSqliteUnavailable(t, 'browser work tab write ordering')) return
  const db = new Database(':memory:')
  try {
    seed(db)
    const { runtime, ownership, tabs, effects } = controller(db)
    await runtime.createTab('https://user.test/')
    const create = runtime.createTab.bind(runtime)
    let finish!: () => void, opened!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const ready = new Promise<void>(resolve => { opened = resolve })
    runtime.createTab = async (...args) => { const result = await create(...args); opened(); await pending; return result }
    const oldOwner = ownership.captureOwner('task')
    const late = runtime.createAgentWorkTab('task', 'https://old.test/', null)
    await ready
    db.exec("UPDATE task_projections SET run_id = 'run-2'; UPDATE browser_tasks SET created_by_run_id = 'run-2', active_execution_binding_json = '{\"runId\":\"run-2\"}'")
    runtime.createTab = create
    const fresh = await runtime.createAgentWorkTab('task', 'https://new.test/', null)
    assert.equal(fresh.success, true)
    finish()
    const refused = await late
    assert.equal(refused.success, false)
    assert.match(refused.error!, /owner_changed/)
    assert.deepEqual(ownership.list().map(row => [row.tabId, row.ownerRunId]), [[fresh.tabId, 'run-2']])
    assert.deepEqual([...runtime.getTaskWorkTabIds('task')], [fresh.tabId])
    assert.throws(() => ownership.add({ id: fresh.tabId! }, null, oldOwner), /owner_changed/)

    db.exec("CREATE TRIGGER reject_save BEFORE INSERT ON browser_work_tab_ownership BEGIN SELECT RAISE(ABORT, 'save denied'); END")
    const unsaved = await runtime.createAgentWorkTab('task', 'https://unsaved.test/', null)
    assert.equal(unsaved.success, false)
    assert.match(unsaved.error!, /save denied/)
    assert.equal([...tabs.values()].some(tab => tab.url === 'https://unsaved.test/'), false)
    db.exec('DROP TRIGGER reject_save')

    runtime.createTab = async (...args) => {
      const result = await create(...args)
      assert.equal(runtime.closeTab(result.tabId!).success, true)
      return result
    }
    const alreadyClosed = await runtime.createAgentWorkTab('task', 'https://closed.test/', null)
    assert.equal(alreadyClosed.success, false)
    assert.equal([...tabs.values()].some(tab => tab.url === 'https://closed.test/'), false)
    assert.deepEqual(ownership.list().map(row => row.tabId), [fresh.tabId])
    runtime.createTab = create

    const shellClose = runtime.tabShellService.closeTab.bind(runtime.tabShellService)
    runtime.tabShellService.closeTab = () => {
      assert.equal(ownership.list().length, 0, 'ownership is removed before native close')
      return { success: false, error: 'native close failed' }
    }
    assert.equal(runtime.closeTab(fresh.tabId!).success, false)
    assert.equal(ownership.list().length, 1, 'failed close restores ownership')
    runtime.tabShellService.closeTab = shellClose
    const disposed = effects.length
    db.exec("CREATE TRIGGER reject_close BEFORE DELETE ON browser_work_tab_ownership BEGIN SELECT RAISE(ABORT, 'delete denied'); END")
    assert.throws(() => runtime.closeTab(fresh.tabId!), /delete denied/)
    assert.equal(effects.length, disposed, 'failed persistence must not dispose native resources')
    db.exec('DROP TRIGGER reject_close')
    assert.equal(runtime.closeTab(fresh.tabId!).success, true)
    assert.equal(ownership.list().length, 0)
    assert.equal(runtime.closeTab(fresh.tabId!).success, false)
    assert.equal(ownership.list().length, 0, 'repeated close does not recreate ownership')
  } finally { db.close() }
})
