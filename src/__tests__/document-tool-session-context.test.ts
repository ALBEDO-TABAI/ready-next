import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('document tool session context', () => {
  it('persists the last resolved document context input on the chat session', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )

    assert.match(source, /lastDocumentContextInput\?: string \| null/)
    assert.match(source, /lastDocumentContextInput:\s*session\.lastDocumentContextInput/)
    assert.match(source, /session\.lastDocumentContextInput = contextualUserInput/)
  })

  it('keeps tool guidance scoped to the current run instead of mutating the session prompt', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )

    assert.doesNotMatch(
      source,
      /session\.systemPrompt\s*=\s*`\$\{session\.systemPrompt\}\\n\\n\$\{toolGuidance\}`/,
    )
    assert.match(
      source,
      /const toolLoopSession = toolGuidance\s*\?\s*\{\s*\.\.\.session,\s*systemPrompt:\s*`\$\{session\.systemPrompt\}\\n\\n\$\{toolGuidance\}`,\s*\}\s*:\s*session/,
    )
  })
})
