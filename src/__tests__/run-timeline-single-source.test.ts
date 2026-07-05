/**
 * Phase D（2026-07-05）—— run-timeline 事件单源行为合同。
 *
 * D1：唯一发射漏斗 emitRunTimelineEvent 必须原样透传负载并盖 timeline
 * 信封戳（v/channel/at）；窗口销毁静默不发。
 * D2：renderer 侧 scopeRunEvent 的会话路由终态转移已并入 runtimeDriver
 * 单枢纽——useAgent.initAgentInteractionListeners 不再并行订阅（双真相源
 * 收敛）。订阅面与主进程发射面的全仓单源由
 * scripts/check-run-timeline-single-source.cjs gate 钉守。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitRunTimelineEvent } from '../main/modules/claude-bridge/run-timeline-emitter'

function makeWindowDouble(destroyed = false) {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    window: {
      isDestroyed: () => destroyed,
      webContents: {
        send: (channel: string, payload: Record<string, unknown>) => {
          sent.push({ channel, payload })
        },
      },
    } as never,
  }
}

test('emitRunTimelineEvent stamps the envelope and passes the payload through', () => {
  const { window, sent } = makeWindowDouble()
  const fixedNow = () => new Date('2026-07-05T12:00:00.000Z')
  const delivered = emitRunTimelineEvent(window, 'agent:scopeRunEvent', {
    scopeId: 'conv-1',
    sessionId: 'conv-1',
    phase: 'done',
    runId: 'req-9',
  }, { now: fixedNow })

  assert.equal(delivered, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channel, 'agent:scopeRunEvent')
  assert.equal(sent[0].payload.scopeId, 'conv-1')
  assert.equal(sent[0].payload.runId, 'req-9')
  assert.deepEqual(sent[0].payload.timeline, {
    v: 1,
    channel: 'agent:scopeRunEvent',
    at: '2026-07-05T12:00:00.000Z',
  })
})

test('emitRunTimelineEvent stays silent for a destroyed or missing window', () => {
  const { window, sent } = makeWindowDouble(true)
  assert.equal(emitRunTimelineEvent(window, 'agent:stream', { chunk: 'x' }), false)
  assert.equal(sent.length, 0)
  assert.equal(emitRunTimelineEvent(null, 'agent:stream', { chunk: 'x' }), false)
})

test('D2: useAgent no longer keeps a parallel scopeRunEvent subscription (single renderer hub)', () => {
  const useAgentSource = readFileSync(join(process.cwd(), 'src/renderer/stores/useAgent.ts'), 'utf8')
  assert.doesNotMatch(useAgentSource, /onScopeRunEvent\(/, 'useAgent must not subscribe scopeRunEvent directly')
  const driverSource = readFileSync(join(process.cwd(), 'src/renderer/modules/agent/runtimeDriver.ts'), 'utf8')
  assert.match(driverSource, /mapScopeRunPhaseToSessionState/, 'session routing transition must live in the driver hub')
})
