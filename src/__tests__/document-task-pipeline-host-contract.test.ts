import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('document task pipeline host contract', () => {
  it('keeps document pipeline ownership in the extracted executor instead of direct chat', () => {
    const directChat = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    const executor = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/document-task-pipeline-executor.ts'),
      'utf8',
    )

    assert.doesNotMatch(directChat, /private async maybeRunDocumentWidgetPipelineShortcut\(/)
    assert.match(executor, /private async runDocumentWidgetPipeline\(/)
    assert.match(executor, /private async runDocumentTaskPlan\(/)
  })
})
