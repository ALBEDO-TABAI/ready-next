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
})
