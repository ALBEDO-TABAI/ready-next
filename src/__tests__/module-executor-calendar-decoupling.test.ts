import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { executeModuleToolAction } from '../renderer/modules/agent/moduleExecutor'

type WorkbenchMode = 'browser' | 'document' | 'rss' | 'calendar'
type ModuleHandler = (req: { module: string; action: string; args: Record<string, unknown> }) => Promise<unknown> | unknown

const previousWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = previousWindow
})

function installHandlers(handlers: Record<string, ModuleHandler>): void {
  ;(globalThis as { window?: { __readyModuleAgentHandlers?: Record<string, ModuleHandler> } }).window = {
    __readyModuleAgentHandlers: handlers,
  }
}

function runModuleTool(tool: string, onActivate: (mode: WorkbenchMode) => void) {
  return executeModuleToolAction({
    scopeId: 'scope',
    agentName: 'agent',
    tool,
    args: { start: '2026-05-01T00:00:00.000Z', end: '2026-05-31T23:59:59.000Z' },
    runId: 'run',
    activateWorkbenchMode: onActivate,
    upsertScopeRunState: () => { /* noop trace sink */ },
    getScopeRunState: () => null,
  })
}

describe('executeModuleToolAction · 日程 agent 与可见模式解耦', () => {
  it('calendar.* 工具不再强制切换工作台模式，仍派发到已注册的处理器', async () => {
    const activated: WorkbenchMode[] = []
    let handlerCalls = 0
    installHandlers({
      calendar: () => {
        handlerCalls += 1
        return { intent: 'list_calendar_window', summary: '已读取窗口', events: [] }
      },
    })

    const result = await runModuleTool('calendar.listWindow', (mode) => activated.push(mode))

    assert.equal(result.handled, true)
    assert.equal(handlerCalls, 1, '日程处理器应被调用')
    assert.equal(result.payload?.intent, 'list_calendar_window')
    assert.deepEqual(activated, [], '不应触发任何工作台模式切换')
  })

  it('只有 rss.selectItem 会切换到 RSS 工作面', async () => {
    const activated: WorkbenchMode[] = []
    installHandlers({
      rss: () => ({ intent: 'rss_action', summary: '已处理' }),
    })

    const analyzed = await runModuleTool('rss.analyzeItem', (mode) => activated.push(mode))
    assert.equal(analyzed.handled, true)
    assert.deepEqual(activated, [], '分析不得切换可见工作面')

    const selected = await runModuleTool('rss.selectItem', (mode) => activated.push(mode))
    assert.equal(selected.handled, true)
    assert.deepEqual(activated, ['rss'], '只有选中条目才允许导航到 RSS')
  })
})
