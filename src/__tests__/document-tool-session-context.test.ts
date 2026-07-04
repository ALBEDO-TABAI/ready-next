import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('document tool session context', () => {
  it('persists the last resolved document context input on the chat session', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: session state ownership spans DirectChat and TurnEngine with no stable behavior harness
    const directChatSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    assert.match(directChatSource, /lastDocumentContextInput\?: string \| null/)
  })

  it('keeps tool guidance scoped to the current run instead of mutating the session prompt', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: DirectChat session prompt must not be mutated before TurnEngine receives it
    const directChatSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    assert.doesNotMatch(
      directChatSource,
      /session\.systemPrompt\s*=\s*`\$\{session\.systemPrompt\}\\n\\n\$\{toolGuidance\}`/,
    )
  })
})
