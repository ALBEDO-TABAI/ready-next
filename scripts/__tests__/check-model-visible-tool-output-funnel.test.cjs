'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-model-visible-tool-output-funnel.cjs')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-visible-funnel-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writeBaseline(root) {
  write(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
import { buildModelVisibleToolResultPayload, redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
const payload = buildModelVisibleToolResultPayload(output)
const trace = redactModelVisibleToolText(text)
`)
  write(root, 'src/main/modules/agent-control/runtime-core/turn-transcript.ts', `
import { serializeToolExecutionOutputForModel } from '../tools-runtime/model-visible-tool-output'
serializeToolExecutionOutputForModel(output)
`)
  write(root, 'src/main/modules/agent-control/domain-adapters/document-domain-orchestrator.ts', `
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
redactModelVisibleToolText(text)
`)
  write(root, 'src/main/modules/claude-bridge/tool-bridge.ts', `
import { serializeToolExecutionOutputForModel } from '../agent-control/tools-runtime/model-visible-tool-output'
serializeToolExecutionOutputForModel(result)
`)
  write(root, 'src/main/modules/claude-bridge/openai-history-sanitization.ts', `
import { redactModelVisibleToolText } from '../agent-control/tools-runtime/model-visible-tool-output'
redactModelVisibleToolText(text)
`)
  write(root, 'src/main/modules/agent-control/skills/skill-context-orchestrator.ts', `
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
const modelVisibleText = redactModelVisibleToolText(result.text)
params.emitOutput(modelVisibleText.slice(0, 600), 'tool_result')
this.extractSkillReferenceContent(modelVisibleText)
`)
  // Phase C C4/C5（2026-07-05）：direct-chat.ts 已退役删除并移出
  // RAW_SERIALIZER_FORBIDDEN_FILES，baseline 不再铺设该文件。
}

test('gate passes for current model-visible funnel shape', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when a model-visible file imports raw serializeToolExecutionOutput', (t) => {
  // 合同随实现同步（Phase C C4/C5，2026-07-05）：direct-chat.ts 退役并移出禁用
  // 清单，fixture 改锚仍在 RAW_SERIALIZER_FORBIDDEN_FILES 里的 tool-bridge.ts。
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/claude-bridge/tool-bridge.ts', `
import { serializeToolExecutionOutputForModel } from '../agent-control/tools-runtime/model-visible-tool-output'
import { serializeToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
serializeToolExecutionOutputForModel(result)
serializeToolExecutionOutput(result)
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('raw_tool_output_serializer_in_model_visible_file:src/main/modules/claude-bridge/tool-bridge.ts')))
})

test('gate allows serializeToolExecutionOutputForModel', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/claude-bridge/tool-bridge.ts', `
import { serializeToolExecutionOutputForModel } from '../agent-control/tools-runtime/model-visible-tool-output'
serializeToolExecutionOutputForModel(result)
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when the reference-skill fallback emits raw result text', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/skills/skill-context-orchestrator.ts', `
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
params.emitOutput(result.text.slice(0, 600), 'tool_result')
const content = this.extractSkillReferenceContent(redactModelVisibleToolText(result.text))
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('raw_reference_skill_emit')))
})

test('gate fails when the reference-skill fallback injects raw result text', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/skills/skill-context-orchestrator.ts', `
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
const modelVisibleText = redactModelVisibleToolText(result.text)
params.emitOutput(modelVisibleText.slice(0, 600), 'tool_result')
const content = this.extractSkillReferenceContent(result.text)
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('raw_reference_skill_injection')))
})

test('gate fails when a required model-visible file loses the funnel import', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/runtime-core/turn-transcript.ts', `
export class TurnTranscript {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('missing_model_visible_funnel:src/main/modules/agent-control/runtime-core/turn-transcript.ts')))
})
