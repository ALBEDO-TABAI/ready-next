import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('document task pipeline host contract', () => {
  it('surfaces partial document pipeline results instead of failing the whole run immediately', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )

    assert.match(
      source,
      /if \(!pipelineResult\.success\) \{[\s\S]*if \(pipelineResult\.finalText\) \{[\s\S]*emitOutput\(pipelineResult\.finalText, 'text'\)[\s\S]*return \{ success: true, executionDiagnostics: buildExecutionDiagnostics\(\) \}/,
    )
  })
})
