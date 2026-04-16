import assert from 'node:assert/strict'
import test from 'node:test'

import { detectGenericInteractionState } from '../main/modules/agent-control/interaction-state-detector'

test('interaction detector promotes clarification replies into awaiting_clarification state', () => {
  const result = detectGenericInteractionState('为了继续执行，请提供你想写入的文档标题？')

  assert.equal(result?.interactionState, 'awaiting_clarification')
  assert.equal(result?.waitingFor, 'input')
})

test('interaction detector promotes confirmation replies into awaiting_confirmation state', () => {
  const result = detectGenericInteractionState('我已经整理好方案了，请确认是否继续执行。')

  assert.equal(result?.interactionState, 'awaiting_confirmation')
  assert.equal(result?.waitingFor, 'confirmation')
})

test('interaction detector promotes human takeover replies into human_takeover state', () => {
  const result = detectGenericInteractionState('这里需要你手动登录并处理验证码，完成后告诉我。')

  assert.equal(result?.interactionState, 'human_takeover')
  assert.equal(result?.waitingFor, 'agent_result')
})
