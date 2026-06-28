import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = () => readFileSync(join(process.cwd(), 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts'), 'utf-8')
// The sendMessage turn loop (incl. native-text buffering) was extracted to
// AgentSdkTurnOrchestrator (V3 Phase 5-B).
const turnOrchestratorSource = () => readFileSync(join(process.cwd(), 'src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts'), 'utf-8')

test('native tool text buffering applies whenever native tools are exposed, including OpenAI providers', () => {
  const text = turnOrchestratorSource()
  assert.match(text, /const bufferNativeTextUntilParsed =\n\s*!useTextToolBridge\n\s*&& toolDefinitions\.length > 0/)
  assert.doesNotMatch(text, /normalizedConfig\.provider !== 'openai'/)
})

test('native tool text buffering has a safe flush cap for ordinary non-XML text', () => {
  const text = source()
  assert.match(text, /const NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS = 4000/)
  assert.match(text, /streamedText\.length > NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS/)
  assert.match(text, /!\/<tool_call\|<function=\|<parameter=\|:::tool_call\/i\.test\(streamedText\)/)
})
