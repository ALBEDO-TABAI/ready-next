import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('document tool session context', () => {
  it('persists the last resolved document context input on the chat session', () => {
    const directChatSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    const turnEngineSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'),
      'utf8',
    )

    assert.match(directChatSource, /lastDocumentContextInput\?: string \| null/)
    // The read pattern (feeding session state into the turn engine) now lives on turn-engine.
    assert.match(turnEngineSource, /lastDocumentContextInput:\s*session\.lastDocumentContextInput/)
    // Assignment also lives on the turn engine: lease-sticky or forceDocumentTool both persist.
    assert.match(turnEngineSource, /session\.lastDocumentContextInput = contextualUserInput/)
    assert.match(
      turnEngineSource,
      /executionIntentContext\.hasWidgetTargetContext/,
    )
  })

  it('keeps tool guidance scoped to the current run instead of mutating the session prompt', () => {
    const directChatSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    const turnEngineSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'),
      'utf8',
    )

    assert.doesNotMatch(
      directChatSource,
      /session\.systemPrompt\s*=\s*`\$\{session\.systemPrompt\}\\n\\n\$\{toolGuidance\}`/,
    )
    assert.doesNotMatch(
      turnEngineSource,
      /session\.systemPrompt\s*=\s*`\$\{session\.systemPrompt\}\\n\\n\$\{toolGuidance\}`/,
    )
    assert.match(
      turnEngineSource,
      /const toolLoopSession = toolGuidance\s*\?\s*\{\s*\.\.\.session,\s*systemPrompt:\s*`\$\{session\.systemPrompt\}\\n\\n\$\{toolGuidance\}`,\s*\}\s*:\s*session/,
    )
  })
})
