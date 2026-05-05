import assert from 'node:assert/strict'
import test from 'node:test'

import type { ScopeRunState } from '../renderer/modules/agent/types'
import { createPetActivitySnapshot } from '../renderer/modules/pet/petActivitySnapshot'

test('createPetActivitySnapshot hides the bubble when the active run is idle or done', () => {
  assert.equal(createPetActivitySnapshot(null).busy, false)
  assert.equal(createPetActivitySnapshot({
    scopeId: 'scope-1',
    agent: 'codex',
    requestId: 'req-1',
    phase: 'done',
    toolTrace: [],
    startedAt: null,
    updatedAt: '2026-05-04T12:00:00.000Z',
  }).busy, false)
})

test('createPetActivitySnapshot produces balanced, sanitized working summaries', () => {
  const run: ScopeRunState = {
    scopeId: 'scope-1',
    agent: 'codex',
    requestId: 'req-1',
    phase: 'tool_running',
    taskId: 'task-1',
    toolTrace: [
      {
        id: 'tool-1',
        kind: 'call',
        text: 'skill_run_shell({"command":"cat /Users/me/private.txt"})\nSTDOUT:\nlong output',
        timestamp: new Date('2026-05-04T12:00:01.000Z'),
      },
      {
        id: 'tool-2',
        kind: 'result',
        text: '读取完成\n更多日志',
        timestamp: new Date('2026-05-04T12:00:02.000Z'),
      },
    ],
    startedAt: '2026-05-04T12:00:00.000Z',
    updatedAt: '2026-05-04T12:00:02.000Z',
    taskTitle: '接入桌面宠物',
    taskSummary: '正在整理宠物窗口状态',
  }
  const snapshot = createPetActivitySnapshot(run)

  assert.equal(snapshot.busy, true)
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.title, '正在调用工具')
  assert.equal(snapshot.summary, '正在整理宠物窗口状态')
  assert.equal(snapshot.events.length, 2)
  assert.equal(snapshot.events[0].text, '运行本地命令')
  assert.equal(snapshot.events[1].text, '读取完成…')
})

test('createPetActivitySnapshot keeps the pet bubble concise and path-safe', () => {
  const run: ScopeRunState = {
    scopeId: 'scope-1',
    agent: 'codex',
    requestId: 'req-1',
    phase: 'tool_running',
    toolTrace: [
      {
        id: 'tool-1',
        kind: 'call',
        text: 'functions.exec_command({"cmd":"cat /Users/user/Documents/实验田/ready-cowork/src/renderer/pages/PetWindow.tsx"})',
        timestamp: new Date('2026-05-04T12:00:01.000Z'),
      },
      {
        id: 'tool-2',
        kind: 'result',
        text: '输出了一段非常非常非常非常非常非常非常非常非常长的工具日志 /Users/user/private/token.txt',
        timestamp: new Date('2026-05-04T12:00:02.000Z'),
      },
      {
        id: 'tool-3',
        kind: 'result',
        text: '第二段日志',
        timestamp: new Date('2026-05-04T12:00:03.000Z'),
      },
      {
        id: 'tool-4',
        kind: 'result',
        text: '第三段日志',
        timestamp: new Date('2026-05-04T12:00:04.000Z'),
      },
    ],
    steps: [
      { id: 'step-1', title: '收紧猫猫气泡内容和尺寸', status: 'running' },
    ],
    currentStepId: 'step-1',
    startedAt: '2026-05-04T12:00:00.000Z',
    updatedAt: '2026-05-04T12:00:04.000Z',
    taskTitle: '修复宠物气泡',
    taskSummary: '正在读取 /Users/user/Documents/实验田/ready-cowork/src/renderer/pages/PetWindow.tsx 里面的一整段非常长非常长非常长的实现细节',
    latestText: '这是一段模型回复缓冲，长度也可能持续增长',
    responseBuffer: '更长的模型回复缓冲',
  }

  const snapshot = createPetActivitySnapshot(run)

  assert.equal(snapshot.summary, '收紧猫猫气泡内容和尺寸')
  assert.equal(snapshot.events.length, 3)
  assert.equal(snapshot.events[0].text, '运行本地命令')
  for (const event of snapshot.events) {
    assert.equal(event.text.includes('/Users/user'), false)
    assert.ok([...event.text].length <= 36, `event text was too long: ${event.text}`)
  }
})
