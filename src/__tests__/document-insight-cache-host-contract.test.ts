import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('document insight shared cache host contract', () => {
  it('moves the shared insight cache out of direct chat and into the document pipeline executor', () => {
    const directChat = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    const executor = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/document-task-pipeline-executor.ts'),
      'utf8',
    )

    assert.doesNotMatch(directChat, /private readonly documentInsightCache = new DocumentInsightCache\(\)/)
    assert.doesNotMatch(directChat, /const sharedHit = this\.documentInsightCache\.get\(key\)/)
    assert.doesNotMatch(directChat, /this\.documentInsightCache\.set\(key, \{ insight, metrics \}\)/)
    assert.match(executor, /private readonly documentInsightCache = new DocumentInsightCache\(\)/)
    assert.match(executor, /const sharedHit = this\.documentInsightCache\.get\(key\)/)
    assert.match(executor, /this\.documentInsightCache\.set\(key, \{ insight, metrics \}\)/)
  })

  it('removes the session-local cache arrays from DirectChatSession and stops reading them', () => {
    const directChat = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )

    assert.doesNotMatch(directChat, /documentInsightCache: Array</)
    assert.doesNotMatch(directChat, /documentWidgetDraftCache: Array</)
    assert.doesNotMatch(directChat, /documentInsightCache: \[\],/)
    assert.doesNotMatch(directChat, /documentWidgetDraftCache: \[\],/)
    assert.doesNotMatch(directChat, /session\.documentInsightCache/)
    assert.doesNotMatch(directChat, /session\.documentWidgetDraftCache/)
  })

  it('gives the executor a per-session cache container plus a clearSessionCache escape hatch', () => {
    const executor = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/document-task-pipeline-executor.ts'),
      'utf8',
    )

    assert.match(executor, /private readonly sessionInsightCaches = new Map</)
    assert.match(executor, /private readonly sessionWidgetDraftCaches = new Map</)
    assert.match(executor, /clearSessionCache\(sessionId: string\): void/)
    assert.match(executor, /this\.sessionInsightCaches\.delete\(sessionId\)/)
    assert.match(executor, /this\.sessionWidgetDraftCaches\.delete\(sessionId\)/)
    assert.match(executor, /this\.sessionInsightCaches\.set\(sessionId, nextEntries\)/)
    assert.match(executor, /this\.sessionWidgetDraftCaches\.set\(sessionId, nextEntries\)/)
  })

  it('keeps direct-chat wiring the executor into the session lifecycle events', () => {
    const directChat = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )

    assert.match(directChat, /this\.documentTaskPipelineExecutor\.clearSessionCache\(name\)/)
  })
})
