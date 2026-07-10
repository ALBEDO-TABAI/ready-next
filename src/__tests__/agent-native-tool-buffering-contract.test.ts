import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import {
  NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS,
  splitNativeTextBufferForSafeFlush,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'

// The model/tool loop owns native-text buffering after the orchestrator split.
const turnModelLoopSource = () => readFileSync(join(process.cwd(), 'src/main/modules/agent-control/runtime-core/agent-sdk-turn-model-loop.ts'), 'utf-8')

test('native tool text buffering applies whenever native tools are exposed, including OpenAI providers', (t) => {
  skipIfSqliteUnavailable(t, 'native-tool-buffering transitive sqlite load')
  const text = turnModelLoopSource()
  assert.match(text, /const bufferNativeTextUntilParsed =\s*!useTextToolBridge\s*&& toolDefinitions\.length > 0/)
  assert.doesNotMatch(text, /normalizedConfig\.provider !== 'openai'/)
})

test('native tool text buffering has a safe flush cap for ordinary non-XML text', (t) => {
  skipIfSqliteUnavailable(t, 'native-tool-buffering transitive sqlite load')
  // 重锚 a15a8eb3（refactor: split AgentSdkRuntime god-file, V3 phases 1-2）：
  // cap 常量与 flush 判定从 agent-sdk-runtime.ts 内联块迁至 agent-sdk-utils 的
  // splitNativeTextBufferForSafeFlush（默认 hardLimit = NATIVE_TEXT_BUFFER_
  // SAFE_FLUSH_CHARS）。合同不变量改用行为断言直接证明，另钉 orchestrator
  // 的 flush 路径确实走共享 splitter。
  assert.equal(NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS, 4000)

  // Ordinary non-XML text over the cap flushes fully instead of being held.
  const longPlain = '这是一段普通文本。'.repeat(500) // 4500 chars, no tool markers
  assert.ok(longPlain.length > NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS)
  const flushed = splitNativeTextBufferForSafeFlush(longPlain)
  assert.equal(flushed.emitText, longPlain)
  assert.equal(flushed.remainingText, '')

  // Under the cap without a marker, text keeps buffering (no premature emit).
  const shortPlain = '普通文本'.repeat(100) // 400 chars
  const held = splitNativeTextBufferForSafeFlush(shortPlain)
  assert.equal(held.emitText, '')
  assert.equal(held.remainingText, shortPlain)

  // Marker-bearing text splits at the marker regardless of length, so tool
  // call payloads are never flushed as visible text.
  const prefix = '前置文本'.repeat(1200) // 4800 chars
  const withMarker = `${prefix}<tool_call>{"name":"x"}`
  const split = splitNativeTextBufferForSafeFlush(withMarker)
  assert.equal(split.emitText, prefix)
  assert.ok(split.remainingText.startsWith('<tool_call'))

  // Wiring: the turn loop's flush path routes through the shared splitter.
  const modelLoop = turnModelLoopSource()
  assert.match(modelLoop, /splitNativeTextBufferForSafeFlush\(nativeTextBuffer,\s*\{ flushWithoutMarker \}\)/)
})
