import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

// NOTE: Behavior tests cannot import DocumentTaskPipelineExecutor directly because the
// module graph pulls in `document-engine/ipc-handler` which imports from `electron`.
// We assert the contract by static-source inspection of the executor surface plus a
// regression sentinel against direct-chat. A future refactor that splits the
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

describe('document task pipeline host contract', () => {
  it('keeps document pipeline ownership outside of direct chat (regression sentinel)', () => {
    const directChat = readFileSync(DIRECT_CHAT_PATH, 'utf8')

    assert.doesNotMatch(directChat, /private async maybeRunDocumentWidgetPipelineShortcut\(/)
  })

  it('exposes a tryExecute entry point on the extracted executor', () => {
    const executor = readFileSync(EXECUTOR_PATH, 'utf8')

    assert.match(
      executor,
      /async tryExecute\(params:\s*DocumentTaskPipelineExecutionParams\):\s*Promise<DocumentTaskPipelineExecutionResult>/,
    )
  })

  it('routes structured create/update intents through the dedicated widget pipeline', () => {
    const executor = readFileSync(EXECUTOR_PATH, 'utf8')

    assert.match(executor, /private async runDocumentWidgetPipeline\(/)
    assert.match(executor, /structuredDocumentIntent === 'document_read_then_widget_create'/)
    assert.match(executor, /structuredDocumentIntent === 'document_read_then_widget_update'/)
  })

  it('routes document task plans through the dedicated plan executor', () => {
    const executor = readFileSync(EXECUTOR_PATH, 'utf8')

    assert.match(executor, /private async runDocumentTaskPlan\(/)
    assert.match(executor, /shouldUseDocumentTaskPlan/)
  })
})
