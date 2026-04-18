import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

// NOTE: Behavior tests cannot import DocumentTaskPipelineExecutor directly because the
// module graph pulls in `document-engine/ipc-handler` which imports from `electron`.
// We assert the contract by static-source inspection of the executor surface plus
// regression sentinels against direct-chat. A future refactor that splits the
// electron-free helpers into their own module would let us upgrade these to true
// runtime tests.

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline-executor.ts',
)
const DIRECT_CHAT_PATH = resolve(
  process.cwd(),
  'src/main/modules/claude-bridge/direct-chat.ts',
)

describe('document insight shared cache host contract', () => {
  it('keeps direct chat free of the legacy session-local cache arrays', () => {
    const directChat = readFileSync(DIRECT_CHAT_PATH, 'utf8')

    assert.doesNotMatch(directChat, /documentInsightCache: Array</)
    assert.doesNotMatch(directChat, /documentWidgetDraftCache: Array</)
    assert.doesNotMatch(directChat, /session\.documentInsightCache/)
    assert.doesNotMatch(directChat, /session\.documentWidgetDraftCache/)
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

  it('keeps direct-chat wiring the executor into the session lifecycle events', () => {
    const directChat = readFileSync(DIRECT_CHAT_PATH, 'utf8')

    assert.match(directChat, /this\.documentTaskPipelineExecutor\.clearSessionCache\(name\)/)
  })
})
