import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveChatSessionTitle } from '../renderer/components/agent/chat-panel/helpers/session-title'

test('resolveChatSessionTitle hides absent / blank titles', () => {
  assert.equal(resolveChatSessionTitle(undefined), '')
  assert.equal(resolveChatSessionTitle(null), '')
  assert.equal(resolveChatSessionTitle(''), '')
  assert.equal(resolveChatSessionTitle('   '), '')
})

test('resolveChatSessionTitle hides placeholder titles a fresh scope carries', () => {
  // A just-created scope keeps these until the first message is sent; the
  // header must stay blank in that "user has not started a session" state.
  assert.equal(resolveChatSessionTitle('新对话'), '')
  assert.equal(resolveChatSessionTitle('未命名会话'), '')
  assert.equal(resolveChatSessionTitle('  新对话  '), '')
})

test('resolveChatSessionTitle returns the trimmed real title', () => {
  assert.equal(resolveChatSessionTitle('帮我写一封邮件'), '帮我写一封邮件')
  assert.equal(resolveChatSessionTitle('  分析这个网页  '), '分析这个网页')
  // A real title that merely contains a placeholder word is kept verbatim.
  assert.equal(resolveChatSessionTitle('新对话的草稿'), '新对话的草稿')
})
