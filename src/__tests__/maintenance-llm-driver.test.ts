import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  MAINTENANCE_LLM_ROUND_ENABLED_KEY,
  MAINTENANCE_LLM_ROUND_LAST_RUN_KEY,
  collectMaintenanceSignalsFromStore,
  maintenanceSignalsAreEmpty,
  runMaintenanceLlmRoundTick,
} from '../main/modules/agent-control/maintenance/maintenance-llm-driver'

// D7 合同（2026-07-05-p3-backlog-closeout-implementation.md §2.3）：三层预算闸
// 全部代码可证——专项开关 off 零调用；durable lastRunAt 6h 内零调用；空信号
// 零调用；有 staged 信号且节奏到点→单调用+成功后写回 lastRunAt；runner 失败
// 不占节奏窗口。

function makeSettings(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial))
  return {
    rows,
    getSetting: (key: string) => rows.get(key),
    setSetting: (key: string, value: string) => { rows.set(key, value) },
  }
}

function makeStoreWithStagedCard(root: string): BeliefCardStore {
  const store = new BeliefCardStore({ memoryRoot: root })
  const written = store.writeCard({
    relPath: 'knowledge/test-staged-card.md',
    frontmatter: {
      title: '测试 staged 卡',
      description: '驱动测试用的 staged 信号',
      confidence: 'L' as never,
      tag: 'knowledge' as never,
      created: '2026-07-05',
      status: 'staged',
    },
    body: '正文',
  })
  assert.equal(written.ok, true, `staged seed card must write: ${JSON.stringify(written)}`)
  return store
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'maintenance-driver-'))
}

const NOW = new Date('2026-07-05T12:00:00.000Z')

test('专项开关 off → 零 LLM 调用、不写 lastRunAt', async () => {
  const root = tempRoot()
  try {
    const store = makeStoreWithStagedCard(root)
    const settings = makeSettings({ [MAINTENANCE_LLM_ROUND_ENABLED_KEY]: 'false' })
    let llmCalls = 0
    const report = await runMaintenanceLlmRoundTick({
      settings,
      store,
      loadAIConfig: () => ({ ok: false, reason: 'missing', config: null }) as never,
      now: () => NOW,
      llm: async () => { llmCalls += 1; return '[]' },
    })
    assert.equal(report, null)
    assert.equal(llmCalls, 0)
    assert.equal(settings.rows.has(MAINTENANCE_LLM_ROUND_LAST_RUN_KEY), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('空信号 → 零调用（不烧无意义轮次）', async () => {
  const root = tempRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.equal(maintenanceSignalsAreEmpty(collectMaintenanceSignalsFromStore(store)), true)
    let llmCalls = 0
    const report = await runMaintenanceLlmRoundTick({
      settings: makeSettings(),
      store,
      loadAIConfig: () => ({ ok: false, reason: 'missing', config: null }) as never,
      now: () => NOW,
      llm: async () => { llmCalls += 1; return '[]' },
    })
    assert.equal(report, null)
    assert.equal(llmCalls, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('durable lastRunAt 6h 内 → EP2-C2 门控 skip、零调用、lastRunAt 不被覆盖', async () => {
  const root = tempRoot()
  try {
    const store = makeStoreWithStagedCard(root)
    const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString() // 1h ago
    const settings = makeSettings({ [MAINTENANCE_LLM_ROUND_LAST_RUN_KEY]: recent })
    let llmCalls = 0
    const report = await runMaintenanceLlmRoundTick({
      settings,
      store,
      loadAIConfig: () => ({ ok: false, reason: 'missing', config: null }) as never,
      now: () => NOW,
      llm: async () => { llmCalls += 1; return '[]' },
    })
    assert.equal(report?.decision, 'skip')
    assert.equal(report?.llmCalls, 0)
    assert.equal(llmCalls, 0)
    assert.equal(settings.rows.get(MAINTENANCE_LLM_ROUND_LAST_RUN_KEY), recent)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('staged 信号 + 节奏到点 → 单调用、staged 写卡、成功后写回 lastRunAt', async () => {
  const root = tempRoot()
  try {
    const store = makeStoreWithStagedCard(root)
    const stale = new Date(NOW.getTime() - 7 * 60 * 60_000).toISOString() // 7h ago
    const settings = makeSettings({ [MAINTENANCE_LLM_ROUND_LAST_RUN_KEY]: stale })
    let llmCalls = 0
    let seenPrompt = ''
    const report = await runMaintenanceLlmRoundTick({
      settings,
      store,
      loadAIConfig: () => ({ ok: false, reason: 'missing', config: null }) as never,
      now: () => NOW,
      llm: async (prompt) => {
        llmCalls += 1
        seenPrompt = prompt
        return JSON.stringify([{
          relPath: 'knowledge/merged-from-round.md',
          title: '维护轮产卡',
          description: '由维护轮建议合并',
          confidence: 'L',
          tag: 'knowledge',
          body: '合并建议正文',
        }])
      },
    })
    assert.equal(report?.decision, 'run')
    assert.equal(report?.llmCalls, 1)
    assert.equal(llmCalls, 1)
    assert.match(seenPrompt, /测试 staged 卡/, 'staged signal must reach the prompt')
    assert.equal(report?.applied, 1)
    const produced = store.readCard('knowledge/merged-from-round.md', { includeStaged: true })
    assert.ok(produced, 'round-written card must exist')
    assert.equal(produced?.frontmatter.status, 'staged', 'LLM 铸不出 active 卡 — 强制 staged')
    assert.equal(settings.rows.get(MAINTENANCE_LLM_ROUND_LAST_RUN_KEY), NOW.toISOString())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('LLM 抛错 → runner 面包屑终态、不写 lastRunAt（失败轮不占节奏窗口）', async () => {
  const root = tempRoot()
  try {
    const store = makeStoreWithStagedCard(root)
    const settings = makeSettings()
    const report = await runMaintenanceLlmRoundTick({
      settings,
      store,
      loadAIConfig: () => ({ ok: false, reason: 'missing', config: null }) as never,
      now: () => NOW,
      llm: async () => { throw new Error('provider_down') },
    })
    assert.equal(report?.decision, 'run')
    // 容器把生成器抛错折叠成 'failed'（迭代器自身崩溃才是 runner_error:*）
    assert.equal(report?.terminal, 'failed')
    assert.equal(settings.rows.has(MAINTENANCE_LLM_ROUND_LAST_RUN_KEY), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
