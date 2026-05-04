import assert from 'node:assert/strict'
import test from 'node:test'

import {
  unwrapAIConfigOrThrow,
  type AIConfigLoad,
} from '../main/modules/claude-bridge/direct-chat-ai-config'

/**
 * 2.4b — Behavior contract for `unwrapAIConfigOrThrow`, the helper that
 * `agent-manager.createClaudeProcess` uses to refuse to launch on corrupt
 * / DB-erroring config. The caller in `runWithSession` catches the throw
 * and falls back to mock mode with the actual reason in the output stream.
 *
 * Direct e2e of `createClaudeProcess` is impractical (spawns subprocess,
 * needs worktree pool); these tests pin the helper's contract instead.
 */

test('unwrapAIConfigOrThrow returns null when config is absent', () => {
  const detail: AIConfigLoad = { ok: true, config: null, reason: 'absent' }
  assert.equal(unwrapAIConfigOrThrow(detail), null)
})

test('unwrapAIConfigOrThrow returns config when ok+present', () => {
  const detail: AIConfigLoad = {
    ok: true,
    config: {
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-abc',
      model: 'gpt-4o-mini',
    },
    reason: 'present',
  }
  const result = unwrapAIConfigOrThrow(detail)
  assert.notEqual(result, null)
  assert.equal(result?.apiKey, 'sk-abc')
})

test('unwrapAIConfigOrThrow throws specific message on json_corrupt', () => {
  const detail: AIConfigLoad = { ok: false, reason: 'json_corrupt', message: 'unexpected token' }
  assert.throws(
    () => unwrapAIConfigOrThrow(detail),
    /AI 配置已损坏（JSON 解析失败）/,
  )
})

test('unwrapAIConfigOrThrow throws specific message on db_error', () => {
  const detail: AIConfigLoad = { ok: false, reason: 'db_error', message: 'SQLITE_BUSY' }
  assert.throws(
    () => unwrapAIConfigOrThrow(detail),
    /AI 配置读取失败（数据库错误）/,
  )
})
