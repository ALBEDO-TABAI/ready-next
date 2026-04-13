import { describe, it } from 'node:test'
import assert from 'node:assert'

import { createScopedRunCollector } from '../main/modules/agent-control/run-collector'

describe('createScopedRunCollector', () => {
    it('should accumulate assistant text and used tools for a scoped run', async () => {
        const collector = createScopedRunCollector({
            agent: 'butler',
            sessionId: 'scope-feishu-1',
            requestId: 'req-1',
        })

        collector.handleStatus({ agent: 'butler', sessionId: 'scope-feishu-1', runId: 'req-1', status: 'working' })
        collector.handleOutput({
            agent: 'butler',
            sessionId: 'scope-feishu-1',
            runId: 'req-1',
            type: 'tool_use',
            chunk: 'browser_click_at(x=512,y=880)',
        })
        collector.handleOutput({
            agent: 'butler',
            sessionId: 'scope-feishu-1',
            runId: 'req-1',
            type: 'text',
            chunk: '今晚可以',
        })
        collector.handleOutput({
            agent: 'butler',
            sessionId: 'scope-feishu-1',
            runId: 'req-1',
            type: 'text',
            chunk: '吃面或者煲仔饭。',
        })
        collector.handleStatus({ agent: 'butler', sessionId: 'scope-feishu-1', runId: 'req-1', status: 'done' })

        const result = await collector.result
        assert.strictEqual(result.success, true)
        assert.strictEqual(result.cancelled, false)
        assert.strictEqual(result.finalText, '今晚可以吃面或者煲仔饭。')
        assert.deepStrictEqual(result.usedTools, ['browser_click_at'])
        assert.strictEqual(result.error, undefined)
    })

    it('should surface runtime errors without polluting finalText with tool payloads', async () => {
        const collector = createScopedRunCollector({
            agent: 'butler',
            sessionId: 'scope-feishu-2',
            requestId: 'req-2',
        })

        collector.handleOutput({
            agent: 'butler',
            sessionId: 'scope-feishu-2',
            runId: 'req-2',
            type: 'tool_use',
            chunk: 'browser_query_gemini(text="今晚吃什么")',
        })
        collector.handleError({
            agent: 'butler',
            sessionId: 'scope-feishu-2',
            runId: 'req-2',
            error: 'Gemini page did not produce a response',
        })
        collector.handleStatus({ agent: 'butler', sessionId: 'scope-feishu-2', runId: 'req-2', status: 'error' })

        const result = await collector.result
        assert.strictEqual(result.success, false)
        assert.strictEqual(result.cancelled, false)
        assert.strictEqual(result.finalText, '')
        assert.deepStrictEqual(result.usedTools, ['browser_query_gemini'])
        assert.strictEqual(result.error, 'Gemini page did not produce a response')
    })
})
