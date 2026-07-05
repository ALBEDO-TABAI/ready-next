import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

// NOTE: Behavior tests cannot import DocumentTaskPipelineExecutor directly because the
// module graph pulls in `document-engine/ipc-handler` which imports from `electron`.
// We assert the contract by static-source inspection of the executor surface plus
// regression sentinels against the assembly shell. A future refactor that splits the
// electron-free helpers into their own module would let us upgrade these to true
// runtime tests.
// 合同随实现同步（Phase C C4/C5，2026-07-05）：DirectChatEngine 退役，装配壳与
// session 生命周期接线锚点移至 domain-adapter-host.ts。

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)
const HOST_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/domain-adapters/domain-adapter-host.ts',
)

describe('document insight shared cache host contract', () => {
  it('keeps the domain adapter host free of the legacy session-local cache arrays', () => {
    const host = readFileSync(HOST_PATH, 'utf8')

    assert.doesNotMatch(host, /documentInsightCache: Array</)
    assert.doesNotMatch(host, /documentWidgetDraftCache: Array</)
    assert.doesNotMatch(host, /session\.documentInsightCache/)
    assert.doesNotMatch(host, /session\.documentWidgetDraftCache/)
  })

  it('declares per-session cache containers as Maps owned by the executor', () => {
    const executor = readFileSync(EXECUTOR_PATH, 'utf8')

    assert.match(
      executor,
      /private readonly sessionInsightCaches = new Map<\s*string\s*,/,
      'sessionInsightCaches must be a per-session Map keyed by sessionId',
    )
    assert.match(
      executor,
      /private readonly sessionWidgetDraftCaches = new Map<\s*string\s*,/,
      'sessionWidgetDraftCaches must be a per-session Map keyed by sessionId',
    )
  })

  it('exposes clearSessionCache(sessionId) that purges both per-session caches', () => {
    const executor = readFileSync(EXECUTOR_PATH, 'utf8')

    assert.match(executor, /clearSessionCache\(sessionId:\s*string\):\s*void/)

    const clearMatch = executor.match(/clearSessionCache\(sessionId:\s*string\):\s*void\s*\{[\s\S]*?\n\s*\}/)
    assert.ok(clearMatch, 'clearSessionCache method body should be locatable')
    assert.match(clearMatch![0], /this\.sessionInsightCaches\.delete\(sessionId\)/)
    assert.match(clearMatch![0], /this\.sessionWidgetDraftCaches\.delete\(sessionId\)/)
  })

  it('keeps the domain adapter host wiring the executor into the session lifecycle events', () => {
    const host = readFileSync(HOST_PATH, 'utf8')

    assert.match(host, /this\.documentTaskPipelineExecutor\.clearSessionCache\(name\)/)
  })
})
